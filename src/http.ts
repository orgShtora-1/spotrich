import { SpotifyError, type SpotifyErrorCode } from './errors.js';
import type { SpotifyClient } from './types.js';

export interface NowPlayingHandlerOptions {
  /** Host-owned session, account, and Origin/CSRF authorization. */
  readonly authorize: (request: Request) => Promise<SpotifyClient | null> | SpotifyClient | null;
}

const spotifyErrorCodes: ReadonlySet<string> = new Set<SpotifyErrorCode>([
  'CONFIG',
  'AUTH_REQUIRED',
  'OAUTH_STATE',
  'OAUTH_DENIED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'HTTP',
  'NETWORK',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'DESTROYED',
  'STORAGE',
]);

type HandlerErrorCode = SpotifyErrorCode | 'METHOD_NOT_ALLOWED' | 'ABORTED' | 'INTERNAL_ERROR';

function jsonResponse(payload: unknown, status: number, additionalHeaders?: HeadersInit): Response {
  const headers = new Headers(additionalHeaders);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Type', 'application/json');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Vary', 'Cookie, Authorization');
  return new Response(JSON.stringify(payload), { status, headers });
}

function errorResponse(code: HandlerErrorCode, status: number, headers?: HeadersInit): Response {
  return jsonResponse({ error: { code } }, status, headers);
}

function clientErrorResponse(error: unknown): Response {
  if (error instanceof Error && error.name === 'AbortError') {
    return errorResponse('ABORTED', 499);
  }
  if (!(error instanceof SpotifyError) || !spotifyErrorCodes.has(error.code)) {
    return errorResponse('INTERNAL_ERROR', 500);
  }

  let status: number;
  switch (error.code) {
    case 'AUTH_REQUIRED':
      status = 401;
      break;
    case 'CONFIG':
    case 'DESTROYED':
    case 'STORAGE':
      status = 503;
      break;
    case 'TIMEOUT':
      status = 504;
      break;
    case 'RATE_LIMITED':
    case 'QUOTA_EXCEEDED':
      status = 429;
      break;
    default:
      status = error.status === 403 ? 403 : error.status === 429 ? 429 : 502;
  }

  const headers = new Headers();
  if (status === 429 && error.retryAfterMs !== undefined && Number.isFinite(error.retryAfterMs)) {
    const seconds = Math.ceil(error.retryAfterMs / 1_000);
    if (error.retryAfterMs >= 0 && Number.isSafeInteger(seconds)) {
      headers.set('Retry-After', String(seconds));
    }
  }
  return errorResponse(error.code, status, headers);
}

/** Stateless Web adapter; the authorized account client owns all caching. */
export function createNowPlayingHandler(
  { authorize }: NowPlayingHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return errorResponse('METHOD_NOT_ALLOWED', 405, { Allow: 'GET' });
    }

    let client: SpotifyClient | null;
    try {
      client = await authorize(request);
    } catch {
      return errorResponse('INTERNAL_ERROR', 500);
    }
    if (client === null) {
      return errorResponse('AUTH_REQUIRED', 401);
    }

    try {
      const snapshot = await client.getNowPlaying({ signal: request.signal });
      return jsonResponse(snapshot, 200);
    } catch (error) {
      return clientErrorResponse(error);
    }
  };
}
