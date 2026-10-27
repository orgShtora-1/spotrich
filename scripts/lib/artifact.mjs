import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { posix, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isolatedEnv, root, runNpm } from './host.mjs';

function field(block, start, length) {
  return block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

export function inspectTarball(compressed) {
  assert(compressed.length <= 2 * 1024 * 1024, 'Unexpectedly large package (over 2 MiB compressed).');
  const tar = gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const checksum = Number.parseInt(field(header, 148, 8).trim(), 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
    assert.equal(actualChecksum, checksum, 'Invalid tar header checksum.');
    const prefix = field(header, 345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${field(header, 0, 100)}`;
    const sizeText = field(header, 124, 12).trim();
    assert(/^[0-7]+$/.test(sizeText), 'Unsupported tar entry size.');
    const size = Number.parseInt(sizeText, 8);
    const type = field(header, 156, 1);
    assert(name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..')
      && posix.normalize(name.replace(/\/$/, '')) === name.replace(/\/$/, ''), 'Unsafe package entry path.');
    assert(offset + 512 + size <= tar.length, 'Truncated package tar entry.');
    if (type === '5') { offset += 512; continue; }
    // npm pack does not need symlinks, devices, long-path/PAX overrides, or hardlinks here.
    assert(type === '' || type === '0', 'Unsupported tar entry type; links and metadata overrides are forbidden.');
    const path = name.slice('package/'.length);
    assert(!files.has(path), 'Duplicate package entry.');
    assert(/^(?:package\.json|README\.md|LICENSE|CHANGELOG\.md|SECURITY\.md|CONTRIBUTING\.md|\.env\.example|examples\/smoke\.test\.mjs|examples\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:md|mjs)|dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.js|\.d\.ts))$/.test(path),
      `Non-public file in package: ${path}`);
    assert(!/(?:^|\/)(?:secrets?|credentials?|private(?:[-_.]|$)|debug(?:[-_.]|$))/i.test(path), `Private/debug file in package: ${path}`);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const text = body.toString('utf8');
    assert(!text.includes('\0'), `Binary/unexpected content in package: ${path}`);
    assert(!/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk_live_[A-Za-z0-9]{16,}|\beyJ[A-Za-z0-9_-]{16,}\.eyJ)/.test(text),
      `Possible secret in package (value withheld): ${path}`);
    files.set(path, text);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts', 'dist/oauth.js', 'dist/oauth.d.ts', 'dist/http.js', 'dist/http.d.ts']) {
    assert(files.get(required)?.trim(), `Missing public artifact: ${required}. Run the build first.`);
  }
  const manifest = JSON.parse(files.get('package.json'));
  assert.equal(manifest.name, '@shtora/spotrich');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.sideEffects, false);
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(Object.keys(manifest[key] ?? {}).length, 0, `Unexpected runtime dependency surface: ${key}`);
  }
  assert.equal((manifest.bundledDependencies ?? manifest.bundleDependencies ?? []).length, 0, 'Bundled dependencies are forbidden.');
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert(!manifest.scripts?.[lifecycle], `Consumer install lifecycle is forbidden: ${lifecycle}`);
  }
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './http', './oauth', './package.json']);
  for (const subpath of ['.', './oauth', './http']) {
    const entry = manifest.exports[subpath];
    assert.equal(typeof entry, 'object', `Missing typed export: ${subpath}`);
    for (const condition of ['types', 'import', 'default']) {
      assert(typeof entry[condition] === 'string' && entry[condition].startsWith('./dist/'), `Invalid ${subpath}/${condition} export.`);
      assert(files.has(entry[condition].slice(2)), `Export target missing: ${subpath}/${condition}`);
    }
  }
  assert.equal(manifest.exports['./package.json'], './package.json');
  assert.equal(manifest.main, manifest.exports['.'].import);
  assert.equal(manifest.types, manifest.exports['.'].types);
  assertNoOAuthFromRoot(files, manifest.exports['.'].import.slice(2));
  for (const [path, text] of files) {
    if (!path.endsWith('.md')) continue;
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const link = match[1].split('#')[0];
      if (!link || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(link)));
      assert(files.has(target), `Broken packaged documentation link: ${path} -> ${link}`);
    }
  }
  return { files, manifest, integrity: `sha512-${createHash('sha512').update(compressed).digest('base64')}` };
}

function assertNoOAuthFromRoot(files, rootEntry) {
  const visited = new Set();
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    assert(!/(?:^|\/)oauth\.js$/.test(path), 'Root transitively imports OAuth.');
    const source = files.get(path);
    assert(source !== undefined, `Unpacked root import is missing: ${path}`);
    // Match import/export ... from '...' across multiple lines. The [\s\S]*? allows newlines
    // before the 'from' keyword (multiline imports). We also match bare 'from' after
    // 'import' or 'export' for re-exports: export { foo } from './bar.js';
    const imports = /(?:^|[;\n])\s*(?:import\s+[\s\S]*?from\s+|export\s+[\s\S]*?from\s+)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const specifier = match[1];
      assert(/^\.\.?\//.test(specifier) && specifier.endsWith('.js'), 'Packed root has a non-local dependency.');
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      assert(target.startsWith('dist/'), 'Packed root import escapes dist.');
      visit(target);
    }
    assert(!/\bimport\s*\(/.test(source), 'Dynamic import in packed root graph.');
  }
  visit(rootEntry);
}

export async function packArtifact(destination) {
  const result = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: root, env: isolatedEnv(destination), capture: true,
  }));
  assert(Array.isArray(result) && result.length === 1 && typeof result[0].filename === 'string', 'npm pack returned no single artifact.');
  assert(!/[\\/]/.test(result[0].filename), 'npm pack returned an unsafe filename.');
  const path = join(destination, result[0].filename);
  const compressed = await readFile(path);
  const inspected = inspectTarball(compressed);
  const expectedOutput = [];
  async function sourceOutputs(directory, prefix = 'dist/') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Package build input must not be a symlink.');
      if (entry.isDirectory()) await sourceOutputs(join(directory, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const stem = `${prefix}${entry.name.slice(0, -3)}`;
        expectedOutput.push(`${stem}.js`, `${stem}.d.ts`);
      }
    }
  }
  await sourceOutputs(join(root, 'src'));
  assert.deepEqual([...inspected.files.keys()].filter((name) => name.startsWith('dist/')).sort(), expectedOutput.sort(),
    'Packed dist is stale, incomplete, or contains output not owned by current src.');
  assert.equal(inspected.integrity, result[0].integrity, 'npm pack integrity does not match the inspected tarball.');
  const reported = result[0].files.map((entry) => entry.path).sort();
  assert.deepEqual([...inspected.files.keys()].sort(), reported, 'Tar entries differ from the npm pack manifest.');
  return { ...inspected, path, compressedBytes: compressed.length };
}
