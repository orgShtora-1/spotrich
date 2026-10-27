import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createSpotifyClient } from '../dist/index.js';
import {
  NOW, assertFrozen, deferred, fakeTime, fixture, flush, hasCode, isAbort, jsonResponse, playback, rawTrack,
} from './helpers.mjs';

test('construction, status and progress are inert until an explicit read or subscription', async (t) => {
  const { client, time, calls } = fixture(t);
  assert.deepEqual(client.getPollingStatus(), { state: 'idle', subscribers: 0, retryAt: null, quotaExceeded: false });
  assert.deepEqual(client.getProgress(), { progressMs: null, estimated: false, ageMs: 0, stale: true, observedAt: null });
  await time.advance(60_000);
  assert.equal(calls.length, 0);
  assert.deepEqual(time.created, []);
  client.resumePolling();
  assert.equal(calls.length, 0, 'resume cannot create subscribers');
  assert.equal(time.pending, 0);
});

test('progress uses a monotonic observation anchor despite forward and backward wall-clock changes', async (t) => {
  const { client, time, calls } = fixture(t, { fetch: async () => jsonResponse(playback({
    timestamp: NOW - 86_400_000, item: rawTrack({ duration_ms: 2_500 }),
  })) });
  const snapshot = await client.getNowPlaying();
  assert.deepEqual(client.getProgress(snapshot), {
    progressMs: 1_000, estimated: false, ageMs: 0, stale: false, observedAt: NOW,
  });
  time.setWall(NOW + 86_400_000);
  await time.advance(1_000);
  assert.deepEqual(client.getProgress(snapshot, { staleAfterMs: 1_000 }), {
    progressMs: 2_000, estimated: true, ageMs: 1_000, stale: false, observedAt: NOW,
  });
  time.setWall(NOW - 86_400_000);
  await time.advance(1_000);
  const estimate = client.getProgress(undefined, { staleAfterMs: 1_000 });
  assert.deepEqual(estimate, { progressMs: 2_500, estimated: true, ageMs: 2_000, stale: true, observedAt: NOW });
  assertFrozen(estimate);
  assert.equal(snapshot.item.id, 'track-one', 'reaching duration must never invent a next track');
  assert.equal(snapshot.progressMs, 1_000, 'estimation must not mutate an observation');
  assert.equal(calls.length, 1, 'progress estimation is always local');
});

for (const [label, input, expected] of [
  ['paused', { is_playing: false }, 1_000],
  ['null progress', { progress_ms: null }, null],
  ['unavailable item', { item: null }, 1_000],
  ['advertisement', { currently_playing_type: 'ad', item: null }, 1_000],
  ['unknown item', { item: { type: 'future-media' } }, 1_000],
]) {
  test(`${label} progress is not extrapolated into fabricated playback`, async (t) => {
    const { client, time, calls } = fixture(t, { fetch: async () => jsonResponse(playback(input)) });
    const snapshot = await client.getNowPlaying();
    await time.advance(2_000);
    assert.deepEqual(client.getProgress(snapshot, { staleAfterMs: 1_000 }), {
      progressMs: expected, estimated: false, ageMs: 2_000, stale: true, observedAt: NOW,
    });
    assert.equal(calls.length, 1);
  });
}

test('empty playback has null progress and retains its observation age', async (t) => {
  const { client, time } = fixture(t, { fetch: async () => jsonResponse(null, 204) });
  const snapshot = await client.getNowPlaying();
  await time.advance(500);
  assert.deepEqual(client.getProgress(snapshot), { progressMs: null, estimated: false, ageMs: 500, stale: false, observedAt: NOW });
});

test('progress from a serialized snapshot uses observedAt, not the source state-change timestamp', async (t) => {
  const { client, time } = fixture(t);
  const snapshot = JSON.parse(JSON.stringify(await client.getNowPlaying()));
  await time.advance(1_500);
  assert.equal(client.getProgress(snapshot).ageMs, 1_500);
  assert.equal(client.getProgress(snapshot).progressMs, 2_500);
  assert.equal(client.getProgress({ ...snapshot, observedAt: NOW + 60_000 }).ageMs, 0);
});

test('the default settled-cache TTL is zero', async (t) => {
  const { client, calls } = fixture(t);
  await client.getNowPlaying();
  await client.getNowPlaying();
  assert.equal(calls.length, 2);
});

test('configured TTL expires at the monotonic boundary and cache hits do not reanchor progress', async (t) => {
  const { client, time, calls } = fixture(t, { cacheTtlMs: 1_000 });
  const first = await client.getNowPlaying();
  time.setWall(NOW + 86_400_000);
  await time.advance(999);
  const cached = await client.getNowPlaying();
  assert.deepEqual(cached, first);
  assert.equal(calls.length, 1);
  assert.equal(client.getProgress(cached).ageMs, 999);
  assert.equal(client.getProgress(cached).progressMs, 1_999);
  await time.advance(1);
  const next = await client.getNowPlaying();
  assert.equal(calls.length, 2);
  assert.equal(next.observedAt, NOW + 86_401_000);
  assert.equal(client.getProgress(next).ageMs, 0);
});

test('fresh and refresh bypass settled cache without mutating earlier snapshots', async (t) => {
  let sequence = 0;
  const { client, calls } = fixture(t, { cacheTtlMs: 10_000, fetch: async () => jsonResponse(playback({
    item: rawTrack({ id: `track-${++sequence}` }),
  })) });
  const first = await client.getNowPlaying();
  assert.equal((await client.getNowPlaying()).item.id, 'track-1');
  assert.equal((await client.getNowPlaying({ fresh: true })).item.id, 'track-2');
  assert.equal((await client.refresh()).item.id, 'track-3');
  assert.equal((await client.getNowPlaying()).item.id, 'track-3');
  assert.equal(first.item.id, 'track-1');
  assert.equal(calls.length, 3);
  assertFrozen(first);
});

test('cache and request keys include endpoint, market, history page size, and cursor direction/value', async (t) => {
  const { client, calls } = fixture(t, { cacheTtlMs: 60_000, fetch: async (url) => (
    String(url).includes('/recently-played') ? jsonResponse({ items: [] }) : jsonResponse(playback())
  ) });
  const readers = [
    () => client.getNowPlaying(),
    () => client.getNowPlaying({ market: 'us' }),
    () => client.getNowPlaying({ market: 'gb' }),
    () => client.getPlaybackState({ market: 'us' }),
    () => client.getRecentlyPlayed(),
    () => client.getRecentlyPlayed({ limit: 1 }),
    () => client.getRecentlyPlayed({ limit: 1, after: 0 }),
    () => client.getRecentlyPlayed({ limit: 1, after: 1 }),
    () => client.getRecentlyPlayed({ limit: 1, before: 1 }),
  ];
  for (const read of readers) await read();
  assert.equal(calls.length, readers.length);
  for (const read of readers) await read();
  await client.getNowPlaying({ market: 'US' });
  assert.equal(calls.length, readers.length, 'equivalent market casing should reuse the normalized request key');
  const urls = calls.map(({ url }) => new URL(url));
  assert.equal(urls[0].pathname, '/v1/me/player/currently-playing');
  assert.equal(urls[0].searchParams.get('additional_types'), 'track,episode');
  assert.equal(urls[1].searchParams.get('market'), 'US');
  assert.equal(urls[3].pathname, '/v1/me/player');
  assert.equal(urls[4].searchParams.get('limit'), '20');
  assert.equal(urls[6].searchParams.get('after'), '0');
  assert.equal(urls[8].searchParams.get('before'), '1');
});

test('a large set of cursor keys is evicted rather than retained as an unbounded settled cache', async (t) => {
  const { client, calls } = fixture(t, { cacheTtlMs: 60_000, fetch: async () => jsonResponse({ items: [] }) });
  // Exercise eviction through public reads; no dependency on Map layout or eviction order.
  const cursors = Array.from({ length: 256 }, (_, index) => index);
  for (const after of cursors) await client.getRecentlyPlayed({ limit: 1, after });
  const initialCalls = calls.length;
  for (const after of cursors) await client.getRecentlyPlayed({ limit: 1, after });
  assert.ok(calls.length > initialCalls, 'bounded cache must evict older unique history keys');
  assert.ok(calls.length <= initialCalls * 2);
});

test('identical concurrent reads, fresh reads, refresh and isPlaying share one in-flight GET', async (t) => {
  const response = deferred();
  const { client, calls } = fixture(t, { fetch: () => response.promise });
  const first = client.getNowPlaying({ market: 'us' });
  const second = client.getNowPlaying({ market: 'US', fresh: true });
  const refreshed = client.refresh({ market: 'us' });
  const playing = client.isPlaying({ market: 'US' });
  assert.equal(calls.length, 1);
  response.resolve(jsonResponse(playback()));
  const [a, b, c, isPlaying] = await Promise.all([first, second, refreshed, playing]);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(isPlaying, true);
  assert.equal(calls.length, 1);
});

test('different in-flight markets and endpoints are never coalesced', async (t) => {
  const response = deferred();
  const { client, calls } = fixture(t, { fetch: () => response.promise });
  const requests = [client.getNowPlaying({ market: 'US' }), client.getNowPlaying({ market: 'GB' }), client.getPlaybackState({ market: 'US' })];
  assert.equal(calls.length, 3);
  // Distinct transports must get distinct consumable response bodies.
  response.resolve({ status: 200, ok: true, headers: new Headers(), json: async () => playback() });
  const [us, gb, state] = await Promise.all(requests);
  assert.equal(us.item.kind, 'track');
  assert.equal(gb.item.kind, 'track');
  assert.equal(state.playback.item.kind, 'track');
});

test('canceling one waiter detaches it without aborting another waiter or leaking the abort reason', async (t) => {
  const response = deferred();
  const { client, calls, time } = fixture(t, { fetch: () => response.promise });
  const first = new AbortController();
  const second = new AbortController();
  const canceled = assert.rejects(client.getNowPlaying({ signal: first.signal }), (error) => {
    isAbort(error);
    assert.doesNotMatch(String(error), /private-cancel-reason/);
    return true;
  });
  const survivor = client.getNowPlaying({ signal: second.signal });
  first.abort('private-cancel-reason');
  await canceled;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, false);
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  response.resolve(jsonResponse(playback()));
  assert.equal((await survivor).item.id, 'track-one');
  assert.equal(getEventListeners(second.signal, 'abort').length, 0);
  assert.equal(time.pending, 0);
});

test('canceling the last waiter aborts transport and a late completion cannot overwrite a new read', async (t) => {
  const oldResponse = deferred();
  let requests = 0;
  const { client, calls, time } = fixture(t, { cacheTtlMs: 1_000, fetch: () => (
    ++requests === 1 ? oldResponse.promise : Promise.resolve(jsonResponse(playback({ item: rawTrack({ id: 'new-track' }) })))
  ) });
  const a = new AbortController();
  const b = new AbortController();
  const first = assert.rejects(client.getNowPlaying({ signal: a.signal }), isAbort);
  const second = assert.rejects(client.getNowPlaying({ signal: b.signal }), isAbort);
  a.abort();
  assert.equal(calls[0].init.signal.aborted, false);
  b.abort();
  assert.equal(calls[0].init.signal.aborted, true);
  const replacement = client.getNowPlaying();
  await Promise.all([first, second]);
  assert.equal((await replacement).item.id, 'new-track');
  oldResponse.resolve(jsonResponse(playback({ item: rawTrack({ id: 'obsolete-track' }) })));
  await flush();
  assert.equal((await client.getNowPlaying()).item.id, 'new-track');
  assert.equal(calls.length, 2);
  assert.equal(time.pending, 0);
});

test('pre-aborted callers never obtain a token, fetch, or allocate an operation timer', async (t) => {
  let tokens = 0;
  const { client, calls, time } = fixture(t, { auth: { async getAccessToken() { tokens += 1; return 'token'; } } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.getNowPlaying({ signal: controller.signal }), isAbort);
  assert.equal(tokens, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(time.created, []);
});

test('account-bound clients do not share credentials, flights, snapshots or cache', async (t) => {
  const releases = { alice: deferred(), bob: deferred() };
  const fetch = (_url, init) => {
    const account = new Headers(init.headers).get('authorization').slice('Bearer '.length);
    return releases[account].promise;
  };
  const alice = fixture(t, { auth: 'alice', cacheTtlMs: 1_000, fetch });
  const bob = fixture(t, { auth: 'bob', cacheTtlMs: 1_000, fetch });
  const a = alice.client.getNowPlaying();
  const b = bob.client.getNowPlaying();
  assert.equal(alice.calls.length, 1);
  assert.equal(bob.calls.length, 1);
  releases.alice.resolve(jsonResponse(playback({ item: rawTrack({ id: 'alice-track' }) })));
  releases.bob.resolve(jsonResponse(playback({ item: rawTrack({ id: 'bob-track' }) })));
  assert.equal((await a).item.id, 'alice-track');
  assert.equal((await b).item.id, 'bob-track');
  assert.equal((await alice.client.getNowPlaying()).item.id, 'alice-track');
  assert.equal((await bob.client.getNowPlaying()).item.id, 'bob-track');
  alice.client.destroy();
  assert.equal((await bob.client.getNowPlaying()).item.id, 'bob-track');
  assert.equal(bob.calls.length, 1);
});

for (const phase of ['token', 'fetch', 'body', 'recovery-token']) {
  test(`the operation deadline includes a hanging ${phase} that ignores cancellation`, async (t) => {
    const stalled = deferred();
    const started = deferred();
    let signal;
    let tokenCalls = 0;
    const { client, time, calls } = fixture(t, {
      timeoutMs: 100,
      auth: { getAccessToken(request) {
        tokenCalls += 1;
        if (phase === 'token' || (phase === 'recovery-token' && tokenCalls === 2)) {
          signal = request.signal;
          started.resolve();
          return stalled.promise;
        }
        return Promise.resolve('valid-token');
      } },
      fetch: async (_url, init) => {
        signal = init.signal;
        if (phase === 'recovery-token') return jsonResponse({}, 401);
        if (phase === 'fetch') { started.resolve(); return stalled.promise; }
        const response = jsonResponse(null);
        response.json = () => { started.resolve(); return stalled.promise; };
        return response;
      },
    });
    const result = assert.rejects(client.getNowPlaying(), hasCode('TIMEOUT', { transient: true }));
    await started.promise;
    await time.advance(99);
    assert.equal(signal.aborted, false);
    await time.advance(1);
    await result;
    assert.equal(signal.aborted, true);
    assert.equal(calls.length, phase === 'token' ? 0 : 1);
    assert.equal(time.pending, 0);
    stalled.resolve(phase === 'token' || phase === 'recovery-token' ? 'late-token' : phase === 'fetch' ? jsonResponse(playback()) : playback());
    await flush();
    assert.equal(client.getProgress().observedAt, null, 'a timed-out operation must not publish late data');
  });
}

test('one deadline covers retry sleeps instead of restarting for each transport attempt', async (t) => {
  const { client, time, calls } = fixture(t, { timeoutMs: 600, fetch: async () => { throw new Error('private-network'); } });
  const result = assert.rejects(client.getNowPlaying(), hasCode('TIMEOUT'));
  await flush();
  await time.advance(500);
  assert.equal(calls.length, 2);
  await time.advance(100);
  await result;
  assert.equal(calls.length, 2);
  assert.equal(time.pending, 0);
  assert.equal(calls[1].init.signal.aborted, true);
});

test('static 401 is terminal and cannot trigger blind token recovery or transient retry', async (t) => {
  const { client, calls, diagnostics } = fixture(t, { fetch: async () => jsonResponse({ error: 'private-upstream' }, 401) });
  await assert.rejects(client.getNowPlaying(), hasCode('AUTH_REQUIRED', { status: 401, transient: false }));
  assert.equal(calls.length, 1);
  assert.equal(diagnostics.some(({ type }) => type === 'retry'), false);
});

test('one provider recovery receives the rejected token and retries with the replacement', async (t) => {
  const tokenRequests = [];
  let attempt = 0;
  const { client, calls } = fixture(t, {
    auth: { async getAccessToken(request) { tokenRequests.push(request); return tokenRequests.length === 1 ? 'old-token' : 'new-token'; } },
    fetch: async () => ++attempt === 1 ? jsonResponse({}, 401) : jsonResponse(playback()),
  });
  assert.equal((await client.getNowPlaying()).status, 'available');
  assert.equal(tokenRequests.length, 2);
  assert.equal(tokenRequests[0].rejectedAccessToken, undefined);
  assert.equal(tokenRequests[1].rejectedAccessToken, 'old-token');
  assert.ok(tokenRequests[0].signal instanceof AbortSignal);
  assert.deepEqual(calls.map(({ init }) => new Headers(init.headers).get('authorization')), ['Bearer old-token', 'Bearer new-token']);
});

test('a second 401 in the same operation ends bounded provider recovery', async (t) => {
  let tokenCalls = 0;
  const { client, calls } = fixture(t, {
    auth: { async getAccessToken() { return `token-${++tokenCalls}`; } },
    fetch: async () => jsonResponse({}, 401),
  });
  await assert.rejects(client.getNowPlaying(), hasCode('AUTH_REQUIRED', { status: 401 }));
  assert.equal(tokenCalls, 2);
  assert.equal(calls.length, 2);
});

test('401 recovery does not reset the shared default budget of two transient GET retries', async (t) => {
  let attempt = 0;
  let tokenCalls = 0;
  const { client, calls, time, diagnostics } = fixture(t, {
    auth: { async getAccessToken() { return `token-${++tokenCalls}`; } },
    fetch: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('private-network');
      if (attempt === 2) return jsonResponse({}, 401);
      return jsonResponse({ error: 'private-upstream' }, 503);
    },
  });
  const result = assert.rejects(client.getNowPlaying(), hasCode('HTTP', { status: 503, transient: true }));
  await flush();
  await time.advance(time.nextDelay());
  await time.advance(time.nextDelay());
  await result;
  assert.equal(calls.length, 4, 'initial GET + two transient retries + one 401 recovery');
  assert.equal(tokenCalls, 2);
  const delays = diagnostics.filter(({ type }) => type === 'retry').map(({ delayMs }) => delayMs);
  assert.equal(delays.length, 2);
  assert.ok(delays[1] > delays[0], 'transient backoff remains exponential across 401 recovery');
});

for (const maxRetries of [0, 1, 2]) {
  test(`maxRetries ${maxRetries} bounds network attempts to ${maxRetries + 1}`, async (t) => {
    const { client, calls, time } = fixture(t, { maxRetries, fetch: async () => { throw new Error('private-network'); } });
    const result = assert.rejects(client.getNowPlaying(), hasCode('NETWORK', { transient: true }));
    await flush();
    for (let retry = 0; retry < maxRetries; retry += 1) await time.advance(time.nextDelay());
    await result;
    assert.equal(calls.length, maxRetries + 1);
    assert.equal(time.pending, 0);
  });
}

for (const [label, status, code, transient] of [
  ['forbidden', 403, 'HTTP', false],
  ['server error', 500, 'HTTP', true], ['bad gateway', 502, 'HTTP', true],
  ['unavailable', 503, 'HTTP', true], ['gateway timeout', 504, 'HTTP', true],
  ['network failure', undefined, 'NETWORK', true],
]) {
  test(`${label} failures and diagnostics expose only redacted metadata`, async (t) => {
    const secret = 'private-token private-upstream-body https://private.example/account';
    const { client, calls, time, diagnostics } = fixture(t, {
      auth: 'private-token',
      fetch: async () => {
        if (status === undefined) throw Object.assign(new Error(secret), { cause: new Error(secret) });
        return jsonResponse({ error: { message: secret }, access_token: secret }, status, { 'x-private': secret });
      },
    });
    const result = assert.rejects(client.getNowPlaying(), (error) => {
      hasCode(code, { status, transient })(error);
      assert.doesNotMatch(String(error) + error.stack + JSON.stringify(error), /private-token|private-upstream-body|private\.example/);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
    await flush();
    if (transient) {
      await time.advance(time.nextDelay());
      await time.advance(time.nextDelay());
    }
    await result;
    assert.equal(calls.length, transient ? 3 : 1);
    for (const event of diagnostics) {
      assertFrozen(event);
      assert.deepEqual(Object.keys(event).sort(), event.type === 'retry'
        ? ['delayMs', 'type'] : ['durationMs', 'endpoint', 'status', 'type']);
    }
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-token|private-upstream-body|private\.example|Bearer/);
  });
}

test('provider exceptions are redacted without exposing the account token or cause', async (t) => {
  const { client, calls } = fixture(t, { auth: { async getAccessToken() { throw new Error('private-token private-provider-message'); } } });
  await assert.rejects(client.getNowPlaying(), (error) => {
    hasCode('AUTH_REQUIRED')(error);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /private-token|private-provider-message/);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
  assert.equal(calls.length, 0);
});

test('GET requests use the fixed HTTPS Spotify endpoint, private transport options and bearer header', async (t) => {
  const { client, calls } = fixture(t);
  await client.getNowPlaying({ market: 'br' });
  const { url, init } = calls[0];
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://api.spotify.com');
  assert.equal(parsed.pathname, '/v1/me/player/currently-playing');
  assert.equal(parsed.searchParams.get('market'), 'BR');
  assert.equal(url.includes('account-access'), false);
  assert.equal(init.method, 'GET');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.redirect, 'error');
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer account-access');
  assert.equal(new Headers(init.headers).get('accept'), 'application/json');
});

test('a client-wide long Retry-After gates every endpoint, cached reads and fresh reads until the exact reset', async (t) => {
  let attempt = 0;
  const { client, calls, time } = fixture(t, { cacheTtlMs: 300_000, polling: { maxBackoffMs: 1_000 }, fetch: async () => (
    ++attempt === 2 ? jsonResponse({}, 429, { 'Retry-After': '120' }) : jsonResponse(playback())
  ) });
  await client.getNowPlaying();
  await assert.rejects(client.getPlaybackState(), hasCode('RATE_LIMITED', { retryAfterMs: 120_000, status: 429 }));
  assert.equal(client.getPollingStatus().retryAt, NOW + 120_000);
  for (const read of [
    () => client.getNowPlaying(), () => client.refresh(), () => client.getNowPlaying({ fresh: true }),
    () => client.getPlaybackState({ fresh: true }), () => client.getRecentlyPlayed({ fresh: true }),
  ]) await assert.rejects(read(), hasCode('RATE_LIMITED', { retryAfterMs: 120_000 }));
  assert.equal(calls.length, 2);
  await time.advance(60_000);
  client.resumePolling();
  await assert.rejects(client.refresh(), hasCode('RATE_LIMITED', { retryAfterMs: 60_000 }));
  await time.advance(59_999);
  await assert.rejects(client.refresh(), hasCode('RATE_LIMITED', { retryAfterMs: 1 }));
  assert.equal(calls.length, 2);
  await time.advance(1);
  assert.equal((await client.refresh()).status, 'available');
  assert.equal(calls.length, 3);
  assert.equal(client.getPollingStatus().retryAt, null);
});

test('HTTP-date Retry-After is also authoritative for more than sixty seconds', async (t) => {
  const retryAt = NOW + 90_000;
  const { client, calls, time } = fixture(t, { fetch: async () => jsonResponse({}, 429, { 'Retry-After': new Date(retryAt).toUTCString() }) });
  await assert.rejects(client.getNowPlaying(), hasCode('RATE_LIMITED', { retryAfterMs: 90_000 }));
  await time.advance(60_000);
  await assert.rejects(client.getRecentlyPlayed(), hasCode('RATE_LIMITED', { retryAfterMs: 30_000 }));
  assert.equal(client.getPollingStatus().retryAt, retryAt);
  assert.equal(calls.length, 1);
});

test('rate gates are account-local rather than module-global', async (t) => {
  const alice = fixture(t, { fetch: async () => jsonResponse({}, 429, { 'Retry-After': '120' }) });
  const bob = fixture(t);
  await assert.rejects(alice.client.getNowPlaying(), hasCode('RATE_LIMITED'));
  assert.equal((await bob.client.getNowPlaying()).item.id, 'track-one');
  assert.equal(bob.client.getPollingStatus().retryAt, null);
  await assert.rejects(alice.client.refresh(), hasCode('RATE_LIMITED'));
  assert.equal(alice.calls.length, 1);
  assert.equal(bob.calls.length, 1);
});

test('polling never overlaps a slow body and starts its next cadence after completion', async (t) => {
  const body = deferred();
  const bodyStarted = deferred();
  let attempt = 0;
  const { client, calls, time } = fixture(t, { timeoutMs: 120_000, fetch: async () => {
    if (++attempt !== 1) return jsonResponse(playback());
    const response = jsonResponse(null);
    response.json = () => { bodyStarted.resolve(); return body.promise; };
    return response;
  } });
  const updates = [];
  const first = client.subscribe((event) => updates.push(event));
  await bodyStarted.promise;
  const second = client.subscribe(() => {});
  await time.advance(30_000);
  assert.equal(calls.length, 1);
  assert.equal(updates.length, 0);
  body.resolve(playback());
  await flush();
  assert.equal(updates.length, 1);
  await time.advance(4_999);
  assert.equal(calls.length, 1);
  await time.advance(1);
  assert.equal(calls.length, 2);
  first();
  assert.equal(client.getPollingStatus().subscribers, 1);
  second();
  assert.equal(client.getPollingStatus().state, 'idle');
  assert.equal(time.pending, 0);
});

for (const [label, input, polling, interval] of [
  ['default playing', playback(), {}, 5_000],
  ['default paused', playback({ is_playing: false }), {}, 15_000],
  ['default empty', null, {}, 30_000],
  ['default unavailable', playback({ item: null }), {}, 30_000],
  ['configured playing', playback(), { playingIntervalMs: 3_000 }, 3_000],
  ['configured paused', playback({ is_playing: false }), { pausedIntervalMs: 7_000 }, 7_000],
  ['configured idle', null, { idleIntervalMs: 9_000 }, 9_000],
  ['near track end', playback({ progress_ms: 179_900 }), {}, 1_000],
  ['past track end', playback({ progress_ms: 190_000 }), {}, 1_000],
]) {
  test(`${label} polling adapts cadence without violating the one-second minimum`, async (t) => {
    const { client, calls, time } = fixture(t, { polling, fetch: async () => jsonResponse(input) });
    const events = [];
    const unsubscribe = client.subscribe((event) => events.push(event));
    await flush();
    assert.equal(events[0].type, 'update');
    assert.deepEqual(time.delays(), [interval]);
    await time.advance(interval - 1);
    assert.equal(calls.length, 1);
    await time.advance(1);
    assert.equal(calls.length, 2);
    assert.equal(events.length, 2);
    unsubscribe();
    assert.equal(time.pending, 0);
  });
}

test('transient polling backoff grows to its configured cap and resets after a successful observation', async (t) => {
  let attempt = 0;
  const { client, calls, time } = fixture(t, { maxRetries: 0,
    polling: { maxBackoffMs: 5_000, playingIntervalMs: 7_000 },
    fetch: async () => ++attempt === 5 ? jsonResponse(playback()) : jsonResponse({}, 503),
  });
  const events = [];
  client.subscribe((event) => events.push(event));
  await flush();
  const delays = [];
  for (let failure = 0; failure < 4; failure += 1) {
    const delay = time.nextDelay();
    delays.push(delay);
    assert.ok(delay >= 1_000 && delay <= 5_000);
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.at(-1).willRetry, true);
    await time.advance(delay - 1);
    assert.equal(calls.length, failure + 1);
    await time.advance(1);
  }
  assert.ok(delays[1] > delays[0]);
  assert.ok(delays.every((delay, index) => index === 0 || delay >= delays[index - 1]));
  assert.equal(delays.at(-1), 5_000);
  assert.equal(events.at(-1).type, 'update');
  assert.deepEqual(time.delays(), [7_000]);
  await time.advance(7_000);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(time.nextDelay(), delays[0], 'success resets transient failure backoff');
});

test('polling preserves long authoritative Retry-After even when resume is requested during cooldown', async (t) => {
  let attempt = 0;
  const { client, calls, time } = fixture(t, {
    polling: { maxBackoffMs: 1_000 },
    fetch: async () => ++attempt === 1 ? jsonResponse({}, 429, { 'Retry-After': '120' }) : jsonResponse(playback()),
  });
  const events = [];
  client.subscribe((event) => events.push(event));
  await flush();
  assert.equal(events[0].error.code, 'RATE_LIMITED');
  assert.equal(events[0].willRetry, true);
  assert.deepEqual(time.delays(), [120_000]);
  await time.advance(60_000);
  assert.equal(calls.length, 1);
  client.resumePolling();
  await flush();
  assert.equal(calls.length, 1);
  await time.advance(59_999);
  assert.equal(calls.length, 1);
  await time.advance(1);
  assert.equal(calls.length, 2);
  assert.equal(events.at(-1).type, 'update');
});

test('unknown-reset QUOTA_EXCEEDED suspends all reads and polling until explicit host resume', async (t) => {
  let attempt = 0;
  const { client, calls, time } = fixture(t, { fetch: async () => (
    ++attempt === 1 ? jsonResponse({ error: { reason: 'QUOTA_EXCEEDED' } }, 429) : jsonResponse(playback())
  ) });
  const events = [];
  client.subscribe((event) => events.push(event));
  await flush();
  assert.equal(events[0].type, 'error');
  hasCode('QUOTA_EXCEEDED', { status: 429, transient: false, retryAfterMs: undefined })(events[0].error);
  assert.equal(events[0].willRetry, false);
  assert.deepEqual(client.getPollingStatus(), { state: 'stopped', subscribers: 1, retryAt: null, quotaExceeded: true });
  assert.equal(time.pending, 0);
  await time.advance(86_400_000);
  client.subscribe(() => {});
  await flush();
  for (const read of [() => client.refresh(), () => client.getPlaybackState(), () => client.getRecentlyPlayed()]) {
    await assert.rejects(read(), hasCode('QUOTA_EXCEEDED', { retryAfterMs: undefined }));
  }
  assert.equal(calls.length, 1);
  client.resumePolling();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(events.at(-1).type, 'update');
  assert.equal(client.getPollingStatus().state, 'polling');
  assert.equal(client.getPollingStatus().quotaExceeded, false);
});

test('known-reset quota remains transient and cannot be resumed before Retry-After', async (t) => {
  let attempt = 0;
  const { client, calls, time } = fixture(t, { fetch: async () => (
    ++attempt === 1 ? jsonResponse({ error: { reason: 'QUOTA_EXCEEDED' } }, 429, { 'Retry-After': '90' }) : jsonResponse(playback())
  ) });
  await assert.rejects(client.getNowPlaying(), hasCode('QUOTA_EXCEEDED', { transient: true, retryAfterMs: 90_000 }));
  client.resumePolling();
  await assert.rejects(client.refresh(), hasCode('QUOTA_EXCEEDED', { retryAfterMs: 90_000 }));
  await time.advance(90_000);
  assert.equal((await client.refresh()).status, 'available');
  assert.equal(calls.length, 2);
});

for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'HTTP']]) {
  test(`terminal ${status} stops polling; new subscribers and resubscription cannot silently restart it`, async (t) => {
    let attempt = 0;
    const { client, calls, time } = fixture(t, { fetch: async () => (
      ++attempt === 1 ? jsonResponse({}, status) : jsonResponse(playback())
    ) });
    const events = [];
    const first = client.subscribe((event) => events.push(event));
    await flush();
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].error.code, code);
    assert.equal(events[0].willRetry, false);
    assert.equal(client.getPollingStatus().state, 'stopped');
    assert.equal(time.pending, 0);
    const second = client.subscribe(() => {});
    await time.advance(60_000);
    assert.equal(calls.length, 1);
    first();
    second();
    client.subscribe(() => {});
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(client.getPollingStatus().state, 'stopped');
    client.resumePolling();
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(client.getPollingStatus().state, 'polling');
  });
}

test('observer and diagnostic exceptions are isolated from other listeners and later polling', async (t) => {
  const { client, time, calls, diagnostics } = fixture(t, { onDiagnostic() { throw new Error('private-observer-message'); } });
  const goodEvents = [];
  client.subscribe(() => { throw new Error('private-observer-message'); });
  client.subscribe((event) => goodEvents.push(event));
  await flush();
  assert.equal(goodEvents.length, 1);
  assert.equal(goodEvents[0].type, 'update');
  assertFrozen(goodEvents[0]);
  await time.advance(5_000);
  assert.equal(goodEvents.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(diagnostics.some(({ type }) => type === 'observer-error'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-observer-message/);
});

test('a subscription signal removes only its owner and the final unsubscribe clears the cadence', async (t) => {
  const { client, time, calls } = fixture(t);
  const signal = new AbortController();
  const a = [];
  const b = [];
  const unsubscribeA = client.subscribe((event) => a.push(event), { signal: signal.signal });
  const unsubscribeB = client.subscribe((event) => b.push(event));
  await flush();
  signal.abort();
  unsubscribeA();
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  assert.equal(client.getPollingStatus().subscribers, 1);
  await time.advance(5_000);
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  unsubscribeB();
  unsubscribeB();
  assert.equal(time.pending, 0);
  await time.advance(60_000);
  assert.equal(calls.length, 2);
  assert.equal(client.getPollingStatus().state, 'idle');
});

test('pre-aborted subscription is inert and returns a harmless unsubscribe', async (t) => {
  const { client, time, calls } = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const unsubscribe = client.subscribe(() => assert.fail('aborted subscriber must not be called'), { signal: controller.signal });
  unsubscribe();
  await flush();
  assert.equal(client.getPollingStatus().subscribers, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(time.created, []);
});

test('final unsubscribe aborts a pending poll and prevents late publication or rescheduling', async (t) => {
  const response = deferred();
  const events = [];
  const { client, calls, time } = fixture(t, { fetch: () => response.promise });
  const unsubscribe = client.subscribe((event) => events.push(event));
  assert.equal(calls.length, 1);
  unsubscribe();
  assert.equal(calls[0].init.signal.aborted, true);
  await flush();
  assert.equal(time.pending, 0);
  response.resolve(jsonResponse(playback()));
  await time.advance(60_000);
  assert.deepEqual(events, []);
  assert.equal(calls.length, 1);
  assert.equal(client.getProgress().observedAt, null);
  assert.equal(time.pending, 0);
});

test('destroy is idempotent, aborts shared work, clears subscriptions and never publishes late data', async (t) => {
  const response = deferred();
  const signal = new AbortController();
  const events = [];
  const { client, calls, time } = fixture(t, { fetch: () => response.promise });
  client.subscribe((event) => events.push(event), { signal: signal.signal });
  const pending = assert.rejects(client.getNowPlaying(), isAbort);
  assert.equal(calls.length, 1);
  client.destroy();
  client.destroy();
  await pending;
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  response.resolve(jsonResponse(playback()));
  await time.advance(60_000);
  assert.deepEqual(events, []);
  assert.deepEqual(client.getPollingStatus(), { state: 'destroyed', subscribers: 0, retryAt: null, quotaExceeded: false });
  assert.equal(time.pending, 0);
  await assert.rejects(client.getNowPlaying(), hasCode('DESTROYED'));
  await assert.rejects(client.getPlaybackState(), hasCode('DESTROYED'));
  await assert.rejects(client.getRecentlyPlayed(), hasCode('DESTROYED'));
  assert.throws(() => client.getProgress(), hasCode('DESTROYED'));
  assert.throws(() => client.resumePolling(), hasCode('DESTROYED'));
  assert.throws(() => client.subscribe(() => {}), hasCode('DESTROYED'));
});

test('invalid read parameters fail before fetching or scheduling any work', async (t) => {
  const { client, calls, time } = fixture(t);
  for (const market of ['', 'USA', '1A', '../me', 'US&token=x']) {
    await assert.rejects(client.getNowPlaying({ market }), hasCode('CONFIG'));
  }
  for (const request of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { before: 1, after: 2 }, { before: -1 }, { after: Infinity }, { after: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(client.getRecentlyPlayed(request), hasCode('CONFIG'));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(time.created, []);
});

test('configuration rejects invalid timeout, cache, retry and sub-second polling bounds', () => {
  const time = fakeTime();
  for (const patch of [
    { auth: '' }, { auth: 'token with spaces' }, { auth: {} }, { timeoutMs: 0 }, { timeoutMs: Infinity },
    { cacheTtlMs: -1 }, { maxRetries: 3 }, { polling: { playingIntervalMs: 999 } },
    { polling: { pausedIntervalMs: 0 } }, { polling: { idleIntervalMs: NaN } },
  ]) {
    assert.throws(() => createSpotifyClient({ auth: 'token', fetch: async () => jsonResponse(playback()), clock: time.clock, scheduler: time.scheduler, ...patch }), hasCode('CONFIG'));
  }
  assert.deepEqual(time.created, []);
});
