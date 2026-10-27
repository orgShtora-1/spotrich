import { isMain } from './lib/host.mjs';

export async function live() {
  if (process.env.SPOTIFY_LIVE_TEST !== '1') {
    process.stdout.write('NOT RUN: live Spotify requests require SPOTIFY_LIVE_TEST=1 and explicit credentials.\n');
    return;
  }
  const { createSpotifyClient, SpotifyError } = await import('../dist/index.js');
  let client;
  try {
    let auth = process.env.SPOTIFY_ACCESS_TOKEN;
    if (!auth) {
      const clientId = process.env.SPOTIFY_CLIENT_ID;
      const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
      if (!clientId || !refreshToken) throw new Error('MISSING_CREDENTIALS');
      const { createTokenProvider } = await import('../dist/oauth.js');
      const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
      auth = createTokenProvider({
        ...(clientSecret ? { mode: 'confidential', clientSecret } : { mode: 'pkce' }),
        clientId, refreshToken,
      });
    }
    client = createSpotifyClient({ auth, maxRetries: 0, timeoutMs: 15_000 });
    // Only these three official, read-only user endpoints are touched. No polling.
    const now = await client.getNowPlaying({ fresh: true });
    if (!['available', 'unavailable', 'empty'].includes(now.status)) throw new Error('INVALID_CONTRACT');
    process.stdout.write('PASS: GET /v1/me/player/currently-playing (payload withheld).\n');
    const state = await client.getPlaybackState({ fresh: true });
    if (!state.playback || !['available', 'unavailable', 'empty'].includes(state.playback.status)) throw new Error('INVALID_CONTRACT');
    process.stdout.write('PASS: GET /v1/me/player (payload withheld).\n');
    const recent = await client.getRecentlyPlayed({ limit: 1, fresh: true });
    if (!Array.isArray(recent.items)) throw new Error('INVALID_CONTRACT');
    process.stdout.write('PASS: GET /v1/me/player/recently-played (payload withheld).\n');
  } catch (error) {
    // Never print an upstream error, URL, token, stack, listening data, or environment.
    const code = error instanceof SpotifyError ? error.code
      : error instanceof Error && error.message === 'MISSING_CREDENTIALS' ? 'MISSING_CREDENTIALS' : 'LIVE_CHECK_FAILED';
    process.stderr.write(`Live check failed: ${code}. Check grants/scopes and account eligibility privately.\n`);
    process.exitCode = 1;
  } finally {
    client?.destroy();
  }
}

if (isMain(import.meta.url)) await live();
