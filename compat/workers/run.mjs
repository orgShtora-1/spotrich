import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const bundle = await build({
  entryPoints: ['entry.mjs'], bundle: true, write: false, format: 'esm',
  platform: 'browser', target: 'es2022', metafile: true,
});
const inputs = Object.keys(bundle.metafile.inputs);
assert(inputs.some((path) => path.replaceAll('\\', '/').includes('node_modules/@shtora/spotrich/dist/index.js')),
  'Worker must bundle the installed npm artifact.');
let outboundRequests = 0;
const runtime = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-07-30', compatibilityFlags: [],
  host: '127.0.0.1', port: 0,
  outboundService: () => {
    outboundRequests += 1;
    throw new Error('Unexpected external request in the workerd fixture.');
  },
});
try {
  const response = await runtime.dispatchFetch('https://fixture.example/api/now-playing');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.nodeGlobals, false);
  assert.deepEqual(result.requestCounts, { playback: 3, token: 2 });
  assert.equal(outboundRequests, 0);
  process.stdout.write('PASS: actual local workerd runtime; no nodejs_compat; installed tarball; zero external requests. Not a deployment.\n');
} finally { await runtime.dispose(); }
