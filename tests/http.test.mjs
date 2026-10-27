import assert from 'node:assert/strict';
import test from 'node:test';
import { createNowPlayingHandler } from '../dist/http.js';
import { SpotifyError } from '../dist/errors.js';

const privateDetails = 'private-token upstream-body stack-and-cause';

function snapshot(id = 'alice') {
  return {
    status: 'available',
    isPlaying: true,
    observedAt: 1_700_000_000_000,
    timestamp: 1_699_999_999_000,
    progressMs: 1_234,
    item: {
      kind: 'track',
      id,
      name: `Track ${id}`,
      uri: `spotify:track:${id}`,
      url: `https://open.spotify.com/track/${id}`,
      durationMs: 180_000,
      explicit: false,
      isPlayable: true,
      artists: [{ id: 'artist', name: 'Artist', url: null }],
      album: {
        id: 'album',
        name: 'Album',
        images: [{ url: 'https://images.example/album.jpg', width: 64, height: 64 }],
        url: null,
      },
    },
  };
}

function request(init) {
  return new Request('https://app.example/api/now-playing', init);
}

function assertHeaders(response, { allow = null, retryAfter = null } = {}) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('vary'), 'Cookie, Authorization');
  assert.equal(response.headers.get('allow'), allow);
  assert.equal(response.headers.get('retry-after'), retryAfter);
  for (const [name, value] of response.headers) {
    assert.equal(name.startsWith('access-control-'), false, 'CORS belongs to the host');
    assert.equal(value.includes(privateDetails), false);
  }
}

async function assertError(response, status, code, headers) {
  assert.equal(response.status, status);
  assertHeaders(response, headers);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error: { code } });
  assert.equal(body.includes(privateDetails), false);
}

function withPrivateDetails(error) {
  return Object.assign(error, {
    cause: new Error(privateDetails),
    upstreamBody: { access_token: privateDetails },
    snapshot: snapshot('private-snapshot'),
  });
}

test('awaits authorization before querying the account client and returns only its normalized payload', async () => {
  const events = [];
  const input = request({ headers: { Origin: 'https://untrusted.example' } });
  const expected = snapshot();
  let finishAuthorization;
  const authorization = new Promise((resolve) => { finishAuthorization = resolve; });
  const client = {
    async getNowPlaying(options) {
      events.push('client');
      assert.deepEqual(Object.keys(options), ['signal']);
      assert.equal(options.signal, input.signal);
      return expected;
    },
  };
  const handler = createNowPlayingHandler({
    authorize(received) {
      events.push('authorize');
      assert.equal(received, input);
      return authorization;
    },
  });

  const pending = handler(input);
  assert.deepEqual(events, ['authorize']);
  finishAuthorization(client);
  const response = await pending;

  assert.deepEqual(events, ['authorize', 'client']);
  assert.equal(response.status, 200);
  assertHeaders(response);
  assert.deepEqual(await response.json(), expected);
});

test('unauthenticated requests return 401 without querying a client', async () => {
  let authorized = false;
  let authorizations = 0;
  let queries = 0;
  const client = { async getNowPlaying() { queries += 1; return snapshot(); } };
  const handler = createNowPlayingHandler({
    authorize() {
      authorizations += 1;
      return authorized ? client : null;
    },
  });

  await assertError(await handler(request()), 401, 'AUTH_REQUIRED');
  assert.equal(authorizations, 1);
  assert.equal(queries, 0);
  authorized = true;
  const response = await handler(request());
  assert.equal(response.status, 200);
  assertHeaders(response);
  assert.deepEqual(await response.json(), snapshot());
  assert.equal(authorizations, 2);
  assert.equal(queries, 1);
});

test('rechecks authorization rather than serving a previous successful snapshot', async () => {
  let authorized = true;
  let authorizations = 0;
  let queries = 0;
  const client = { async getNowPlaying() { queries += 1; return snapshot(); } };
  const handler = createNowPlayingHandler({
    authorize() {
      authorizations += 1;
      return authorized ? client : null;
    },
  });

  const first = await handler(request());
  assertHeaders(first);
  assert.deepEqual(await first.json(), snapshot());
  authorized = false;
  await assertError(await handler(request()), 401, 'AUTH_REQUIRED');
  assert.equal(authorizations, 2);
  assert.equal(queries, 1);
});

test('isolates concurrent users through the client returned for each request', async () => {
  const calls = [];
  const clients = new Map(['alice', 'bob'].map((id) => [id, {
    async getNowPlaying() {
      calls.push(id);
      return snapshot(id);
    },
  }]));
  let authorizations = 0;
  const handler = createNowPlayingHandler({
    async authorize(input) {
      authorizations += 1;
      return clients.get(input.headers.get('Cookie')) ?? null;
    },
  });

  const responses = await Promise.all(['alice', 'bob', 'alice'].map((id) => (
    handler(request({ headers: { Cookie: id } }))
  )));
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200);
    assertHeaders(response);
    assert.deepEqual(await response.json(), snapshot(index === 1 ? 'bob' : 'alice'));
  }
  assert.equal(authorizations, 3);
  assert.deepEqual(calls, ['alice', 'bob', 'alice']);
});

test('does not forward request paths, account selectors, query options, or credentials to the client', async () => {
  const input = new Request(
    'https://app.example/accounts/bob/player?account=bob&market=ES&fresh=true&path=https://untrusted.example&access_token=query-secret',
    { headers: { Cookie: 'alice', Authorization: 'Bearer request-secret' } },
  );
  let calls = 0;
  const handler = createNowPlayingHandler({
    authorize(received) {
      assert.equal(received, input);
      return {
        async getNowPlaying(options) {
          calls += 1;
          assert.deepEqual(options, { signal: input.signal });
          return snapshot('alice');
        },
      };
    },
  });

  const response = await handler(input);
  assertHeaders(response);
  assert.deepEqual(await response.json(), snapshot('alice'));
  assert.equal(calls, 1);
});

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
  test(`${method} returns a private 405 with Allow: GET without authorizing or querying`, async () => {
    let authorizations = 0;
    let queries = 0;
    const handler = createNowPlayingHandler({
      authorize() {
        authorizations += 1;
        return { async getNowPlaying() { queries += 1; return snapshot(); } };
      },
    });

    await assertError(await handler(request({ method })), 405, 'METHOD_NOT_ALLOWED', { allow: 'GET' });
    assert.equal(authorizations, 0);
    assert.equal(queries, 0);
  });
}

for (const [label, authorize] of [
  ['synchronous exception', () => { throw withPrivateDetails(new Error(privateDetails)); }],
  ['async rejection', async () => { throw withPrivateDetails(new Error(privateDetails)); }],
  ['typed caller error', () => { throw new SpotifyError('AUTH_REQUIRED', privateDetails, { status: 401 }); }],
  ['caller abort', () => { throw new DOMException(privateDetails, 'AbortError'); }],
  ['non-Error exception', () => { throw { code: privateDetails, snapshot: snapshot('private-snapshot') }; }],
]) {
  test(`authorization ${label} is a sanitized 500`, async () => {
    const handler = createNowPlayingHandler({ authorize });
    await assertError(await handler(request()), 500, 'INTERNAL_ERROR');
  });
}

test('forwards the request signal and returns a redacted 499 when the client aborts', async () => {
  const controller = new AbortController();
  const input = request({ signal: controller.signal });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const handler = createNowPlayingHandler({
    authorize: () => ({
      getNowPlaying(options) {
        assert.equal(options.signal, input.signal);
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          markStarted();
        });
      },
    }),
  });

  const pending = handler(input);
  await started;
  controller.abort(new DOMException(privateDetails, 'AbortError'));
  await assertError(await pending, 499, 'ABORTED');
});

test('authorizes even a pre-aborted request before passing its aborted signal to the client', async () => {
  const controller = new AbortController();
  controller.abort();
  const input = request({ signal: controller.signal });
  const events = [];
  const handler = createNowPlayingHandler({
    authorize() {
      events.push('authorize');
      return {
        async getNowPlaying({ signal }) {
          events.push('client');
          assert.equal(signal, input.signal);
          assert.equal(signal.aborted, true);
          throw signal.reason;
        },
      };
    },
  });

  await assertError(await handler(input), 499, 'ABORTED');
  assert.deepEqual(events, ['authorize', 'client']);
});

for (const [code, options, status] of [
  ['AUTH_REQUIRED', {}, 401],
  ['CONFIG', {}, 503],
  ['DESTROYED', {}, 503],
  ['STORAGE', {}, 503],
  ['TIMEOUT', {}, 504],
  ['RATE_LIMITED', {}, 429],
  ['QUOTA_EXCEEDED', {}, 429],
  ['HTTP', { status: 403 }, 403],
  ['HTTP', { status: 429 }, 429],
  ['HTTP', { status: 400 }, 502],
  ['HTTP', { status: 401 }, 502],
  ['HTTP', { status: 404 }, 502],
  ['HTTP', { status: 500 }, 502],
  ['HTTP', {}, 502],
  ['NETWORK', {}, 502],
  ['INVALID_RESPONSE', {}, 502],
  ['OAUTH_STATE', {}, 502],
  ['OAUTH_DENIED', {}, 502],
]) {
  test(`maps ${code} (${options.status ?? 'no upstream status'}) to ${status} without leaking failure details`, async () => {
    const error = withPrivateDetails(new SpotifyError(code, privateDetails, options));
    const handler = createNowPlayingHandler({
      authorize: () => ({ async getNowPlaying() { throw error; } }),
    });
    await assertError(await handler(request()), status, code);
  });
}

for (const code of ['RATE_LIMITED', 'QUOTA_EXCEEDED', 'HTTP']) {
  for (const [retryAfterMs, retryAfter] of [[0, '0'], [1, '1'], [1_000, '1'], [1_001, '2'], [3_600_001, '3601']]) {
    test(`${code} rounds Retry-After ${retryAfterMs}ms up to ${retryAfter} seconds`, async () => {
      const handler = createNowPlayingHandler({
        authorize: () => ({
          async getNowPlaying() {
            throw new SpotifyError(code, privateDetails, { status: 429, retryAfterMs });
          },
        }),
      });
      await assertError(await handler(request()), 429, code, { retryAfter });
    });
  }
}

for (const retryAfterMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE]) {
  test(`omits unusable Retry-After metadata (${retryAfterMs}) instead of inventing a reset`, async () => {
    const handler = createNowPlayingHandler({
      authorize: () => ({
        async getNowPlaying() {
          const options = retryAfterMs === undefined ? {} : { retryAfterMs };
          throw new SpotifyError('QUOTA_EXCEEDED', privateDetails, options);
        },
      }),
    });
    await assertError(await handler(request()), 429, 'QUOTA_EXCEEDED');
  });
}

test('does not attach Retry-After to a non-rate-limit response', async () => {
  const handler = createNowPlayingHandler({
    authorize: () => ({
      async getNowPlaying() {
        throw new SpotifyError('HTTP', privateDetails, { status: 503, retryAfterMs: 2_000 });
      },
    }),
  });
  await assertError(await handler(request()), 502, 'HTTP');
});

for (const [label, error] of [
  ['ordinary error', withPrivateDetails(new Error(privateDetails))],
  ['lookalike SpotifyError', { name: 'SpotifyError', code: 'AUTH_REQUIRED', status: 401, message: privateDetails }],
  ['unallowlisted code', Object.assign(new SpotifyError('HTTP', privateDetails), { code: privateDetails })],
  ['prototype name as code', Object.assign(new SpotifyError('HTTP', privateDetails), { code: 'constructor' })],
  ['string rejection', privateDetails],
  ['null rejection', null],
  ['undefined rejection', undefined],
]) {
  test(`sanitizes ${label} to a fixed 500 code`, async () => {
    const handler = createNowPlayingHandler({
      authorize: () => ({ async getNowPlaying() { throw error; } }),
    });
    await assertError(await handler(request()), 500, 'INTERNAL_ERROR');
  });
}

test('recognizes an Error named AbortError without exposing its message', async () => {
  const error = Object.assign(new Error(privateDetails), { name: 'AbortError' });
  const handler = createNowPlayingHandler({
    authorize: () => ({ async getNowPlaying() { throw error; } }),
  });
  await assertError(await handler(request()), 499, 'ABORTED');
});

for (const expected of [
  { status: 'empty', isPlaying: false, item: null, progressMs: null, timestamp: null, observedAt: 1 },
  { status: 'unavailable', isPlaying: false, item: null, progressMs: 100, timestamp: 1, observedAt: 2 },
  { ...snapshot(), isPlaying: false },
  { ...snapshot(), item: { ...snapshot().item, kind: 'local', id: null, uri: null, url: null } },
  {
    ...snapshot(),
    item: {
      kind: 'episode', id: 'episode', name: 'Episode', uri: null, url: null,
      durationMs: 1_000, explicit: false, isPlayable: null, images: [], show: null,
    },
  },
  { ...snapshot(), item: { kind: 'ad', type: 'ad' } },
  { ...snapshot(), item: { kind: 'unknown', type: 'future-media' } },
]) {
  test(`preserves the normalized ${expected.status}/${expected.item?.kind ?? 'null'}/${expected.isPlaying} payload`, async () => {
    const handler = createNowPlayingHandler({
      authorize: () => ({ async getNowPlaying() { return expected; } }),
    });
    const response = await handler(request());
    assert.equal(response.status, 200);
    assertHeaders(response);
    assert.deepEqual(await response.json(), expected);
  });
}

test('sanitizes serialization failures without returning a partial snapshot', async () => {
  const expected = { ...snapshot(), observedAt: 1n };
  const handler = createNowPlayingHandler({
    authorize: () => ({ async getNowPlaying() { return expected; } }),
  });
  await assertError(await handler(request()), 500, 'INTERNAL_ERROR');
});
