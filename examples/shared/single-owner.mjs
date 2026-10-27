import { createSpotifyClient, SpotifyError } from '@shtora/spotrich';
import { createTokenProvider } from '@shtora/spotrich/oauth';
import { requiredEnv } from './env.mjs';

// Local CLI / explicitly single-owner backend only. No multi-user global cache.
// The seed is not durable; this example does not save a rotated refresh token.
export function createSingleOwnerClient(env) {
  const auth = createTokenProvider({
    mode: 'confidential',
    clientId: requiredEnv(env, 'SPOTIFY_CLIENT_ID'),
    clientSecret: requiredEnv(env, 'SPOTIFY_CLIENT_SECRET'),
    refreshToken: requiredEnv(env, 'SPOTIFY_REFRESH_TOKEN'),
  });
  return createSpotifyClient({ auth, timeoutMs: 10_000 });
}

export function displayText(snapshot) {
  if (snapshot.status !== 'available') return snapshot.status;
  const item = snapshot.item;
  if (item.kind === 'track' || item.kind === 'local' || item.kind === 'episode') {
    return `${snapshot.isPlaying ? 'playing' : 'paused'}: ${item.name}`;
  }
  return item.kind;
}

export function reportError(error) {
  const code = error instanceof SpotifyError
    ? error.code
    : error instanceof Error && error.name === 'AbortError' ? 'ABORTED' : 'EXAMPLE_ERROR';
  console.error({ error: code });
  process.exitCode = 1;
}
