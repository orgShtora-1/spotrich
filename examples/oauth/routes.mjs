import { SpotifyError } from '@shtora/spotrich';
import { createSpotifyOAuth } from '@shtora/spotrich/oauth';
import { oauthCredentials, requiredEnv } from '../shared/env.mjs';

function response(status, payload, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Vary', 'Cookie, Authorization');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (payload === null) return new Response(null, { status, headers });
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(payload), { status, headers });
}

function failure(error) {
  if (error instanceof Error && error.name === 'AbortError') {
    return response(499, { error: { code: 'ABORTED' } });
  }
  if (!(error instanceof SpotifyError)) {
    return response(500, { error: { code: 'INTERNAL_ERROR' } });
  }
  const status = error.code === 'OAUTH_STATE' ? 400
    : error.code === 'OAUTH_DENIED' ? 403
    : error.code === 'AUTH_REQUIRED' ? 401
    : error.code === 'RATE_LIMITED' ? 429
    : error.code === 'CONFIG' || error.code === 'STORAGE' ? 503
    : error.code === 'TIMEOUT' ? 504 : 502;
  return response(status, { error: { code: error.code } });
}

// No built-in session or in-memory production store. The host must implement:
// authorizeLinkStart(Request) -> authenticated session|null after Origin/CSRF;
// getSession(Request) -> the SAME authenticated host session|null on callback;
// tokenStoreForSession(session) -> durable TokenStore bound to its user/grant;
// withSessionGrantLock(session, operation) -> durable lock shared by all writers.
export function createOAuthRoutes({ env, host, transactions }) {
  const oauth = createSpotifyOAuth({
    ...oauthCredentials(env),
    redirectUri: requiredEnv(env, 'SPOTIFY_REDIRECT_URI'),
    transactions,
  });
  // Trusted operator config, never a returnTo/Host/query supplied by a requester.
  const successUrl = new URL('/settings/integrations', requiredEnv(env, 'APP_ORIGIN'));

  return {
    async start(request) {
      if (request.method !== 'POST') {
        return response(405, { error: { code: 'METHOD_NOT_ALLOWED' } }, { Allow: 'POST' });
      }
      try {
        const session = await host.authorizeLinkStart(request);
        if (session === null) return response(401, { error: { code: 'AUTH_REQUIRED' } });
        const location = await oauth.getAuthorizationUrl({
          sessionId: session.id,
          scopes: ['user-read-currently-playing'],
        });
        return response(303, null, { Location: location });
      } catch (error) {
        return failure(error);
      }
    },
    async callback(request) {
      if (request.method !== 'GET') {
        return response(405, { error: { code: 'METHOD_NOT_ALLOWED' } }, { Allow: 'GET' });
      }
      try {
        const session = await host.getSession(request);
        if (session === null) return response(401, { error: { code: 'AUTH_REQUIRED' } });
        const tokens = await oauth.handleCallback({
          url: request.url, sessionId: session.id, signal: request.signal,
        });
        try {
          await host.withSessionGrantLock(session, async () => {
            const store = await host.tokenStoreForSession(session);
            await store.save(tokens); // Await durable commit; never return tokens to browser.
          });
        } catch {
          throw new SpotifyError('STORAGE', 'The host could not persist the authorization.');
        }
        return response(303, null, { Location: successUrl.href });
      } catch (error) {
        return failure(error); // Never log callback URL, upstream body or credentials.
      }
    },
  };
}
