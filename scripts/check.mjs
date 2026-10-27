import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isMain, root, runNode } from './lib/host.mjs';

// A deliberately conservative policy scanner, not a TypeScript parser or a
// substitute for tsc/security review. No linter/parser/runtime dependencies.
const regexStarts = new Set(['(', '[', '{', '=', ':', ',', ';', '!', '?', '&&', '||', '??', '=>', 'return', 'case']);

function decodeString(raw) {
  return raw.slice(1, -1).replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([^]))/gi,
    (_match, wide, unicode, hex, character) => {
      if (wide || unicode || hex) return String.fromCodePoint(Number.parseInt(wide || unicode || hex, 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[character] ?? character;
    });
}

function tokenize(source) {
  const tokens = [];
  let cursor = 0;
  function push(kind, value, start) { tokens.push({ kind, value, start }); }
  function segment(templateExpression = false) {
    let depth = 0;
    while (cursor < source.length) {
      const start = cursor;
      const char = source[cursor];
      if (/\s/.test(char)) { cursor += 1; continue; }
      if (source.startsWith('//', cursor)) {
        while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
        continue;
      }
      if (source.startsWith('/*', cursor)) {
        const end = source.indexOf('*/', cursor + 2);
        if (end < 0) throw new Error('Unterminated comment.');
        cursor = end + 2;
        continue;
      }
      if (char === '"' || char === "'") {
        cursor += 1;
        while (cursor < source.length && source[cursor] !== char) {
          cursor += source[cursor] === '\\' ? 2 : 1;
        }
        if (source[cursor] !== char) throw new Error('Unterminated string.');
        cursor += 1;
        push('string', decodeString(source.slice(start, cursor)), start);
        continue;
      }
      if (char === '`') {
        cursor += 1;
        push('template', '', start);
        while (cursor < source.length && source[cursor] !== '`') {
          if (source[cursor] === '\\') { cursor += 2; continue; }
          if (source.startsWith('${', cursor)) {
            push('punctuation', '(', cursor);
            cursor += 2;
            segment(true);
            push('punctuation', ')', cursor - 1);
          } else cursor += 1;
        }
        if (source[cursor] !== '`') throw new Error('Unterminated template.');
        cursor += 1;
        continue;
      }
      if (char === '/' && regexStarts.has(tokens.at(-1)?.value)) {
        cursor += 1;
        let inClass = false;
        while (cursor < source.length) {
          const next = source[cursor++];
          if (next === '\\') { cursor += 1; continue; }
          if (next === '[') inClass = true;
          if (next === ']') inClass = false;
          if (next === '/' && !inClass) break;
        }
        while (/[a-z]/i.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
        push('regex', source.slice(start, cursor), start);
        continue;
      }
      if (/[a-z_$]/i.test(char)) {
        cursor += 1;
        while (/[\w$]/.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
        push('identifier', source.slice(start, cursor), start);
        continue;
      }
      if (/\d/.test(char)) {
        cursor += 1;
        while (/[\w.]/.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
        push('number', source.slice(start, cursor), start);
        continue;
      }
      if (templateExpression && char === '}' && depth === 0) { cursor += 1; return; }
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      const operator = ['===', '!==', '=>', '?.', '&&', '||', '??', '==', '!=', '++', '--', '**', '...'].find((op) => source.startsWith(op, cursor));
      const value = operator ?? char;
      cursor += value.length;
      push('punctuation', value, start);
    }
    if (templateExpression) throw new Error('Unterminated template expression.');
  }
  segment();
  return tokens;
}

function pairsFor(tokens) {
  const pairs = new Map();
  const stack = [];
  for (const [index, token] of tokens.entries()) {
    if (['(', '[', '{'].includes(token.value) && token.kind === 'punctuation') stack.push(index);
    if ([')', ']', '}'].includes(token.value) && token.kind === 'punctuation') {
      const open = stack.pop();
      if (open === undefined || '([{'.indexOf(tokens[open].value) !== ')]}'.indexOf(token.value)) {
        throw new Error('Unbalanced delimiters; run the typechecker.');
      }
      pairs.set(open, index);
    }
  }
  if (stack.length) throw new Error('Unbalanced delimiters; run the typechecker.');
  return pairs;
}

function lazyEnd(tokens, index, pairs) {
  if (tokens[index]?.value === '{') return pairs.get(index) + 1;
  let end = index;
  while (end < tokens.length && ![',', ';', ')', '}', ']'].includes(tokens[end].value)) {
    if (pairs.has(end)) end = pairs.get(end) + 1;
    else end += 1;
  }
  return end;
}

export function scanCore(source, filename = join(root, 'src/policy-fixture.ts')) {
  const problems = [];
  const report = (token, message) => {
    const line = source.slice(0, token?.start ?? 0).split('\n').length;
    problems.push({ line, message });
  };
  let tokens;
  let pairs;
  try { tokens = tokenize(source); pairs = pairsFor(tokens); } catch (error) {
    return [{ line: 1, message: error.message }];
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token.kind === 'identifier' && ['eval', 'Function', 'require', 'console', 'debugger', 'process', 'Buffer', '__dirname', '__filename', 'Bun', 'Deno'].includes(token.value)) {
      report(token, `Forbidden core capability: ${token.value}.`);
    }
    if (token.kind === 'punctuation' && (token.value === '\\' || token.value === '@')) report(token, 'Escaped identifiers and decorators require explicit policy review.');
    if (token.kind === 'string' && ['eval', 'Function', 'console', 'process', 'Buffer'].includes(token.value)
      && tokens[index - 1]?.value === '[') report(token, 'Computed access to a forbidden core capability.');
    if (token.kind === 'identifier' && ['globalThis', 'self', 'window'].includes(token.value) && next?.value === '[') {
      report(token, 'Computed global access requires explicit capability review.');
    }
    if (/^(?:accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret)$/i.test(token.value)
      && [':', '='].includes(next?.value) && tokens[index + 2]?.kind === 'string' && tokens[index + 2].value.length > 0) {
      report(token, 'Hard-coded credential literal in core.');
    }
    if (token.kind === 'string' && /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\beyJ[A-Za-z0-9_-]{16,}\.eyJ)/.test(token.value)) {
      report(token, 'Possible credential/private key; value withheld.');
    }
    if (token.value !== 'import' && token.value !== 'export') continue;
    if (token.value === 'import' && next?.value === '(') {
      report(token, 'Dynamic imports are forbidden in the dependency-free core.');
      continue;
    }
    let specifier = token.value === 'import' && next?.kind === 'string' ? next : undefined;
    for (let position = index + 1; position < tokens.length && tokens[position].value !== ';'; position += 1) {
      if (tokens[position].value === 'from' && tokens[position + 1]?.kind === 'string') {
        specifier = tokens[position + 1]; break;
      }
      if (tokens[position].value === 'function' || tokens[position].value === 'class') break;
    }
    if (specifier) {
      const name = specifier.value;
      const location = resolve(dirname(filename), name);
      const sourceRoot = join(root, 'src');
      if (!/^\.\.?\//.test(name) || !name.endsWith('.js') || name.includes('\\')
        || name.includes('\0') || !location.startsWith(`${sourceRoot}${sep}`)) {
        report(specifier, 'Core imports must be explicit relative .js modules within src (no Node, remote, or runtime dependencies).');
      }
    }
  }

  // Only declarations and a small set of inert constant initializers are allowed
  // at module scope. Function/arrow bodies remain lazy; their capabilities above
  // are still checked. Import probes separately trap actual timers/network I/O.
  let index = 0;
  while (index < tokens.length) {
    if (tokens[index].value === ';') { index += 1; continue; }
    const start = index;
    if (tokens[index].value === 'export') index += 1;
    if (tokens[index]?.value === 'default') index += 1;
    if (tokens[index]?.value === 'async') index += 1;
    const kind = tokens[index]?.value;
    if (['function', 'class', 'interface'].includes(kind)) {
      let body = index + 1;
      while (body < tokens.length && tokens[body].value !== '{') {
        if (kind === 'class' && tokens[body].value === '(') report(tokens[body], 'Executable class heritage at import time.');
        // Skip parameter/default-expression braces before the declaration body.
        if (tokens[body].value === '(' && pairs.has(body)) body = pairs.get(body) + 1;
        else body += 1;
      }
      if (!pairs.has(body)) { report(tokens[start], 'Unrecognized module declaration.'); break; }
      if (kind === 'class') {
        for (let member = body + 1; member < pairs.get(body); member += 1) {
          if (tokens[member].kind === 'identifier' && tokens[member].value === 'static') report(tokens[member], 'Static class members require import-effect review.');
        }
      }
      index = pairs.get(body) + 1;
      continue;
    }
    let end = index;
    while (end < tokens.length && tokens[end].value !== ';') {
      if (pairs.has(end)) end = pairs.get(end) + 1;
      else end += 1;
    }
    if (kind === 'import' || kind === 'type' || tokens[index]?.value === '{' || tokens[index]?.value === '*') {
      index = end + 1;
      continue;
    }
    if (kind !== 'const') {
      report(tokens[start], 'Only inert const/type/function/class declarations are allowed at module scope.');
      index = Math.max(end + 1, start + 1);
      continue;
    }
    if (end === tokens.length) report(tokens[start], 'Module constants must end with a semicolon.');
    let inInitializer = false;
    for (let position = index + 1; position < end; position += 1) {
      const token = tokens[position];
      if (token.value === '=') inInitializer = true;
      if (token.value === '=>' && inInitializer) { position = lazyEnd(tokens, position + 1, pairs) - 1; continue; }
      if (token.value === 'function') {
        let body = position + 1;
        while (body < end && tokens[body].value !== '{') body += 1;
        position = pairs.get(body) ?? end;
        continue;
      }
      if (token.value === 'new' && tokens[position + 1]?.value !== 'Set') report(token, 'Only literal lookup Sets may be constructed at module scope (no credential caches/transports).');
      if (token.value === 'await' || token.value === '++' || token.value === '--') report(token, 'Import-time execution or mutation.');
      if ([')', ']'].includes(token.value) && tokens[position + 1]?.value === '(') {
        report(token, 'Invoked expression or computed call at import time.');
      }
      if (token.kind === 'identifier' && tokens[position + 1]?.value === '<') {
        let genericEnd = position + 2;
        while (genericEnd < end && !['>', ';', '='].includes(tokens[genericEnd].value)) genericEnd += 1;
        if (tokens[genericEnd]?.value === '>' && tokens[genericEnd + 1]?.value === '('
          && !(token.value === 'Set' && tokens[position - 1]?.value === 'new')) {
          report(token, 'Generic call in an import-time initializer.');
        }
      }
      if (tokens[position + 1]?.value === '(' && token.kind === 'identifier') {
        const objectFreeze = token.value === 'freeze' && tokens[position - 1]?.value === '.' && tokens[position - 2]?.value === 'Object';
        const lookupSet = token.value === 'Set' && tokens[position - 1]?.value === 'new';
        if (!objectFreeze && !lookupSet) report(token, 'Call in an import-time initializer; move execution inside an explicit function.');
      }
    }
    index = end + 1;
  }
  return problems;
}

async function filesUnder(directory, extensions) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Policy scan refuses a symlink: ${relative(root, join(directory, entry.name))}`);
    if (['node_modules', '.next', '.wrangler', 'dist', '.git'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(path);
  }
  return files.sort();
}

export async function check({ syntax = true } = {}) {
  const core = await filesUnder(join(root, 'src'), ['.ts']);
  const failures = [];
  for (const filename of core) {
    for (const problem of scanCore(await readFile(filename, 'utf8'), filename)) {
      failures.push(`${relative(root, filename)}:${problem.line}: ${problem.message}`);
    }
  }
  if (failures.length) throw new Error(`Core policy failed:\n${failures.join('\n')}`);
  let scripts = [];
  if (syntax) {
    for (const directory of ['scripts', 'tests', 'benchmarks', 'compat']) {
      try { scripts.push(...await filesUnder(join(root, directory), ['.mjs', '.cjs', '.js'])); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    for (const script of scripts) runNode(['--check', script], { capture: true });
  }
  process.stdout.write(`Core policy: ${core.length} TypeScript files; JS syntax: ${syntax ? `${scripts.length} files` : 'not requested'}.\n`);
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== '--no-syntax')) throw new Error('Usage: node scripts/check.mjs [--no-syntax]');
    await check({ syntax: !process.argv.includes('--no-syntax') });
  } catch (error) {
    process.stderr.write(`check: ${error.message}\n`);
    process.exitCode = 1;
  }
}
