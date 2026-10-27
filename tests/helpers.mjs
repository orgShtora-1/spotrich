import assert from 'node:assert/strict';
import { createSpotifyClient, SpotifyError } from '../dist/index.js';

export const NOW = 1_800_000_000_000;

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Drain promise continuations, never the real event loop or a wall-clock timer.
export async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

export function fakeTime(wall = NOW) {
  let monotonic = 0;
  let sequence = 0;
  const timers = new Map();
  const created = [];
  const clock = { now: () => wall, monotonic: () => monotonic };
  const scheduler = {
    setTimeout(callback, delayMs) {
      assert.ok(Number.isFinite(delayMs) && delayMs >= 0, 'scheduler delay must be finite and nonnegative');
      const handle = ++sequence;
      timers.set(handle, { at: monotonic + delayMs, callback });
      created.push(delayMs);
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
  };

  return {
    clock, scheduler, created,
    get pending() { return timers.size; },
    setWall(value) { wall = value; },
    delays() { return [...timers.values()].map(({ at }) => at - monotonic).sort((a, b) => a - b); },
    nextDelay() {
      assert.ok(timers.size > 0, 'expected a scheduled operation');
      return Math.min(...[...timers.values()].map(({ at }) => at - monotonic));
    },
    async advance(delayMs) {
      assert.ok(Number.isFinite(delayMs) && delayMs >= 0, 'fake time cannot run backward');
      await flush();
      const target = monotonic + delayMs;
      let executed = 0;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++executed < 10_000, 'fake scheduler did not become idle');
        const [handle, timer] = next;
        wall += timer.at - monotonic;
        monotonic = timer.at;
        timers.delete(handle);
        timer.callback();
        await flush();
      }
      wall += target - monotonic;
      monotonic = target;
      await flush();
    },
  };
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

export function rawTrack(overrides = {}) {
  return {
    type: 'track', id: 'track-one', name: 'First track', uri: 'spotify:track:track-one',
    external_urls: { spotify: 'https://open.spotify.com/track/track-one' },
    duration_ms: 180_000, explicit: false, is_playable: true,
    artists: [{ id: 'artist-one', name: 'First artist', external_urls: { spotify: 'https://open.spotify.com/artist/artist-one' } }],
    album: {
      id: 'album-one', name: 'First album', external_urls: { spotify: 'https://open.spotify.com/album/album-one' },
      images: [{ url: 'https://images.example/album.jpg', width: 640, height: 640 }],
    },
    ...overrides,
  };
}

export function rawEpisode(overrides = {}) {
  return {
    type: 'episode', id: 'episode-one', name: 'First episode', uri: 'spotify:episode:episode-one',
    external_urls: { spotify: 'https://open.spotify.com/episode/episode-one' },
    duration_ms: 3_600_000, explicit: true, is_playable: false,
    images: [{ url: 'https://images.example/episode.jpg', width: 300, height: 300 }],
    show: {
      id: 'show-one', name: 'First show', publisher: 'Publisher',
      external_urls: { spotify: 'https://open.spotify.com/show/show-one' },
    },
    ...overrides,
  };
}

export function playback(overrides = {}) {
  return {
    is_playing: true, currently_playing_type: 'track', timestamp: NOW - 60_000,
    progress_ms: 1_000, item: rawTrack(), ...overrides,
  };
}

export function fixture(t, options = {}) {
  const {
    time = fakeTime(), fetch: fetcher = async () => jsonResponse(playback()), onDiagnostic,
    ...clientOptions
  } = options;
  const calls = [];
  const diagnostics = [];
  const client = createSpotifyClient({
    auth: 'account-access', clock: time.clock, scheduler: time.scheduler, random: () => 0.5,
    ...clientOptions,
    fetch(url, init) {
      calls.push({ url: String(url), init });
      return fetcher(url, init);
    },
    onDiagnostic(event) { diagnostics.push(event); onDiagnostic?.(event); },
  });
  t.after(async () => {
    client.destroy();
    await flush();
    assert.equal(time.pending, 0, 'destroy must release all injected timers');
  });
  return { client, time, calls, diagnostics };
}

export function hasCode(code, metadata = {}) {
  return (error) => {
    assert.ok(error instanceof SpotifyError, `expected SpotifyError ${code}`);
    assert.equal(error.code, code);
    for (const [key, value] of Object.entries(metadata)) assert.equal(error[key], value, key);
    return true;
  };
}

export function isAbort(error) {
  assert.equal(error.name, 'AbortError');
  return true;
}

export function assertFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), 'public data must be deeply frozen');
  for (const child of Object.values(value)) assertFrozen(child);
}
