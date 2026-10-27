import assert from 'node:assert/strict';
import { EdgeVM } from '@edge-runtime/vm';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['entry.mjs'], bundle: true, write: false, format: 'iife',
  platform: 'browser', target: 'es2022', metafile: true,
});
assert(Object.keys(bundle.metafile.inputs).some((path) => path.replaceAll('\\', '/').includes('node_modules/@shtora/spotrich/dist/index.js')),
  'EdgeVM must bundle the installed npm artifact.');
let outboundRequests = 0;
const runtime = new EdgeVM({
  // Default string code generation remains disabled for evaluated SDK code.
  extend(context) {
    context.fetch = async () => {
      outboundRequests += 1;
      throw new Error('Unexpected external request in the EdgeVM fixture.');
    };
    return context;
  },
});
runtime.evaluate(bundle.outputFiles[0].text);
const response = await runtime.dispatchFetch('https://fixture.example/api/now-playing');
await response.waitUntil();
assert.equal(response.status, 200);
const result = await response.json();
assert.equal(result.ok, true);
assert.equal(result.nodeGlobals, false);
assert.deepEqual(result.requestCounts, { playback: 3, token: 2 });
assert.equal(outboundRequests, 0);
process.stdout.write('PASS: official @edge-runtime/vm local emulation; installed tarball; zero external requests. NOT Vercel deployment/isolate evidence.\n');
