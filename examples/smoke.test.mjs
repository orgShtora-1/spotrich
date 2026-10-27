import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './workers/worker.mjs';
import { GET as nextGET } from './next/route.mjs';
import { GET as vercelGET } from './vercel/now-playing.mjs';
import { createPrivateNowPlayingHandler } from './web/handler.mjs';
import { requiredEnv } from './shared/env.mjs';

// Recognized by both test runners; no credentials, Spotify request or deploy.
for (const [name, handle] of [
  ['Workers module', (request) => worker.fetch(request, {})],
  ['Next route module', nextGET],
  ['Vercel module', vercelGET],
]) {
  test(`${name}: default host denies access, including account selectors`, async () => {
    const request = new Request('http://127.0.0.1/api/now-playing?account=not-an-authorization');
    const result = await handle(request);
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await result.json(), { error: { code: 'AUTH_REQUIRED' } });
  });
}

test('unauthorized requests do not load account tokens or acquire locks', async () => {
  const handle = createPrivateNowPlayingHandler({
    env: {},
    host: {
      authorizeRequest: () => null,
      tokenStoreFor: () => assert.fail('An unauthorized request must not load tokens.'),
      withGrantLock: () => assert.fail('An unauthorized request must not acquire a grant lock.'),
    },
  });
  assert.equal((await handle(new Request('http://127.0.0.1/api/now-playing'))).status, 401);
});

test('store selection follows the trusted host grant, never a query account', async () => {
  const selected = [];
  const trustedGrants = ['internal-fixture-A', 'internal-fixture-B'];
  const handle = createPrivateNowPlayingHandler({
    env: {},
    host: {
      // Synthetic host decisions, not a header/query authentication recipe.
      authorizeRequest: () => trustedGrants.shift(),
      tokenStoreFor: (grantKey) => {
        selected.push(grantKey);
        throw new Error('Fixture stops before credentials or network are used.');
      },
    },
  });
  for (let index = 0; index < 2; index += 1) {
    const result = await handle(new Request('http://127.0.0.1/api/now-playing?account=untrusted'));
    assert.equal(result.status, 500);
    assert.deepEqual(await result.json(), { error: { code: 'INTERNAL_ERROR' } });
  }
  assert.deepEqual(selected, ['internal-fixture-A', 'internal-fixture-B']);
});

test('non-GET requests are rejected before the authorization boundary', async () => {
  const handle = createPrivateNowPlayingHandler({
    env: {}, host: { authorizeRequest: () => assert.fail('Method must be checked first.') },
  });
  const result = await handle(new Request('http://127.0.0.1/api/now-playing', { method: 'POST' }));
  assert.equal(result.status, 405);
  assert.equal(result.headers.get('Allow'), 'GET');
});

test('placeholder configuration fails without disclosing its value', () => {
  assert.throws(
    () => requiredEnv({ SPOTIFY_CLIENT_ID: 'replace_with_registered_client_id' }, 'SPOTIFY_CLIENT_ID'),
    { message: 'Configure SPOTIFY_CLIENT_ID privately on the server.' },
  );
});
