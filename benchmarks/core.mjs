import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSpotifyClient } from '../dist/index.js';

const count = Number(process.env.BENCH_OPERATIONS ?? 1_000);
const concurrency = 25;
const samples = 5;
assert(Number.isSafeInteger(count) && count >= concurrency && count <= 100_000 && count % concurrency === 0,
  'BENCH_OPERATIONS must be a multiple of 25 between 25 and 100000.');

async function measure(kind) {
  let requests = 0;
  const client = createSpotifyClient({
    auth: 'benchmark-fixture-only', maxRetries: 0,
    cacheTtlMs: kind === 'settled-cache' ? 60_000 : 0,
    clock: { now: () => 1_700_000_000_000, monotonic: () => 0 },
    fetch: async () => { requests += 1; return new Response(null, { status: 204 }); },
  });
  const start = performance.now();
  try {
    if (kind === 'inflight-coalescing') {
      for (let index = 0; index < count; index += concurrency) {
        const snapshots = await Promise.all(Array.from({ length: concurrency }, () => client.getNowPlaying()));
        assert(snapshots.every((snapshot) => snapshot.status === 'empty'));
      }
    } else {
      for (let index = 0; index < count; index += 1) assert.equal((await client.getNowPlaying()).status, 'empty');
    }
    const elapsedMs = performance.now() - start;
    const expectedRequests = kind === 'settled-cache' ? 1 : kind === 'inflight-coalescing' ? count / concurrency : count;
    assert.equal(requests, expectedRequests, `${kind}: request-count contract`);
    return { elapsedMs, requests };
  } finally { client.destroy(); }
}

const results = [];
for (const kind of ['uncached-sequential', 'settled-cache', 'inflight-coalescing']) {
  await measure(kind); // Untimed warm-up, with its own destroyed client.
  const runs = [];
  for (let sample = 0; sample < samples; sample += 1) runs.push(await measure(kind));
  const durations = runs.map((run) => run.elapsedMs).sort((a, b) => a - b);
  results.push({
    scenario: kind, operationsPerSample: count, requestsPerSample: runs[0].requests,
    concurrency: kind === 'inflight-coalescing' ? concurrency : 1,
    medianMs: Number(durations[Math.floor(samples / 2)].toFixed(3)),
    minMs: Number(durations[0].toFixed(3)), maxMs: Number(durations.at(-1).toFixed(3)),
  });
}
process.stdout.write(`${JSON.stringify({
  note: 'Local injected 204 responses only; not live latency or a cross-library comparison. Timing is host-dependent.',
  runtime: process.version, platform: process.platform, arch: process.arch, samples, results,
}, null, 2)}\n`);
