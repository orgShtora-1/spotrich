import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { packArtifact } from './lib/artifact.mjs';
import { isMain, isolatedEnv, root, runNode, runNpm, startNode, stopChild, temporaryDirectory } from './lib/host.mjs';

const requiredTargets = ['workers', 'next', 'vercel'];
const knownTargets = new Set([...requiredTargets, 'next-edge']);
const guide = `Compatibility checks are explicit, isolated, local runtime tests; nothing is deployed.
Build first: bun run build
Install locked fixture tooling with lifecycle scripts DISABLED and run all required targets:
  node scripts/compat.mjs --install --all
Or select required targets explicitly:
  node scripts/compat.mjs --install workers next vercel
Deprecated Next Edge experiment (not part of --all):
  node scripts/compat.mjs --install next-edge
--keep retains the allocated temp consumers for diagnosis. See compat/README.md.
No target/tool is silently skipped. Without --install no dependency installation is authorized.
`;

async function copyFixture(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['node_modules', '.next', '.wrangler'].includes(entry.name) || entry.name.endsWith('.tgz')) continue;
    if (entry.isSymbolicLink()) throw new Error('Refusing a symlinked compatibility fixture.');
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyFixture(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error('Unsupported compatibility fixture entry.');
  }
}

async function prepareFixture(target, directory, artifact, env) {
  const template = target === 'next-edge' ? 'next' : target;
  await copyFixture(join(root, 'compat', template), directory);
  await copyFile(join(root, 'compat/shared/smoke.mjs'), join(directory, 'smoke.mjs'));
  await copyFile(artifact.path, join(directory, 'spotrich.tgz'));
  let lock;
  try { lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${template}: committed fixture lockfile is missing; tooling cannot be reproducibly installed.`);
    throw error;
  }
  const localPackage = lock.packages?.['node_modules/@shtora/spotrich'];
  assert.equal(lock.lockfileVersion, 3, `${template}: expected npm lockfile v3`);
  assert(localPackage && /^file:(?:\.\/)?spotrich\.tgz$/.test(localPackage.resolved), `${template}: lockfile must consume the local artifact`);
  assert.equal(localPackage.version, artifact.manifest.version, `${template}: refresh the fixture's package version binding before testing a new SDK version`);
  // Only the artifact hash changes in the TEMP copy. All tooling versions and
  // transitive integrity pins remain exactly as committed; no lockfile resolution.
  localPackage.integrity = artifact.integrity;
  await writeFile(join(directory, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  if (target === 'next-edge') {
    await mkdir(join(directory, 'app/api/edge'), { recursive: true });
    await copyFile(join(directory, 'edge-route.js'), join(directory, 'app/api/edge/route.js'));
  }
  runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, env, timeout: 300_000 });
  const installed = JSON.parse(await readFile(join(directory, 'node_modules/@shtora/spotrich/package.json'), 'utf8'));
  assert.equal(installed.version, artifact.manifest.version);
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}

async function runNext(directory, env, deprecatedEdge) {
  const cli = join(directory, 'node_modules/next/dist/bin/next');
  const platform = process.platform;
  const arch = process.arch;
  const abi = platform === 'win32' ? '-msvc'
    : platform === 'linux' ? process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl' : '';
  const nativePackage = `@next/swc-${platform}-${arch}${abi}`;
  try {
    // Fail before Next's optional WASM-download fallback if npm omitted a binary
    // or this OS/architecture is unsupported. No install scripts are enabled.
    // Keep the native addon out of this harness process: on Windows a loaded
    // .node DLL stays locked until its process exits and prevents temp cleanup.
    runNode(['--input-type=module', '-e',
      "import { createRequire } from 'node:module'; import { resolve } from 'node:path'; createRequire(resolve('package.json'))(process.argv[1]);",
      nativePackage], { cwd: directory, env, capture: true, timeout: 15_000 });
  } catch {
    throw new Error(`Next native tooling is unavailable: ${nativePackage}. Install the locked optional platform dependencies with scripts disabled; no fallback download is authorized.`);
  }
  // Webpack is explicitly selected; the native SWC binding was loaded above.
  runNode([cli, 'build', '--webpack'], { cwd: directory, env, timeout: 300_000 });
  const port = await freePort();
  const server = startNode([cli, 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: directory, env });
  let output = '';
  let startupError;
  server.once('error', (error) => { startupError = error; });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { output = (output + chunk).slice(-128 * 1024); });
  }
  try {
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('next start exited before readiness.');
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
        await response.text();
        if (response.ok) { ready = true; break; }
      } catch { /* Only readiness connection failures are retried; test responses are not. */ }
      await sleep(100);
    }
    assert(ready, 'next start readiness timed out.');
    for (const path of ['/api/now-playing', ...(deprecatedEdge ? ['/api/edge'] : [])]) {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 200, `${path}: Next request status`);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.deepEqual(result.requestCounts, { playback: 3, token: 2 });
    }
    process.stdout.write(`PASS: Next production build + start + App Router request${deprecatedEdge ? ' + DEPRECATED edge route experiment' : ''}; installed tarball; mocked Spotify. Not a deployment.\n`);
  } catch (error) {
    process.stderr.write(output);
    throw error;
  } finally { await stopChild(server); }
}

export async function compat(targets, { install = false, keep = false } = {}) {
  assert(targets.length > 0 && targets.every((target) => knownTargets.has(target)), 'Explicit known compatibility targets are required.');
  if (!install) throw new Error(`Fixture tooling is not installed by this command without explicit permission.\n${guide}`);
  const temporary = await temporaryDirectory('compat');
  try {
    const artifact = await packArtifact(temporary.directory);
    const env = isolatedEnv(temporary.directory);
    for (const target of [...new Set(targets)]) {
      process.stdout.write(`\nCompatibility target: ${target}${target === 'next-edge' ? ' (DEPRECATED, optional)' : ''}\n`);
      const directory = join(temporary.directory, target);
      await prepareFixture(target, directory, artifact, env);
      if (target === 'next' || target === 'next-edge') await runNext(directory, env, target === 'next-edge');
      else runNode(['run.mjs'], { cwd: directory, env, timeout: 120_000 });
    }
  } finally {
    if (keep) process.stdout.write(`Retained isolated fixture consumers: ${temporary.directory}\n`);
    else await temporary.cleanup();
  }
}

if (isMain(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--help')) process.stdout.write(guide);
  else if (arguments_.length === 0) { process.stderr.write(`NOT RUN: no compatibility targets selected.\n${guide}`); process.exitCode = 2; }
  else {
    try {
      const flags = new Set(['--all', '--install', '--keep']);
      const invalid = arguments_.filter((value) => !flags.has(value) && !knownTargets.has(value));
      assert.equal(invalid.length, 0, `Unknown arguments: ${invalid.join(', ')}`);
      const targets = [...(arguments_.includes('--all') ? requiredTargets : []), ...arguments_.filter((value) => knownTargets.has(value))];
      await compat(targets, { install: arguments_.includes('--install'), keep: arguments_.includes('--keep') });
    } catch (error) {
      process.stderr.write(`compat: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
