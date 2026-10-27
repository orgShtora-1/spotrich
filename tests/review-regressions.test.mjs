import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenProvider } from '../dist/oauth.js';
import { NOW, deferred, fixture, flush, hasCode, isAbort, jsonResponse, playback } from './helpers.mjs';

test('429 installs its header cooldown before a stalled body and retains it after timeout', async (t) => {
  const { client, calls, time } = fixture(t, { timeoutMs: 100, fetch: async () =>
    new Response(new ReadableStream(), { status: 429, headers: { 'Retry-After': '120' } }) });
  const pending = client.getNowPlaying().catch((error) => error);
  await flush();
  assert.equal(client.getPollingStatus().retryAt, NOW + 120_000);
  await assert.rejects(client.getPlaybackState(), hasCode('RATE_LIMITED'));
  assert.equal(calls.length, 1);
  await time.advance(100);
  assert.equal((await pending).code, 'TIMEOUT');
  await assert.rejects(client.refresh(), hasCode('RATE_LIMITED'));
  assert.equal(calls.length, 1);
});

test('a token wait cannot dispatch through a cooldown installed by another endpoint', async (t) => {
  const token = deferred();
  let acquisitions = 0;
  const { client, calls } = fixture(t, {
    auth: { getAccessToken() { return ++acquisitions === 1 ? token.promise : Promise.resolve('access'); } },
    fetch: async () => jsonResponse({}, 429, { 'Retry-After': '120' }),
  });
  const waiting = client.getNowPlaying();
  const checked = assert.rejects(waiting, hasCode('RATE_LIMITED'));
  await assert.rejects(client.getPlaybackState(), hasCode('RATE_LIMITED'));
  token.resolve('access');
  await checked;
  assert.equal(calls.length, 1);
});

test('synchronous provider-side caller cancellation cannot be lost before waiter registration', async (t) => {
  const controller = new AbortController();
  const { client, calls } = fixture(t, { auth: {
    async getAccessToken() { controller.abort('private reason'); return 'access'; },
  } });
  await assert.rejects(client.getNowPlaying({ signal: controller.signal }), isAbort);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(client.getProgress().observedAt, null);
});

test('cancellation from a 401 diagnostic never invokes recovery with an aborted signal', async (t) => {
  const controller = new AbortController();
  let tokens = 0;
  const { client } = fixture(t, {
    auth: { async getAccessToken() { tokens++; return 'access'; } },
    fetch: async () => jsonResponse({}, 401),
    onDiagnostic(event) { if (event.type === 'request') controller.abort(); },
  });
  await assert.rejects(client.getNowPlaying({ signal: controller.signal }), isAbort);
  await flush();
  assert.equal(tokens, 1);
});

for (const status of [401, 403, 503]) {
  test(`discarded ${status} bodies are canceled before recovery, retry, or rejection`, async (t) => {
    let canceled = false;
    let sent = 0;
    const { client, time } = fixture(t, {
      auth: { async getAccessToken() { return 'access'; } },
      fetch: async () => {
        if (++sent === 1) return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status });
        assert.equal(canceled, true);
        return jsonResponse(playback());
      },
    });
    const result = client.getNowPlaying();
    void result.catch(() => {});
    const checked = status === 403 ? assert.rejects(result, hasCode('HTTP')) : result;
    await flush();
    assert.equal(canceled, true);
    if (status === 503) await time.advance(500);
    await checked;
    assert.equal(sent, status === 403 ? 1 : 2);
  });
}

function persistedGrant() {
  let value = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: NOW - 1,
    scope: [], tokenType: 'Bearer', authorizedAt: NOW - 1_000 };
  let queue = Promise.resolve();
  const store = { async load() { return value; }, async clear() { value = null; }, async save(next) { value = next; } };
  const withRefreshLock = (operation) => {
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  };
  return { store, withRefreshLock };
}

for (const kind of ['network', 'invalid-json', 'http', 'save']) {
  test(`a reconstructed provider cannot reuse persisted credentials after ${kind} failure`, async () => {
    const grant = persistedGrant();
    let posts = 0;
    if (kind === 'save') grant.store.save = async () => { throw new Error('storage unavailable'); };
    const options = { mode: 'pkce', clientId: 'client', now: () => NOW, ...grant, fetch: async () => {
      posts++;
      if (kind === 'network') throw new Error('ambiguous transport');
      if (kind === 'invalid-json') return new Response('invalid');
      if (kind === 'http') return jsonResponse({}, 503);
      return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer' });
    } };
    await assert.rejects(createTokenProvider(options).getAccessToken());
    await assert.rejects(createTokenProvider(options).getAccessToken(), hasCode('AUTH_REQUIRED'));
    assert.equal(posts, 1);
  });
}

test('failed durable invalidation prevents dispatch, including on another provider', async () => {
  const grant = persistedGrant();
  grant.store.clear = async () => { throw new Error('cannot invalidate'); };
  let posts = 0;
  const options = { mode: 'pkce', clientId: 'client', now: () => NOW, ...grant,
    fetch: async () => { posts++; return jsonResponse({}, 400); } };
  await assert.rejects(createTokenProvider(options).getAccessToken(), hasCode('STORAGE'));
  await assert.rejects(createTokenProvider(options).getAccessToken(), hasCode('STORAGE'));
  assert.equal(posts, 0);
});

test('a committed save that rejects may leave only the validated replacement for another provider', async () => {
  const grant = persistedGrant();
  const save = grant.store.save;
  grant.store.save = async (tokens) => { await save(tokens); throw new Error('acknowledgement lost'); };
  let posts = 0;
  const options = { mode: 'pkce', clientId: 'client', now: () => NOW, ...grant, fetch: async () => {
    posts++;
    return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer' });
  } };
  await assert.rejects(createTokenProvider(options).getAccessToken(), hasCode('STORAGE'));
  assert.equal(await createTokenProvider(options).getAccessToken(), 'new-access');
  assert.equal(posts, 1);
});

// A01 regression: concurrent 429 with Retry-After and QUOTA_EXCEEDED without reset must not erase
// the authoritative cooldown. Resume may clear the indefinite quota suspension, never the known deadline.
test('A01: concurrent 429 with Retry-After then QUOTA_EXCEEDED without reset preserves known deadline', async (t) => {
  let attempt = 0;
  const { client, time } = fixture(t, {
    fetch: async () => {
      ++attempt;
      // First response: 429 with Retry-After: 120
      if (attempt === 1) return jsonResponse({}, 429, { 'Retry-After': '120' });
      // Second response: 429 QUOTA_EXCEEDED no reset
      return jsonResponse({ error: { reason: 'QUOTA_EXCEEDED' } }, 429);
    },
  });
  const first = client.getNowPlaying().catch((e) => e);
  const second = client.getPlaybackState().catch((e) => e);
  await flush();
  assert.equal(client.getPollingStatus().retryAt, NOW + 120_000);
  // Resume should NOT bypass the known 120s cooldown
  client.resumePolling();
  const third = client.refresh().catch((e) => e);
  await flush();
  // No new GET should be dispatched until the cooldown expires
  assert.equal(attempt, 2);
  // Advance time past the 120s cooldown
  await time.advance(120_000);
  assert.equal((await first).code, 'RATE_LIMITED');
  assert.equal((await second).code, 'QUOTA_EXCEEDED');
  // After deadline expires, refresh should succeed
  await assert.doesNotReject(third);
});

// A01 regression: reverse order - QUOTA_EXCEEDED first, then Retry-After
test('A01: concurrent 429 QUOTA_EXCEEDED then Retry-After preserves known deadline', async (t) => {
  let attempt = 0;
  const { client, time } = fixture(t, {
    fetch: async () => {
      ++attempt;
      // First response: 429 QUOTA_EXCEEDED no reset
      if (attempt === 1) return jsonResponse({ error: { reason: 'QUOTA_EXCEEDED' } }, 429);
      // Second response: 429 with Retry-After: 120
      return jsonResponse({}, 429, { 'Retry-After': '120' });
    },
  });
  const first = client.getNowPlaying().catch((e) => e);
  const second = client.getPlaybackState().catch((e) => e);
  // Drain microtasks until both flights settle.
  for (let i = 0; i < 100; i++) await Promise.resolve();
  const status = client.getPollingStatus();
  // Both responses must have been processed; attempt tracks dispatch count.
  assert.equal(attempt, 2, `expected both fetches to complete, got attempt=${attempt}`);
  assert.ok(status.retryAt !== null, `expected retryAt to be set after both 429s, got ${status.retryAt}`);
  assert.equal(status.retryAt, NOW + 120_000);
  client.resumePolling();
  const third = client.refresh().catch((e) => e);
  for (let i = 0; i < 100; i++) await Promise.resolve();
  assert.equal(client.getPollingStatus().retryAt, NOW + 120_000);
  await time.advance(120_000);
  assert.equal((await first).code, 'QUOTA_EXCEEDED');
  assert.equal((await second).code, 'RATE_LIMITED');
  await assert.doesNotReject(third);
});

// A02 regression: wall-clock jumps must not bypass or prolong monotonic cooldown
test('A02: forward wall-clock jump does not bypass Retry-After cooldown', async (t) => {
  let attempt = 0;
  const { client, calls, time } = fixture(t, {
    fetch: async () => {
      if (++attempt === 1) return jsonResponse({}, 429, { 'Retry-After': '120' });
      return jsonResponse(playback());
    },
  });
  const first = client.getNowPlaying().catch((e) => e);
  await flush();
  assert.equal(client.getPollingStatus().retryAt, NOW + 120_000);
  // Jump wall clock forward by 24h - monotonic time is unchanged
  time.setWall(NOW + 86_400_000);
  const second = client.refresh().catch((e) => e);
  await flush();
  // Should still be rate limited (monotonic deadline not met)
  assert.equal((await second).code, 'RATE_LIMITED');
  assert.equal(calls.length, 1);
  // Advance monotonic time past 120s
  await time.advance(120_000);
  const third = client.refresh().catch((e) => e);
  await assert.doesNotReject(third);
  assert.equal(calls.length, 2);
});

test('A02: backward wall-clock jump does not prolong Retry-After cooldown', async (t) => {
  let attempt = 0;
  const { client, calls, time } = fixture(t, {
    fetch: async () => {
      if (++attempt === 1) return jsonResponse({}, 429, { 'Retry-After': '120' });
      return jsonResponse(playback());
    },
  });
  const first = client.getNowPlaying().catch((e) => e);
  await flush();
  assert.equal(client.getPollingStatus().retryAt, NOW + 120_000);
  // Jump wall clock backward by 24h - monotonic time is unchanged
  time.setWall(NOW - 86_400_000);
  await time.advance(120_000);
  // At this point monotonic 120s has elapsed, so gate should be clear
  const second = client.refresh().catch((e) => e);
  await assert.doesNotReject(second);
  assert.equal(calls.length, 2);
});

// A03 regression: synchronous destroy inside fetch/provider must abort the in-flight operation
test('A03: synchronous destroy during fetch aborts the flight immediately', async (t) => {
  let fetchDestroyed = false;
  let fetchCalls = 0;
  const { client, calls, time } = fixture(t, {
    fetch: async (_url, init) => {
      fetchCalls++;
      if (fetchCalls === 1) {
        client.destroy();
        fetchDestroyed = true;
        // The flight was registered before this callback ran, so destroy() could abort it.
        // Check whether the signal was already aborted by that synchronous destroy().
        if (init.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return jsonResponse(playback());
      }
      return jsonResponse(playback());
    },
  });
  const result = client.getNowPlaying().catch((e) => e);
  await flush();
  assert.equal(fetchDestroyed, true);
  // AbortError has code 20 in Node.js; the key invariant is that destroy() was called
  // synchronously inside the fetch and the flight was aborted, not that the error code
  // matches a specific SpotifyError.
  const error = await result;
  assert.ok(error instanceof DOMException && error.name === 'AbortError', `expected AbortError, got ${error?.code ?? error}`);
  // No timers should remain pending after destroy
  await time.advance(100);
  assert.equal(time.pending, 0);
});

test('A03: synchronous destroy during token provider aborts the flight immediately', async (t) => {
  let providerDestroyed = false;
  const { client, calls, time } = fixture(t, {
    auth: {
      async getAccessToken(init) {
        client.destroy();
        providerDestroyed = true;
        // The flight was registered before this callback ran, so destroy() could abort it.
        if (init?.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return jsonResponse(playback());
      },
    },
    fetch: async () => jsonResponse(playback()),
  });
  const result = client.getNowPlaying().catch((e) => e);
  await flush();
  assert.equal(providerDestroyed, true);
  const error = await result;
  assert.ok(error instanceof DOMException && error.name === 'AbortError', `expected AbortError, got ${error?.code ?? error}`);
  await time.advance(100);
  assert.equal(time.pending, 0);
});
