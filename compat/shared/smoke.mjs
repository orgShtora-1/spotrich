import { createSpotifyClient } from '@shtora/spotrich';
import { createNowPlayingHandler } from '@shtora/spotrich/http';
import { createMemoryTransactionStore, createSpotifyOAuth, createTokenProvider } from '@shtora/spotrich/oauth';

// Shared Web-only fixture. The harness copies it into each isolated consumer;
// package imports always resolve to node_modules installed from file:spotrich.tgz.
function check(condition, message) {
  if (!condition) throw new Error(`Fixture assertion: ${message}`);
}

export async function runSmoke({ forbidNodeGlobals = false } = {}) {
  const nodeGlobals = typeof globalThis.process !== 'undefined' || typeof globalThis.Buffer !== 'undefined';
  if (forbidNodeGlobals) check(!nodeGlobals, 'Node globals must be absent');
  const requestCounts = { playback: 0, token: 0 };
  const playbackFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    check(url.origin === 'https://api.spotify.com', 'official playback origin');
    check(new Headers(init?.headers).get('authorization') === 'Bearer fixture-access-only', 'injected account token');
    check(init?.signal instanceof AbortSignal, 'request cancellation signal');
    requestCounts.playback += 1;
    if (url.pathname === '/v1/me/player/recently-played') {
      return Response.json({ items: [], cursors: { after: null, before: null }, next: null });
    }
    check(['/v1/me/player/currently-playing', '/v1/me/player'].includes(url.pathname), 'official read endpoint');
    return new Response(null, { status: 204 });
  };
  const tokenFetch = async (input, init) => {
    check(String(input) === 'https://accounts.spotify.com/api/token', 'official token origin');
    check(init?.method === 'POST', 'token exchange POST');
    const params = new URLSearchParams(init.body);
    check(['authorization_code', 'refresh_token'].includes(params.get('grant_type')), 'OAuth grant type');
    check(params.get('client_id') === 'fixture-client', 'PKCE client id');
    requestCounts.token += 1;
    return Response.json({
      access_token: 'fixture-access-only', refresh_token: 'fixture-refresh-only',
      expires_in: 3600, token_type: 'Bearer', scope: 'user-read-currently-playing',
    });
  };
  const client = createSpotifyClient({
    auth: 'fixture-access-only', fetch: playbackFetch,
    cacheTtlMs: 60_000, maxRetries: 0,
  });
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => client.getNowPlaying()));
    check(results.every((snapshot) => snapshot.status === 'empty' && snapshot.item === null), '204 normalized empty');
    check(requestCounts.playback === 1, 'in-flight coalescing');
    await client.getNowPlaying();
    check(requestCounts.playback === 1, 'settled cache');
    const handler = createNowPlayingHandler({
      authorize: (request) => request.headers.get('x-fixture-auth') === 'allow' ? client : null,
    });
    const denied = await handler(new Request('https://fixture.example/api/now-playing'));
    check(denied.status === 401 && requestCounts.playback === 1, 'authorization before reads');
    const allowed = await handler(new Request('https://fixture.example/api/now-playing', {
      headers: { 'x-fixture-auth': 'allow' },
    }));
    check(allowed.status === 200 && (await allowed.json()).status === 'empty', 'Web HTTP adapter');
    check(allowed.headers.get('cache-control') === 'private, no-store', 'private response cache policy');
    check(!allowed.headers.has('access-control-allow-origin'), 'CORS is host-owned');
    check((await client.getPlaybackState()).playback.status === 'empty', 'player endpoint');
    check((await client.getRecentlyPlayed({ limit: 1 })).items.length === 0, 'history endpoint');
    check(requestCounts.playback === 3, 'three mocked endpoint calls');

    const oauth = createSpotifyOAuth({
      mode: 'pkce', clientId: 'fixture-client', redirectUri: 'https://fixture.example/callback',
      transactions: createMemoryTransactionStore(), fetch: tokenFetch,
    });
    const authorization = new URL(await oauth.getAuthorizationUrl({ sessionId: 'fixture-session' }));
    check(authorization.origin === 'https://accounts.spotify.com', 'authorization URL');
    check(authorization.searchParams.get('code_challenge_method') === 'S256', 'Web Crypto PKCE');
    check(Boolean(authorization.searchParams.get('code_challenge')), 'PKCE challenge exists');
    const callback = new URL('https://fixture.example/callback');
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'fixture-code-only');
    const tokens = await oauth.handleCallback({ url: callback, sessionId: 'fixture-session' });
    check(tokens.tokenType === 'Bearer' && tokens.refreshToken !== null, 'code exchange result');
    const provider = createTokenProvider({
      mode: 'pkce', clientId: 'fixture-client', refreshToken: 'fixture-refresh-only', fetch: tokenFetch,
    });
    const access = await Promise.all(Array.from({ length: 4 }, () => provider.getAccessToken()));
    check(access.every((token) => token === 'fixture-access-only'), 'refresh result');
    check(requestCounts.token === 2, 'code exchange plus singleflight refresh');
    check(client.getPollingStatus().subscribers === 0, 'on-demand edge/server handlers never subscribe');
    return { ok: true, requestCounts, nodeGlobals, transport: 'injected-only' };
  } finally { client.destroy(); }
}
