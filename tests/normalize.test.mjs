import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOW, assertFrozen, deferred, fixture, hasCode, jsonResponse, playback, rawEpisode, rawTrack,
} from './helpers.mjs';

test('normalizes a complete track through the public now-playing endpoint', async (t) => {
  const { client } = fixture(t);
  const snapshot = await client.getNowPlaying();

  assert.deepEqual(snapshot, {
    status: 'available', isPlaying: true, observedAt: NOW, timestamp: NOW - 60_000, progressMs: 1_000,
    item: {
      kind: 'track', id: 'track-one', name: 'First track', uri: 'spotify:track:track-one',
      url: 'https://open.spotify.com/track/track-one', durationMs: 180_000, explicit: false, isPlayable: true,
      artists: [{ id: 'artist-one', name: 'First artist', url: 'https://open.spotify.com/artist/artist-one' }],
      album: {
        id: 'album-one', name: 'First album', url: 'https://open.spotify.com/album/album-one',
        images: [{ url: 'https://images.example/album.jpg', width: 640, height: 640 }],
      },
    },
  });
  assertFrozen(snapshot);
  assert.equal(Object.hasOwn(snapshot, 'track'), false);
  assert.equal(Object.hasOwn(snapshot, 'device'), false);
});

test('paused playback remains available and isPlaying does not equate it with empty', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse(playback({ is_playing: false })) });
  const snapshot = await client.getNowPlaying();
  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.item.kind, 'track');
  assert.equal(snapshot.isPlaying, false);
  assert.equal(snapshot.progressMs, 1_000);
  assert.equal(await client.isPlaying(), false);
});

test('local tracks retain partial metadata without inventing IDs, artwork, or links', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse(playback({
    item: { is_local: true, name: 'Local file', artists: [{ name: 'Local artist' }] },
  })) });
  const { item } = await client.getNowPlaying();
  assert.deepEqual(item, {
    kind: 'local', id: null, name: 'Local file', uri: null, url: null, durationMs: null,
    explicit: false, isPlayable: null, artists: [{ id: null, name: 'Local artist', url: null }], album: null,
  });
});

test('episodes expose show and images rather than track-specific album and artists', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse(playback({
    currently_playing_type: 'episode', item: rawEpisode(),
  })) });
  const { item } = await client.getNowPlaying();
  assert.deepEqual(item, {
    kind: 'episode', id: 'episode-one', name: 'First episode', uri: 'spotify:episode:episode-one',
    url: 'https://open.spotify.com/episode/episode-one', durationMs: 3_600_000,
    explicit: true, isPlayable: false,
    images: [{ url: 'https://images.example/episode.jpg', width: 300, height: 300 }],
    show: { id: 'show-one', name: 'First show', publisher: 'Publisher', url: 'https://open.spotify.com/show/show-one' },
  });
  assert.equal(Object.hasOwn(item, 'artists'), false);
  assert.equal(Object.hasOwn(item, 'album'), false);
  assertFrozen(item);
});

for (const [label, input, expected] of [
  ['advertisement with no item', { currently_playing_type: 'ad', item: null }, { kind: 'ad', type: 'ad' }],
  ['advertisement with partial data', { currently_playing_type: 'ad', item: { name: 'Do not fabricate a track' } }, { kind: 'ad', type: 'ad' }],
  ['future media type', { item: { type: 'future-media', name: 'Unspecified contract' } }, { kind: 'unknown', type: 'future-media' }],
  ['future type with no item', { currently_playing_type: 'future-media', item: null }, { kind: 'unknown', type: 'future-media' }],
  ['untyped item', { currently_playing_type: undefined, item: {} }, { kind: 'unknown', type: 'unknown' }],
]) {
  test(`preserves uncertainty for ${label}`, async (t) => {
    const { client } = fixture(t, { fetch: async () => jsonResponse(playback(input)) });
    const snapshot = await client.getNowPlaying();
    assert.equal(snapshot.status, 'available');
    assert.deepEqual(snapshot.item, expected);
    assertFrozen(snapshot);
  });
}

for (const [label, input] of [
  ['null track', { item: null }],
  ['null episode', { currently_playing_type: 'episode', item: null }],
  ['missing item and type', { currently_playing_type: undefined, item: undefined }],
]) {
  test(`${label} is unavailable, not an advertisement or an invented stopped state`, async (t) => {
    const { client } = fixture(t, { fetch: async () => jsonResponse(playback(input)) });
    assert.deepEqual(await client.getNowPlaying(), {
      status: 'unavailable', isPlaying: true, item: null, progressMs: 1_000,
      timestamp: NOW - 60_000, observedAt: NOW,
    });
  });
}

for (const status of [200, 204]) {
  test(`${status} with no playback normalizes to an immutable empty snapshot`, async (t) => {
    const { client } = fixture(t, { fetch: async () => jsonResponse(null, status) });
    const snapshot = await client.getNowPlaying();
    assert.deepEqual(snapshot, {
      status: 'empty', isPlaying: false, item: null, progressMs: null, timestamp: null, observedAt: NOW,
    });
    assertFrozen(snapshot);
  });
}

test('observedAt is body receipt time, never Spotify timestamp or request start time', async (t) => {
  const body = deferred();
  const started = deferred();
  const { client, time } = fixture(t, { fetch: async () => {
    const response = jsonResponse(null);
    response.json = () => { started.resolve(); return body.promise; };
    return response;
  } });
  const pending = client.getNowPlaying();
  await started.promise;
  await time.advance(250);
  body.resolve(playback({ timestamp: NOW - 86_400_000 }));
  const snapshot = await pending;
  assert.equal(snapshot.observedAt, NOW + 250);
  assert.equal(snapshot.timestamp, NOW - 86_400_000);
  assert.equal(client.getProgress(snapshot).ageMs, 0);
});

for (const [label, input] of [
  ['array', []], ['string', 'unexpected'], ['number', 7], ['boolean', false], ['empty object', {}],
  ['missing playing flag', { item: rawTrack() }],
  ['string playing flag', { is_playing: 'true', item: rawTrack() }],
  ['numeric playing flag', { is_playing: 0, item: null }],
]) {
  test(`rejects malformed ${label} playback instead of returning empty`, async (t) => {
    const { client } = fixture(t, { fetch: async () => jsonResponse(input) });
    await assert.rejects(client.getNowPlaying(), hasCode('INVALID_RESPONSE', { transient: false }));
  });
}

test('malformed JSON is a redacted INVALID_RESPONSE rather than empty or a raw SyntaxError', async (t) => {
  const { client } = fixture(t, { fetch: async () => new Response('private-upstream-body {broken') });
  await assert.rejects(client.getNowPlaying(), (error) => {
    hasCode('INVALID_RESPONSE')(error);
    assert.doesNotMatch(String(error) + JSON.stringify(error), /private-upstream-body|broken/);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
});

for (const [type, expected] of [
  ['track', { kind: 'track', artists: [], album: null }],
  ['episode', { kind: 'episode', images: [], show: null }],
]) {
  test(`missing optional ${type} metadata has explicit nullable defaults`, async (t) => {
    const { client } = fixture(t, { fetch: async () => jsonResponse({ is_playing: false, item: { type } }) });
    const snapshot = await client.getNowPlaying();
    assert.deepEqual(snapshot, {
      status: 'available', isPlaying: false, observedAt: NOW, timestamp: null, progressMs: null,
      item: { id: null, name: '', uri: null, url: null, durationMs: null, explicit: false, isPlayable: null, ...expected },
    });
  });
}

for (const value of [null, -1, '1000', Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`invalid optional numeric metadata (${String(value)}) stays null rather than being coerced`, async (t) => {
    const { client } = fixture(t, { fetch: async () => jsonResponse(playback({
      progress_ms: value, timestamp: value, item: rawTrack({ duration_ms: value }),
    })) });
    const snapshot = await client.getNowPlaying();
    assert.equal(snapshot.timestamp, null);
    assert.equal(snapshot.progressMs, null);
    assert.equal(snapshot.item.durationMs, null);
  });
}

test('zero numeric values are real observations, not missing metadata', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse(playback({
    progress_ms: 0, timestamp: 0, item: rawTrack({ duration_ms: 0 }),
  })) });
  const snapshot = await client.getNowPlaying();
  assert.equal(snapshot.timestamp, 0);
  assert.equal(snapshot.progressMs, 0);
  assert.equal(snapshot.item.durationMs, 0);
});

for (const unsafe of ['http://images.example/a', 'javascript:alert(1)', 'https://user:password@images.example/a', '/relative', 'not a URL']) {
  test(`rejects unsafe media links and artwork (${unsafe})`, async (t) => {
    const { client } = fixture(t, { fetch: async () => jsonResponse(playback({ item: rawTrack({
      external_urls: { spotify: unsafe },
      artists: [{ name: 'Artist', external_urls: { spotify: unsafe } }],
      album: { external_urls: { spotify: unsafe }, images: [{ url: unsafe }] },
    }) })) });
    const { item } = await client.getNowPlaying();
    assert.equal(item.url, null);
    assert.equal(item.artists[0].url, null);
    assert.equal(item.album.url, null);
    assert.deepEqual(item.album.images, []);
  });
}

test('malformed optional artists, album images, and booleans do not escape the normalized shape', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse(playback({ item: rawTrack({
    id: 12, name: null, uri: false, explicit: 'true', is_playable: 'false',
    artists: [null, 9, [], { id: false, name: '', external_urls: null }],
    album: { images: [null, {}, { url: 'https://images.example/valid', width: -1, height: '20' }] },
  }) })) });
  const { item } = await client.getNowPlaying();
  assert.equal(item.id, null);
  assert.equal(item.name, '');
  assert.equal(item.uri, null);
  assert.equal(item.explicit, false);
  assert.equal(item.isPlayable, null);
  assert.deepEqual(item.artists, [{ id: null, name: '', url: null }]);
  assert.deepEqual(item.album, {
    id: null, name: '', url: null, images: [{ url: 'https://images.example/valid', width: null, height: null }],
  });
});

test('optional episode show and image fields are normalized defensively too', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse(playback({ item: rawEpisode({
    images: [false, { url: 'http://images.example/unsafe' }, { url: 'https://images.example/safe', width: 0 }],
    show: { id: '', publisher: 12, external_urls: { spotify: 'https://user:pass@example.com/show' } },
  }) })) });
  const { item } = await client.getNowPlaying();
  assert.deepEqual(item.images, [{ url: 'https://images.example/safe', width: 0, height: null }]);
  assert.deepEqual(item.show, { id: null, name: '', publisher: null, url: null });
});

test('playback state adds nullable device, context and controls without changing the playback model', async (t) => {
  const body = playback({
    is_playing: false,
    device: { id: 'device', name: 'Living room', type: 'Speaker', is_active: true, is_private_session: true, is_restricted: false, volume_percent: 0 },
    context: { type: 'playlist', uri: 'spotify:playlist:one', external_urls: { spotify: 'https://open.spotify.com/playlist/one' } },
    repeat_state: 'context', shuffle_state: false,
  });
  const { client } = fixture(t, { fetch: async () => jsonResponse(body) });
  const state = await client.getPlaybackState();
  assert.deepEqual(state.device, {
    id: 'device', name: 'Living room', type: 'Speaker', isActive: true,
    isPrivateSession: true, isRestricted: false, volumePercent: 0,
  });
  assert.deepEqual(state.context, { type: 'playlist', uri: 'spotify:playlist:one', url: 'https://open.spotify.com/playlist/one' });
  assert.equal(state.repeatState, 'context');
  assert.equal(state.shuffleState, false);
  assert.equal(state.playback.isPlaying, false);
  assert.equal(state.playback.item.kind, 'track');
  assert.deepEqual(client.getProgress(), client.getProgress(state.playback));
  assert.equal(Object.hasOwn(await client.getNowPlaying(), 'device'), false);
  assertFrozen(state);
});

test('partial or absent playback-state metadata stays nullable', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse(playback({
    device: { id: false, is_active: 'true', volume_percent: -5 },
    context: { uri: 123, external_urls: { spotify: 'http://example.com' } },
    repeat_state: 'future-repeat', shuffle_state: 'false',
  })) });
  const state = await client.getPlaybackState();
  assert.deepEqual(state.device, {
    id: null, name: null, type: null, isActive: false, isPrivateSession: false, isRestricted: false, volumePercent: null,
  });
  assert.deepEqual(state.context, { type: null, uri: null, url: null });
  assert.equal(state.repeatState, null);
  assert.equal(state.shuffleState, null);
});

test('204 playback state is empty with no invented device, context or controls', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse(null, 204) });
  const state = await client.getPlaybackState();
  assert.equal(state.playback.status, 'empty');
  assert.deepEqual({ ...state, playback: undefined }, {
    playback: undefined, device: null, context: null, repeatState: null, shuffleState: null,
  });
});

test('recent history skips malformed rows, normalizes tracks, and never follows next automatically', async (t) => {
  const { client, calls } = fixture(t, { fetch: async () => jsonResponse({
    items: [null, {}, { track: null }, { track: rawTrack(), played_at: '2026-10-27T12:00:00Z' }, { track: { name: 'Partial' }, played_at: 123 }],
    cursors: { after: '123', before: null }, next: 'https://api.spotify.com/v1/me/player/recently-played?after=123',
  }) });
  const history = await client.getRecentlyPlayed();
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].track.kind, 'track');
  assert.equal(history.items[0].playedAt, '2026-10-27T12:00:00Z');
  assert.equal(history.items[1].playedAt, null);
  assert.equal(history.items[1].track.name, 'Partial');
  assert.deepEqual(history.cursors, { after: '123', before: null });
  assert.equal(history.next, 'https://api.spotify.com/v1/me/player/recently-played?after=123');
  assert.equal(calls.length, 1);
  assertFrozen(history);
});

test('empty history has explicit cursors and rejects an unsafe next URL', async (t) => {
  const { client } = fixture(t, { fetch: async () => jsonResponse({ items: [], next: 'https://user:pass@example.com/private' }) });
  assert.deepEqual(await client.getRecentlyPlayed(), { items: [], cursors: { after: null, before: null }, next: null });
});

for (const input of [null, [], {}, { items: null }, { items: {} }]) {
  test(`malformed history ${JSON.stringify(input)} rejects rather than inventing an empty page`, async (t) => {
    const { client } = fixture(t, { fetch: async () => jsonResponse(input) });
    await assert.rejects(client.getRecentlyPlayed(), hasCode('INVALID_RESPONSE'));
  });
}

test('normalized objects cannot be mutated through any nested cached snapshot reference', async (t) => {
  const { client } = fixture(t, { cacheTtlMs: 1_000 });
  const snapshot = await client.getNowPlaying();
  assert.throws(() => { snapshot.item.name = 'changed'; }, TypeError);
  assert.throws(() => { snapshot.item.artists[0].name = 'changed'; }, TypeError);
  assert.throws(() => { snapshot.item.album.images.push({ url: 'https://example.com' }); }, TypeError);
  assert.equal((await client.getNowPlaying()).item.name, 'First track');
});
