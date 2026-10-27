// This browser module imports NO Spotify client or OAuth credentials. It talks
// only to your same-origin, authenticated, private host endpoint, on demand.
export async function readNowPlaying({ signal } = {}) {
  const response = await fetch('/api/now-playing', {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (response.status === 401) return { ok: false, reason: 'sign-in-or-reconnect' };
  if (response.status === 429) {
    const seconds = response.headers.get('Retry-After');
    const retryAfterMs = seconds !== null && /^\d+$/.test(seconds)
      && Number.isSafeInteger(Number(seconds) * 1_000) ? Number(seconds) * 1_000 : null;
    // Show a wait state. Do not start an immediate or unbounded retry loop.
    return { ok: false, reason: 'wait', retryAfterMs };
  }
  if (!response.ok) return { ok: false, reason: 'unavailable' };
  return { ok: true, snapshot: await response.json() };
}

// Example caller: const abort = new AbortController();
// const result = await readNowPlaying({ signal: abort.signal });
// On unmount/navigation: abort.abort(). Render text, not innerHTML. No polling
// or framework lifecycle is installed by this module.
