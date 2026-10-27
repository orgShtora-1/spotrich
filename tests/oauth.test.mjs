import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createSpotifyOAuth, createMemoryTransactionStore, createTokenProvider } from '../dist/oauth.js';

const NOW = 1_800_000_000_000;
const REDIRECT = 'https://app.example/callback?tenant=one';
const SESSION = 'session-one';
const CLIENT_ID = 'client-id';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(overrides = {}, status = 200) {
  return new Response(JSON.stringify({
    access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600,
    token_type: 'Bearer', scope: 'user-read-currently-playing', ...overrides,
  }), { status, headers: { 'content-type': 'application/json' } });
}

function expiredTokens(overrides = {}) {
  return {
    accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: NOW - 1,
    scope: ['user-read-currently-playing'], tokenType: 'Bearer', authorizedAt: NOW - 10_000,
    ...overrides,
  };
}

function tokenStore(initial = expiredTokens()) {
  const store = {
    value: initial, loads: 0, saves: [], clears: 0,
    async load() { store.loads += 1; return store.value; },
    async save(value) { store.saves.push(value); store.value = value; },
    async clear() { store.clears += 1; store.value = null; },
  };
  return store;
}

function hasCode(code) {
  return (error) => {
    assert.equal(error.name, 'SpotifyError');
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}

function isAbort(error) {
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, 'AbortError');
  return true;
}

function oauthFixture(options = {}) {
  let time = NOW;
  const records = [];
  const requests = [];
  const now = () => time;
  const memory = createMemoryTransactionStore({ now });
  const transactions = {
    async put(value) { records.push(value); await memory.put(value); },
    consume(value) { return memory.consume(value); },
  };
  const oauth = createSpotifyOAuth({
    mode: 'pkce', clientId: CLIENT_ID, redirectUri: REDIRECT, transactions, now,
    fetch: async (url, init) => { requests.push({ url, init }); return response(); }, ...options,
  });
  return { oauth, records, requests, transactions, setTime(value) { time = value; } };
}

async function callbackFor(oauth, { sessionId = SESSION, scopes, redirectUri = REDIRECT } = {}) {
  const input = scopes === undefined ? { sessionId } : { sessionId, scopes };
  const authorization = new URL(await oauth.getAuthorizationUrl(input));
  const callback = new URL(redirectUri);
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('code', 'authorization-code');
  return { authorization, callback };
}

function assertPost(request, grant) {
  assert.equal(request.url, 'https://accounts.spotify.com/api/token');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(new Headers(request.init.headers).get('content-type'), 'application/x-www-form-urlencoded');
  assert.ok(request.init.signal instanceof AbortSignal);
  const body = new URLSearchParams(request.init.body);
  assert.equal(body.get('grant_type'), grant);
  return { body, headers: new Headers(request.init.headers) };
}

test('PKCE stores host-only state before returning an S256 URL, then exchanges the verifier', async () => {
  const stored = deferred();
  const release = deferred();
  const fixture = oauthFixture({ transactions: {
    async put(value) { stored.resolve(value); await release.promise; await fixture.transactions.put(value); },
    consume(input) { return fixture.transactions.consume(input); },
  } });
  let returned = false;
  const pending = fixture.oauth.getAuthorizationUrl({ sessionId: SESSION }).then((value) => { returned = true; return value; });
  const transaction = await stored.promise;
  assert.equal(returned, false);
  assert.match(transaction.state, /^[A-Za-z\d_-]{43}$/);
  assert.match(transaction.codeVerifier, /^[A-Za-z\d._~-]{43,128}$/);
  assert.equal(transaction.sessionId, SESSION);
  assert.equal(transaction.clientId, CLIENT_ID);
  assert.equal(transaction.redirectUri, REDIRECT);
  assert.equal(transaction.expiresAt, NOW + 600_000);
  release.resolve();
  const authorization = new URL(await pending);
  assert.equal(authorization.origin + authorization.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(authorization.searchParams.get('scope'), 'user-read-currently-playing');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(authorization.searchParams.has('code_verifier'), false);
  assert.equal(authorization.href.includes(transaction.codeVerifier), false);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transaction.codeVerifier)));
  const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(authorization.searchParams.get('code_challenge'), expected);
  const callback = new URL(REDIRECT);
  callback.searchParams.set('code', 'authorization-code');
  callback.searchParams.set('state', transaction.state);
  const tokens = await fixture.oauth.handleCallback({ url: callback, sessionId: SESSION });
  const { body, headers } = assertPost(fixture.requests[0], 'authorization_code');
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.get('code_verifier'), transaction.codeVerifier);
  assert.equal(body.get('redirect_uri'), REDIRECT);
  assert.equal(body.get('code'), 'authorization-code');
  assert.equal(body.has('client_secret'), false);
  assert.equal(headers.has('authorization'), false);
  assert.deepEqual(tokens, {
    accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: NOW + 3_600_000,
    scope: ['user-read-currently-playing'], tokenType: 'Bearer', authorizedAt: NOW,
  });
  assert.ok(Object.isFrozen(tokens));
  assert.ok(Object.isFrozen(tokens.scope));
});

test('confidential code exchange uses Basic auth and never mixes in PKCE', async () => {
  const fixture = oauthFixture({ mode: 'confidential', clientSecret: 'server-secret' });
  const { authorization, callback } = await callbackFor(fixture.oauth, { scopes: ['user-read-playback-state', 'user-read-playback-state'] });
  assert.equal(authorization.searchParams.get('scope'), 'user-read-playback-state');
  assert.equal(authorization.searchParams.has('code_challenge'), false);
  assert.equal(authorization.searchParams.has('code_challenge_method'), false);
  assert.equal(authorization.href.includes('server-secret'), false);
  assert.equal(Object.hasOwn(fixture.records[0], 'codeVerifier'), false);
  await fixture.oauth.handleCallback({ url: callback.href, sessionId: SESSION });
  const { body, headers } = assertPost(fixture.requests[0], 'authorization_code');
  assert.equal(atob(headers.get('authorization').slice(6)), `${CLIENT_ID}:server-secret`);
  assert.equal(body.has('client_id'), false);
  assert.equal(body.has('client_secret'), false);
  assert.equal(body.has('code_verifier'), false);
});

test('state is cryptorandom per transaction and concurrent replay is consumed exactly once', async () => {
  const fixture = oauthFixture();
  const first = await callbackFor(fixture.oauth);
  const second = await callbackFor(fixture.oauth);
  assert.notEqual(first.authorization.searchParams.get('state'), second.authorization.searchParams.get('state'));
  const results = await Promise.allSettled([
    fixture.oauth.handleCallback({ url: first.callback, sessionId: SESSION }),
    fixture.oauth.handleCallback({ url: first.callback, sessionId: SESSION }),
  ]);
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1);
  hasCode('OAUTH_STATE')(results.find((entry) => entry.status === 'rejected').reason);
  assert.equal(fixture.requests.length, 1);
});

test('denial consumes valid state and does not expose error descriptions', async () => {
  const fixture = oauthFixture();
  const { callback } = await callbackFor(fixture.oauth);
  callback.searchParams.delete('code');
  callback.searchParams.set('error', 'access_denied');
  callback.searchParams.set('error_description', 'secret https://private.example/token');
  await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), (error) => {
    hasCode('OAUTH_DENIED')(error);
    assert.equal(String(error).includes('private.example'), false);
    return true;
  });
  await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
  assert.equal(fixture.requests.length, 0);
});

test('missing, wrong and wrong-session state fail without consuming the rightful transaction', async () => {
  const fixture = oauthFixture();
  const { callback } = await callbackFor(fixture.oauth);
  const wrong = new URL(callback);
  wrong.searchParams.set('state', 'not-the-state');
  await assert.rejects(fixture.oauth.handleCallback({ url: wrong, sessionId: SESSION }), hasCode('OAUTH_STATE'));
  wrong.searchParams.delete('state');
  await assert.rejects(fixture.oauth.handleCallback({ url: wrong, sessionId: SESSION }), hasCode('OAUTH_STATE'));
  await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: 'other-session' }), hasCode('OAUTH_STATE'));
  await fixture.oauth.handleCallback({ url: callback, sessionId: SESSION });
  assert.equal(fixture.requests.length, 1);
});

test('transaction expires at the exact TTL boundary', async () => {
  const fixture = oauthFixture({ transactionTtlMs: 100 });
  const { callback } = await callbackFor(fixture.oauth);
  fixture.setTime(NOW + 100);
  await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
  assert.equal(fixture.requests.length, 0);
});

for (const parameter of ['state', 'code', 'error']) {
  test(`duplicate ${parameter} is rejected before token exchange`, async () => {
    const fixture = oauthFixture();
    const { callback } = await callbackFor(fixture.oauth);
    if (parameter === 'error') {
      callback.searchParams.delete('code');
      callback.searchParams.append('error', 'access_denied');
    }
    callback.searchParams.append(parameter, callback.searchParams.get(parameter));
    await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
    assert.equal(fixture.requests.length, 0);
  });
}

for (const mutation of [
  (url) => { url.hostname = 'attacker.example'; },
  (url) => { url.pathname = '/other'; },
  (url) => { url.searchParams.delete('tenant'); },
  (url) => { url.searchParams.append('tenant', 'one'); },
  (url) => { url.searchParams.set('tenant', 'two'); },
  (url) => { url.searchParams.set('unexpected', 'one'); },
  (url) => { url.hash = 'fragment'; },
  (url) => { url.username = 'user'; },
]) {
  test(`callback requires exact redirect binding: ${mutation.toString()}`, async () => {
    const fixture = oauthFixture();
    const { callback } = await callbackFor(fixture.oauth);
    mutation(callback);
    await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
    assert.equal(fixture.requests.length, 0);
  });
}

test('malformed responses with valid state consume that state too', async () => {
  for (const outcome of ['missing-code', 'code-and-error']) {
    const fixture = oauthFixture();
    const { callback } = await callbackFor(fixture.oauth);
    if (outcome === 'missing-code') callback.searchParams.delete('code');
    else callback.searchParams.set('error', 'access_denied');
    await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
    callback.searchParams.delete('error');
    callback.searchParams.set('code', 'restored-code');
    await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
    assert.equal(fixture.requests.length, 0);
  }
});

test('stored transaction is independently checked for session, state, client, redirect, flow and expiry', async () => {
  for (const patch of [
    { sessionId: 'another-session' }, { state: 'another-state' }, { clientId: 'another-client' },
    { redirectUri: 'https://attacker.example/callback' }, { mode: 'confidential' },
    { expiresAt: NOW }, { codeVerifier: 'too-short' },
  ]) {
    let captured;
    const fixture = oauthFixture({ transactions: {
      async put(value) { captured = value; },
      async consume() { return { ...captured, ...patch }; },
    } });
    const { callback } = await callbackFor(fixture.oauth);
    await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
    assert.equal(fixture.requests.length, 0);
  }
});

test('redirect configuration accepts HTTPS or explicit HTTP loopback IPs only', async () => {
  for (const redirectUri of ['https://app.example/callback', 'http://127.0.0.1:4321/callback', 'http://127.12.3.4/cb', 'http://[::1]:4321/callback', 'http://[0:0:0:0:0:0:0:1]/callback']) {
    const fixture = oauthFixture({ redirectUri });
    const { callback } = await callbackFor(fixture.oauth, { redirectUri });
    await fixture.oauth.handleCallback({ url: callback, sessionId: SESSION });
  }
  for (const redirectUri of [
    'http://app.example/callback', 'http://localhost/callback', 'https://localhost/callback',
    'https://localhost./callback', 'https://sub.localhost/callback', 'http://192.168.0.1/callback',
    'http://127.1/callback', 'http://2130706433/callback', 'https://user:pass@app.example/callback',
    'https://@app.example/callback', 'https://app.example/callback#', 'https://app.example/callback#fragment',
    'https://app.example/callback?state=static', 'https://app.example/\ncallback', 'https:////app.example/callback',
    'https://app.example\\callback', '/relative',
  ]) assert.throws(() => oauthFixture({ redirectUri }), hasCode('CONFIG'));
});

test('memory store prunes expired entries, bounds capacity, and never overwrites live state', async () => {
  let time = NOW;
  const transactions = createMemoryTransactionStore({ now: () => time, maxEntries: 1 });
  const fixture = oauthFixture({ transactions, now: () => time, transactionTtlMs: 100 });
  const first = await callbackFor(fixture.oauth);
  await assert.rejects(fixture.oauth.getAuthorizationUrl({ sessionId: SESSION }), hasCode('STORAGE'));
  time += 100;
  const second = await callbackFor(fixture.oauth);
  await assert.rejects(fixture.oauth.handleCallback({ url: first.callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
  await fixture.oauth.handleCallback({ url: second.callback, sessionId: SESSION });
  const transaction = { mode: 'confidential', sessionId: 'a', state: 'b', clientId: CLIENT_ID,
    redirectUri: REDIRECT, scopes: [], expiresAt: time + 100 };
  await transactions.put(transaction);
  await assert.rejects(transactions.put({ ...transaction, clientId: 'other' }), hasCode('STORAGE'));
  assert.equal((await transactions.consume({ sessionId: 'a', state: 'b' })).clientId, CLIENT_ID);
  assert.equal(await transactions.consume({ sessionId: 'a', state: 'b' }), null);
});

test('OAuth store failures are sanitized and no authorization URL or exchange escapes', async () => {
  let calls = 0;
  const failure = new Error('secret-code https://private.example/callback');
  const fixture = oauthFixture({ transactions: {
    async put() { throw failure; }, async consume() { throw failure; },
  }, fetch: async () => { calls += 1; return response(); } });
  const check = (error) => { hasCode('STORAGE')(error); assert.equal(String(error).includes('private.example'), false); return true; };
  await assert.rejects(fixture.oauth.getAuthorizationUrl({ sessionId: SESSION }), check);
  await assert.rejects(fixture.oauth.handleCallback({ url: `${REDIRECT}&state=x&code=y`, sessionId: SESSION }), check);
  assert.equal(calls, 0);
});

test('refresh-only seed is private and uses PKCE refresh wire format', async () => {
  const requests = [];
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh', now: () => NOW,
    fetch: async (url, init) => { requests.push({ url, init }); return response(); } });
  assert.equal(await provider.getAccessToken(), 'access-new');
  assert.equal(await provider.getAccessToken(), 'access-new');
  assert.equal(requests.length, 1);
  const { body, headers } = assertPost(requests[0], 'refresh_token');
  assert.equal(body.get('refresh_token'), 'seed-refresh');
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.has('code_verifier'), false);
  assert.equal(headers.has('authorization'), false);
  assert.deepEqual(Object.keys(provider), ['getAccessToken']);
});

test('confidential refresh uses Basic authentication without client_id or PKCE fields', async () => {
  const requests = [];
  const provider = createTokenProvider({ mode: 'confidential', clientId: CLIENT_ID, clientSecret: 'server-secret',
    refreshToken: 'seed-refresh', now: () => NOW,
    fetch: async (url, init) => { requests.push({ url, init }); return response(); } });
  await provider.getAccessToken();
  const { body, headers } = assertPost(requests[0], 'refresh_token');
  assert.equal(atob(headers.get('authorization').slice(6)), `${CLIENT_ID}:server-secret`);
  assert.equal(body.has('client_id'), false);
  assert.equal(body.has('client_secret'), false);
  assert.equal(body.has('code_verifier'), false);
});

test('refresh-only rotation feeds the next POST and omission retains that rotated credential', async () => {
  const requests = [];
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh', now: () => NOW,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return requests.length === 1 ? response() : response({ access_token: `access-${requests.length}`, refresh_token: undefined });
    } });
  assert.equal(await provider.getAccessToken(), 'access-new');
  assert.equal(await provider.getAccessToken({ rejectedAccessToken: 'access-new' }), 'access-2');
  assert.equal(await provider.getAccessToken({ rejectedAccessToken: 'access-2' }), 'access-3');
  assert.deepEqual(requests.map(({ init }) => new URLSearchParams(init.body).get('refresh_token')),
    ['seed-refresh', 'refresh-new', 'refresh-new']);
});

test('rotation is persisted before success and preserves the initial authorization time', async () => {
  const store = tokenStore();
  const saving = deferred();
  const release = deferred();
  store.save = async (value) => { saving.resolve(value); await release.promise; store.value = value; };
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW, fetch: async () => response() });
  let settled = false;
  const result = provider.getAccessToken().then((value) => { settled = true; return value; });
  const saved = await saving.promise;
  assert.equal(settled, false);
  assert.equal(store.value, null);
  assert.equal(saved.refreshToken, 'refresh-new');
  assert.equal(saved.authorizedAt, NOW - 10_000);
  assert.equal(saved.expiresAt, NOW + 3_600_000);
  assert.ok(Object.isFrozen(saved));
  release.resolve();
  assert.equal(await result, 'access-new');
  assert.equal(store.value.refreshToken, 'refresh-new');
});

test('omitted refresh token and scope retain their previously granted values', async () => {
  const store = tokenStore();
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW,
    fetch: async () => response({ refresh_token: undefined, scope: undefined }) });
  await provider.getAccessToken();
  assert.equal(store.value.refreshToken, 'refresh-old');
  assert.deepEqual(store.value.scope, ['user-read-currently-playing']);
  assert.equal(store.value.authorizedAt, NOW - 10_000);
});

test('valid stored tokens need no POST and missing refresh credentials require authorization', async () => {
  let calls = 0;
  const store = tokenStore(expiredTokens({ expiresAt: NOW + 1000, refreshToken: null }));
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW,
    fetch: async () => { calls += 1; return response(); } });
  assert.equal(await provider.getAccessToken(), 'access-old');
  await assert.rejects(provider.getAccessToken({ rejectedAccessToken: 'access-old' }), hasCode('AUTH_REQUIRED'));
  assert.equal(calls, 0);
});

test('invalid_grant clears persisted credentials and remains terminal without retry', async () => {
  const store = tokenStore();
  let calls = 0;
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW,
    fetch: async () => { calls += 1; return response({ error: 'invalid_grant', error_description: 'refresh-old revoked' }, 400); } });
  await assert.rejects(provider.getAccessToken(), hasCode('AUTH_REQUIRED'));
  await assert.rejects(provider.getAccessToken(), hasCode('AUTH_REQUIRED'));
  assert.equal(store.clears, 1);
  assert.equal(store.value, null);
  assert.equal(store.saves.length, 0);
  assert.equal(calls, 1);
});

test('refresh-only invalid_grant is terminal too', async () => {
  let calls = 0;
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh',
    fetch: async () => { calls += 1; return response({ error: 'invalid_grant' }, 400); } });
  await assert.rejects(provider.getAccessToken(), hasCode('AUTH_REQUIRED'));
  await assert.rejects(provider.getAccessToken(), hasCode('AUTH_REQUIRED'));
  assert.equal(calls, 1);
});

for (const method of ['load', 'save', 'clear']) {
  test(`TokenStore ${method} failures fail closed with sanitized STORAGE`, async () => {
    const store = tokenStore();
    store[method] = async () => { throw new Error('refresh-old server-secret https://private.example'); };
    let calls = 0;
    const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW,
      fetch: async () => { calls += 1; return method === 'clear' ? response({ error: 'invalid_grant' }, 400) : response(); } });
    const check = (error) => {
      hasCode('STORAGE')(error);
      assert.doesNotMatch(String(error), /refresh-old|server-secret|private\.example/);
      return true;
    };
    await assert.rejects(provider.getAccessToken(), check);
    await assert.rejects(provider.getAccessToken(), check);
    assert.equal(calls, method === 'save' ? 1 : 0);
  });
}

test('invalid persisted TokenSet is a STORAGE failure, not an accepted refresh-only seed', async () => {
  for (const value of [{ refreshToken: 'refresh-old' }, expiredTokens({ tokenType: 'MAC' }), expiredTokens({ expiresAt: Infinity })]) {
    const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store: tokenStore(value),
      fetch: async () => { assert.fail('must not send invalid storage'); } });
    await assert.rejects(provider.getAccessToken(), hasCode('STORAGE'));
  }
});

test('all concurrent callers share one refresh', async () => {
  const requested = deferred();
  const release = deferred();
  let calls = 0;
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh', now: () => NOW,
    fetch: async () => { calls += 1; requested.resolve(); return release.promise; } });
  const results = Array.from({ length: 20 }, () => provider.getAccessToken());
  await requested.promise;
  assert.equal(calls, 1);
  release.resolve(response());
  assert.deepEqual(await Promise.all(results), Array(20).fill('access-new'));
});

test('staggered 401s reuse the newer token instead of rotating twice', async () => {
  const store = tokenStore(expiredTokens({ expiresAt: NOW + 3600_000 }));
  const requested = deferred();
  const release = deferred();
  let calls = 0;
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW,
    fetch: async () => { calls += 1; requested.resolve(); return release.promise; } });
  assert.equal(await provider.getAccessToken(), 'access-old');
  const refreshed = provider.getAccessToken({ rejectedAccessToken: 'access-old' });
  await requested.promise;
  const concurrent = provider.getAccessToken();
  const rejected = provider.getAccessToken({ rejectedAccessToken: 'access-old' });
  release.resolve(response());
  assert.deepEqual(await Promise.all([refreshed, concurrent, rejected]), ['access-new', 'access-new', 'access-new']);
  assert.equal(await provider.getAccessToken({ rejectedAccessToken: 'access-old' }), 'access-new');
  assert.equal(calls, 1);
});

test('a 401 joining an initial token load does not accidentally reuse its rejected token', async () => {
  const store = tokenStore(expiredTokens({ expiresAt: NOW + 3600_000 }));
  const loading = deferred();
  const release = deferred();
  store.load = async () => { loading.resolve(); await release.promise; return store.value; };
  let calls = 0;
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW,
    fetch: async () => { calls += 1; return response(); } });
  const initial = provider.getAccessToken();
  await loading.promise;
  const rejected = provider.getAccessToken({ rejectedAccessToken: 'access-old' });
  release.resolve();
  assert.equal(await initial, 'access-old');
  assert.equal(await rejected, 'access-new');
  assert.equal(calls, 1);
});

test('host lock serializes load/refresh/save and another provider reloads after rotation', async () => {
  const store = tokenStore();
  const saving = deferred();
  const release = deferred();
  store.save = async (value) => { saving.resolve(); await release.promise; store.value = value; store.saves.push(value); };
  let queue = Promise.resolve();
  const withRefreshLock = (operation) => {
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  };
  let calls = 0;
  const options = { mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW, withRefreshLock,
    fetch: async () => { calls += 1; return response(); } };
  const first = createTokenProvider(options).getAccessToken();
  await saving.promise;
  const second = createTokenProvider(options).getAccessToken();
  assert.equal(store.loads, 1);
  assert.equal(calls, 1);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['access-new', 'access-new']);
  assert.equal(store.loads, 2);
  assert.equal(calls, 1);
  assert.equal(store.saves.length, 1);
});

test('lock failures are sanitized STORAGE, including a failure after a persisted rotation', async () => {
  for (const after of [false, true]) {
    const store = tokenStore();
    let calls = 0;
    const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW,
      withRefreshLock: async (operation) => { if (after) await operation(); throw new Error('server-secret'); },
      fetch: async () => { calls += 1; return response(); } });
    await assert.rejects(provider.getAccessToken(), hasCode('STORAGE'));
    await assert.rejects(provider.getAccessToken(), hasCode('STORAGE'));
    assert.equal(calls, after ? 1 : 0);
  }
});

test('externally cleared store cannot fall back to a previously cached refresh token', async () => {
  const store = tokenStore();
  let time = NOW;
  let calls = 0;
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => time,
    fetch: async () => { calls += 1; return response(); } });
  await provider.getAccessToken();
  store.value = null;
  time += 3600_000;
  await assert.rejects(provider.getAccessToken(), hasCode('AUTH_REQUIRED'));
  assert.equal(calls, 1);
});

test('one caller cancellation detaches only that caller and cleans up listeners', async () => {
  const requested = deferred();
  const release = deferred();
  let transportSignal;
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh', now: () => NOW,
    fetch: async (_url, init) => { transportSignal = init.signal; requested.resolve(); return release.promise; } });
  const first = new AbortController();
  const second = new AbortController();
  const cancelled = provider.getAccessToken({ signal: first.signal });
  const cancelledCheck = assert.rejects(cancelled, isAbort);
  const survivor = provider.getAccessToken({ signal: second.signal });
  await requested.promise;
  assert.equal(getEventListeners(first.signal, 'abort').length, 1);
  first.abort(new Error('sensitive abort reason'));
  await cancelledCheck;
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  assert.equal(transportSignal.aborted, false);
  release.resolve(response());
  assert.equal(await survivor, 'access-new');
  assert.equal(getEventListeners(second.signal, 'abort').length, 0);
});

test('all callers may cancel but dispatched rotation still persists before a later caller succeeds', async () => {
  const requested = deferred();
  const releaseFetch = deferred();
  const saving = deferred();
  const releaseSave = deferred();
  const store = tokenStore();
  store.save = async (tokens) => { saving.resolve(tokens); await releaseSave.promise; store.value = tokens; };
  let calls = 0;
  let transportSignal;
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, store, now: () => NOW,
    fetch: async (_url, init) => { calls += 1; transportSignal = init.signal; requested.resolve(); return releaseFetch.promise; } });
  const controller = new AbortController();
  const first = provider.getAccessToken({ signal: controller.signal });
  const cancelled = assert.rejects(first, isAbort);
  await requested.promise;
  controller.abort();
  await cancelled;
  assert.equal(transportSignal.aborted, false);
  releaseFetch.resolve(response());
  const replacement = await saving.promise;
  assert.equal(replacement.refreshToken, 'refresh-new');
  let returned = false;
  const later = provider.getAccessToken().then((value) => { returned = true; return value; });
  assert.equal(returned, false);
  assert.equal(store.value, null);
  releaseSave.resolve();
  assert.equal(await later, 'access-new');
  assert.equal(store.value.refreshToken, 'refresh-new');
  assert.equal(calls, 1);
});

test('pre-aborted refresh and callback never dispatch requests or consume state', async () => {
  const controller = new AbortController();
  controller.abort('do-not-leak');
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh',
    fetch: async () => { assert.fail('pre-aborted request must not dispatch'); } });
  await assert.rejects(provider.getAccessToken({ signal: controller.signal }), isAbort);
  const fixture = oauthFixture();
  const { callback } = await callbackFor(fixture.oauth);
  await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION, signal: controller.signal }), isAbort);
  await fixture.oauth.handleCallback({ url: callback, sessionId: SESSION });
  assert.equal(fixture.requests.length, 1);
});

test('callback abort during a POST is standard AbortError and never leaks the abort reason', async () => {
  const requested = deferred();
  const controller = new AbortController();
  let transportSignal;
  const fixture = oauthFixture({ fetch: async (_url, init) => {
    transportSignal = init.signal;
    requested.resolve();
    return new Promise(() => {});
  } });
  const { callback } = await callbackFor(fixture.oauth);
  const pending = fixture.oauth.handleCallback({ url: callback, sessionId: SESSION, signal: controller.signal });
  const result = assert.rejects(pending, isAbort);
  await requested.promise;
  controller.abort('secret-abort-reason');
  await result;
  assert.equal(transportSignal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('timeout covers a hanging response body and cannot blindly repeat an ambiguous refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let transportSignal;
  const bodyStarted = deferred();
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh', timeoutMs: 100,
    fetch: async (_url, init) => {
      calls += 1;
      transportSignal = init.signal;
      return new Response(new ReadableStream({ pull() { bodyStarted.resolve(); } }));
    } });
  const pending = provider.getAccessToken();
  const check = assert.rejects(pending, hasCode('TIMEOUT'));
  await bodyStarted.promise;
  t.mock.timers.tick(100);
  await check;
  assert.equal(transportSignal.aborted, true);
  await assert.rejects(provider.getAccessToken(), hasCode('TIMEOUT'));
  assert.equal(calls, 1);
});

test('timeout also bounds a fetch implementation that ignores its abort signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested = deferred();
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh', timeoutMs: 25,
    fetch: async () => { requested.resolve(); return new Promise(() => {}); } });
  const result = assert.rejects(provider.getAccessToken(), hasCode('TIMEOUT'));
  await requested.promise;
  t.mock.timers.tick(25);
  await result;
});

test('token POST HTTP failures never retry and expose only fixed metadata', async () => {
  for (const status of [400, 401, 429, 500, 503]) {
    let calls = 0;
    const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh',
      fetch: async () => { calls += 1; return response({ error: 'server-secret', error_description: 'https://private.example/seed-refresh' }, status); } });
    await assert.rejects(provider.getAccessToken(), (error) => {
      hasCode(status === 429 ? 'RATE_LIMITED' : 'HTTP')(error);
      assert.equal(error.status, status);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /server-secret|seed-refresh|private\.example/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('failed code exchange never retries and consumed authorization state cannot be reused', async () => {
  let calls = 0;
  const fixture = oauthFixture({ fetch: async () => { calls += 1; return response({ error_description: 'secret-code' }, 503); } });
  const { callback } = await callbackFor(fixture.oauth);
  await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('HTTP'));
  await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('OAUTH_STATE'));
  assert.equal(calls, 1);
});

test('network and malformed token failures are sanitized and fail closed after possible rotation', async () => {
  for (const [fetcher, code] of [
    [async () => { throw new Error('server-secret seed-refresh https://private.example'); }, 'NETWORK'],
    [async () => new Response('server-secret seed-refresh'), 'INVALID_RESPONSE'],
    [async () => response({ expires_in: '3600' }), 'INVALID_RESPONSE'],
    [async () => response({ expires_in: 0 }), 'INVALID_RESPONSE'],
    [async () => response({ access_token: '' }), 'INVALID_RESPONSE'],
    [async () => response({ refresh_token: null }), 'INVALID_RESPONSE'],
    [async () => response({ token_type: 'MAC' }), 'INVALID_RESPONSE'],
    [async () => response({ scope: 'invalid\nscope' }), 'INVALID_RESPONSE'],
  ]) {
    let calls = 0;
    const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh',
      fetch: async (...args) => { calls += 1; return fetcher(...args); } });
    const check = (error) => {
      hasCode(code)(error);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /server-secret|seed-refresh|private\.example/);
      return true;
    };
    await assert.rejects(provider.getAccessToken(), check);
    await assert.rejects(provider.getAccessToken(), check);
    assert.equal(calls, 1);
  }
});

test('failed provider requests remove abort listeners too', async () => {
  const controller = new AbortController();
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh',
    fetch: async () => response({ error: 'invalid_grant' }, 400) });
  await assert.rejects(provider.getAccessToken({ signal: controller.signal }), hasCode('AUTH_REQUIRED'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('configuration enforces credential modes, refresh source XOR, scopes and positive bounds', async () => {
  for (const options of [
    { mode: 'pkce', clientSecret: 'secret' }, { mode: 'confidential' }, { mode: 'confidential', clientSecret: '' },
    { mode: 'unknown' }, { clientId: '' }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { transactionTtlMs: 0 },
  ]) assert.throws(() => oauthFixture(options), hasCode('CONFIG'));
  const defaults = { mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh' };
  for (const options of [
    { ...defaults, store: tokenStore() }, { mode: 'pkce', clientId: CLIENT_ID },
    { ...defaults, refreshToken: '' }, { ...defaults, mode: 'confidential' },
    { ...defaults, withRefreshLock: 'not-a-lock' }, { ...defaults, store: {}, refreshToken: undefined },
  ]) assert.throws(() => createTokenProvider(options), hasCode('CONFIG'));
  assert.throws(() => createMemoryTransactionStore({ maxEntries: 0 }), hasCode('CONFIG'));
  const fixture = oauthFixture();
  await assert.rejects(fixture.oauth.getAuthorizationUrl({ sessionId: '' }), hasCode('CONFIG'));
  await assert.rejects(fixture.oauth.getAuthorizationUrl({ sessionId: SESSION, scopes: ['bad scope'] }), hasCode('CONFIG'));
});

test('browser guard blocks state, credential exchange and refresh even after construction', async () => {
  const fixture = oauthFixture();
  const { callback } = await callbackFor(fixture.oauth);
  const provider = createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh',
    fetch: async () => { assert.fail('browser refresh must not dispatch'); } });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  try {
    assert.throws(() => oauthFixture(), hasCode('CONFIG'));
    assert.throws(() => oauthFixture({ mode: 'confidential', clientSecret: 'server-secret' }), hasCode('CONFIG'));
    assert.throws(() => createTokenProvider({ mode: 'pkce', clientId: CLIENT_ID, refreshToken: 'seed-refresh' }), hasCode('CONFIG'));
    assert.throws(() => createMemoryTransactionStore(), hasCode('CONFIG'));
    await assert.rejects(provider.getAccessToken(), hasCode('CONFIG'));
    await assert.rejects(fixture.oauth.getAuthorizationUrl({ sessionId: SESSION }), hasCode('CONFIG'));
    await assert.rejects(fixture.oauth.handleCallback({ url: callback, sessionId: SESSION }), hasCode('CONFIG'));
  } finally {
    if (descriptor === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', descriptor);
  }
  assert.equal(fixture.requests.length, 0);
});
