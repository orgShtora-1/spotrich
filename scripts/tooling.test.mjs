import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { scanCore } from './check.mjs';
import { cleanGeneratedDist } from './clean.mjs';
import { inspectTarball } from './lib/artifact.mjs';
import { temporaryDirectory } from './lib/host.mjs';

test('core policy allows lazy Web Standards work and inert lookup constants', () => {
  const source = `
    import type { Clock } from './types.js';
    const clock: Clock = { now: () => Date.now(), monotonic: () => globalThis.performance.now() };
    const lookup = Object.freeze(['track']);
    const names = new Set(['track', 'episode']);
    export function read() { return fetch('https://api.spotify.com/v1/me/player'); }
    export type Result = { value: string };
    export class Example extends Error { readonly code = 'CONFIG'; }
  `;
  assert.deepEqual(scanCore(source), []);
});

for (const source of [
  `import fs from 'node:fs';`,
  `import fs from 'fs';`,
  `export { readFile } from 'node:fs';`,
  `import fs from 'node\\x3afs';`,
  `export function bad() { return import('node:fs'); }`,
  `export function bad() { console['log']('private'); }`,
  `export function bad() { return globalThis['eval']('private'); }`,
  `export function bad() { return globalThis['ev' + 'al']('private'); }`,
  `export function bad() { return new Function('return 1'); }`,
  `const credential = { refreshToken: 'real-looking-secret' };`,
  `const cache = new Map();`,
  `const timer = setTimeout(() => {}, 1000);`,
  `const value = Object.freeze(fetch('https://example.com'));`,
  `const value: () => void = sideEffect();`,
  'const value = `prefix ${fetch("https://example.com")}`;',
  `const value = (() => fetch('https://example.com'))();`,
  `fetch('https://example.com');`,
  `class Bad { static value = fetch('https://example.com'); }`,
]) {
  test(`core policy rejects ${source.slice(0, 65)}`, () => assert(scanCore(source).length > 0));
}

test('core policy ignores comments and ordinary regex/string contents', () => {
  assert.deepEqual(scanCore(`
    // console.log and import fs from 'node:fs' are not executable here.
    const message = 'no eval or process access';
    const regex = /[{}]console\\.log/;
    export function lazy() { return /[\\s{}]/.test(message); }
  `), []);
});

test('clean preserves the entire output if an unknown user file is present', async () => {
  const temporary = await temporaryDirectory('clean-test');
  try {
    await mkdir(join(temporary.directory, 'src'));
    await mkdir(join(temporary.directory, 'dist'));
    await writeFile(join(temporary.directory, 'src/index.ts'), 'export {};');
    await writeFile(join(temporary.directory, 'dist/index.js'), 'export {};');
    await writeFile(join(temporary.directory, 'dist/notes.txt'), 'user work');
    await assert.rejects(cleanGeneratedDist(temporary.directory), /Unknown file/);
    assert.equal(await readFile(join(temporary.directory, 'dist/index.js'), 'utf8'), 'export {};');
    assert.equal(await readFile(join(temporary.directory, 'dist/notes.txt'), 'utf8'), 'user work');
  } finally { await temporary.cleanup(); }
});

test('clean removes only the matching generated dist, not src or sibling output', async () => {
  const temporary = await temporaryDirectory('clean-test');
  try {
    await mkdir(join(temporary.directory, 'src'));
    await mkdir(join(temporary.directory, 'dist'));
    await writeFile(join(temporary.directory, 'src/index.ts'), 'export {};');
    await writeFile(join(temporary.directory, 'dist/index.js'), 'export {};');
    await writeFile(join(temporary.directory, 'dist/index.d.ts'), 'export {};');
    await writeFile(join(temporary.directory, 'keep.txt'), 'user work');
    assert.equal(await cleanGeneratedDist(temporary.directory), true);
    assert.equal(await cleanGeneratedDist(temporary.directory), false);
    assert.equal(await readFile(join(temporary.directory, 'src/index.ts'), 'utf8'), 'export {};');
    assert.equal(await readFile(join(temporary.directory, 'keep.txt'), 'utf8'), 'user work');
  } finally { await temporary.cleanup(); }
});

test('clean refuses a symlink/junction dist without following it', async () => {
  const temporary = await temporaryDirectory('clean-test');
  try {
    await mkdir(join(temporary.directory, 'src'));
    await mkdir(join(temporary.directory, 'user-output'));
    await writeFile(join(temporary.directory, 'src/index.ts'), 'export {};');
    await writeFile(join(temporary.directory, 'user-output/index.js'), 'user work');
    await symlink(join(temporary.directory, 'user-output'), join(temporary.directory, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(cleanGeneratedDist(temporary.directory), /symlinked dist/);
    assert.equal(await readFile(join(temporary.directory, 'user-output/index.js'), 'utf8'), 'user work');
  } finally { await temporary.cleanup(); }
});

function fixtureFiles() {
  return new Map([
    ['package.json', JSON.stringify({
      name: '@shtora/spotrich', version: '0.1.0', type: 'module', sideEffects: false,
      main: './dist/index.js', types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js', default: './dist/index.js' },
        './oauth': { types: './dist/oauth.d.ts', import: './dist/oauth.js', default: './dist/oauth.js' },
        './http': { types: './dist/http.d.ts', import: './dist/http.js', default: './dist/http.js' },
        './package.json': './package.json',
      },
    })],
    ['README.md', 'public usage'], ['LICENSE', 'MIT'],
    ['dist/index.js', "export { createSpotifyClient } from './client.js';"],
    ['dist/client.js', 'export function createSpotifyClient() {}'],
    ['dist/index.d.ts', 'export {};'],
    ['dist/oauth.js', 'export function createSpotifyOAuth() {}'],
    ['dist/oauth.d.ts', 'export {};'],
    ['dist/http.js', 'export function createNowPlayingHandler() {}'],
    ['dist/http.d.ts', 'export {};'],
  ]);
}

function tarball(files, { type = '0', unsafeName } = {}) {
  const blocks = [];
  for (const [name, text] of files) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(unsafeName ?? `package/${name}`, 0, 100);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write('ustar\0', 257, 6);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('tar inspection validates a public dependency-free package and import graph', () => {
  const inspected = inspectTarball(tarball(fixtureFiles()));
  assert.equal(inspected.files.size, 10);
  assert.equal(inspected.manifest.name, '@shtora/spotrich');
  assert(inspected.integrity.startsWith('sha512-'));
});

test('tar inspection rejects junk, links, path traversal, secrets and a root OAuth dependency', () => {
  const junk = fixtureFiles();
  junk.set('.env', 'private');
  assert.throws(() => inspectTarball(tarball(junk)), /Non-public file/);
  assert.throws(() => inspectTarball(tarball(fixtureFiles(), { type: '2' })), /entry type/);
  assert.throws(() => inspectTarball(tarball(fixtureFiles(), { unsafeName: 'package/../private' })), /Unsafe package entry path/);
  const secret = fixtureFiles();
  secret.set('README.md', '-----BEGIN PRIVATE KEY-----');
  assert.throws(() => inspectTarball(tarball(secret)), /Possible secret/);
  const oauth = fixtureFiles();
  oauth.set('dist/client.js', "import { createSpotifyOAuth } from './oauth.js';");
  assert.throws(() => inspectTarball(tarball(oauth)), /transitively imports OAuth/);
});

test('tar inspection rejects runtime dependencies, install hooks and absent declarations', () => {
  const dependencies = fixtureFiles();
  const manifest = JSON.parse(dependencies.get('package.json'));
  manifest.dependencies = { unnecessary: '1.0.0' };
  dependencies.set('package.json', JSON.stringify(manifest));
  assert.throws(() => inspectTarball(tarball(dependencies)), /runtime dependency/);
  delete manifest.dependencies;
  manifest.scripts = { postinstall: 'node untrusted.js' };
  dependencies.set('package.json', JSON.stringify(manifest));
  assert.throws(() => inspectTarball(tarball(dependencies)), /install lifecycle/);
  const missingTypes = fixtureFiles();
  missingTypes.delete('dist/http.d.ts');
  assert.throws(() => inspectTarball(tarball(missingTypes)), /Missing public artifact/);
});

test('tar inspection includes public examples but rejects absent documentation targets and real env files', () => {
  const files = fixtureFiles();
  files.set('README.md', '[Example](examples/usage.mjs) · [Configuration](.env.example)');
  files.set('examples/usage.mjs', 'export {};');
  files.set('examples/smoke.test.mjs', 'export {};');
  files.set('.env.example', 'SPOTIFY_CLIENT_ID=replace_with_registered_client_id');
  assert(inspectTarball(tarball(files)).files.has('examples/usage.mjs'));
  assert(inspectTarball(tarball(files)).files.has('examples/smoke.test.mjs'));
  files.set('.env.production', 'private');
  assert.throws(() => inspectTarball(tarball(files)), /Non-public file/);
  files.delete('.env.production');
  files.delete('examples/usage.mjs');
  assert.throws(() => inspectTarball(tarball(files)), /Broken packaged documentation link/);
});
