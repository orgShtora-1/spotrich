import assert from 'node:assert/strict';

// This file is COPIED into an isolated npm consumer. All package imports resolve
// through the installed tarball's exports, never the source checkout.
const original = new Map();
const effects = [];
for (const name of ['fetch', 'setTimeout', 'setInterval', 'setImmediate', 'WebSocket', 'XMLHttpRequest']) {
  original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true, writable: true,
    value: () => { effects.push(name); throw new Error(`Import-time effect: ${name}`); },
  });
}
const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
Object.defineProperty(AbortSignal, 'timeout', {
  configurable: true, value: () => { effects.push('AbortSignal.timeout'); throw new Error('Import-time AbortSignal.timeout'); },
});
let core;
try {
  core = await import('@shtora/spotrich');
  assert.equal(typeof core.createSpotifyClient, 'function');
  assert.equal(core.createSpotifyOAuth, undefined, 'Root must not expose OAuth.');
  const oauth = await import('@shtora/spotrich/oauth');
  const http = await import('@shtora/spotrich/http');
  assert.equal(typeof oauth.createSpotifyOAuth, 'function');
  assert.equal(typeof oauth.createTokenProvider, 'function');
  assert.equal(typeof http.createNowPlayingHandler, 'function');
  assert.deepEqual(effects, [], 'Imports must not start timers or perform network I/O.');
} finally {
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout);
  else delete AbortSignal.timeout;
}

// Even after imports, an accidental non-injected request must fail, not go live.
globalThis.fetch = async () => { throw new Error('Unexpected real network request in package consumer.'); };
const { runSmoke } = await import('./smoke.mjs');
const result = await runSmoke();
assert.equal(result.ok, true);
assert.deepEqual(result.requestCounts, { playback: 3, token: 2 });
const controller = new AbortController();
let calls = 0;
const client = core.createSpotifyClient({
  auth: 'package-cancellation-fixture', maxRetries: 0,
  fetch: async () => { calls += 1; return new Response(null, { status: 204 }); },
});
try {
  controller.abort();
  await assert.rejects(client.getNowPlaying({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0, 'Already canceled requests must not reach transport.');
  const cancel = client.subscribe(() => {}, { signal: controller.signal });
  cancel();
  assert.equal(client.getPollingStatus().subscribers, 0);
} finally { client.destroy(); }
process.stdout.write('PASS: installed root/oauth/http, inert imports, mocked HTTP/OAuth, and cancellation.\n');
