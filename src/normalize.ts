import { SpotifyError } from './errors.js';
import { immutable, nonnegative, object, safeUrl, text } from './internal.js';
import type { EpisodeItem, Image, NowPlaying, PlaybackItem, PlaybackState, RecentlyPlayed, TrackItem } from './types.js';

function external(value: unknown): string | null {
  return safeUrl(object(value)?.['spotify']);
}

function images(value: unknown): Image[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const image = object(entry);
    const url = safeUrl(image?.['url']);
    return image && url ? [{ url, width: nonnegative(image['width']), height: nonnegative(image['height']) }] : [];
  });
}

function media(item: Record<string, unknown>) {
  return {
    id: text(item['id']), name: text(item['name']) ?? '', uri: text(item['uri']),
    url: external(item['external_urls']), durationMs: nonnegative(item['duration_ms']),
    explicit: item['explicit'] === true,
    isPlayable: typeof item['is_playable'] === 'boolean' ? item['is_playable'] : null,
  };
}

export function normalizeTrack(item: Record<string, unknown>): TrackItem {
  const album = object(item['album']);
  const artists = Array.isArray(item['artists']) ? item['artists'] : [];
  return {
    ...media(item), kind: item['is_local'] === true ? 'local' : 'track',
    artists: artists.flatMap((entry: unknown) => {
      const artist = object(entry);
      return artist ? [{ id: text(artist['id']), name: text(artist['name']) ?? '', url: external(artist['external_urls']) }] : [];
    }),
    album: album ? { id: text(album['id']), name: text(album['name']) ?? '', images: images(album['images']), url: external(album['external_urls']) } : null,
  };
}

function normalizeItem(item: Record<string, unknown> | null, type: string): PlaybackItem | null {
  if (item?.['is_local'] === true) return normalizeTrack(item);
  if (type === 'ad') return { kind: 'ad', type };
  if (!item) return type !== 'track' && type !== 'episode' && type !== 'unknown' ? { kind: 'unknown', type } : null;
  if (type === 'track') return normalizeTrack(item);
  if (type === 'episode') {
    const show = object(item['show']);
    const episode: EpisodeItem = {
      ...media(item), kind: 'episode', images: images(item['images']),
      show: show ? { id: text(show['id']), name: text(show['name']) ?? '', publisher: text(show['publisher']), url: external(show['external_urls']) } : null,
    };
    return episode;
  }
  return { kind: 'unknown', type };
}

export function normalizeNowPlaying(data: unknown, observedAt: number): NowPlaying {
  if (data === null) return immutable({ status: 'empty', isPlaying: false, item: null, progressMs: null, timestamp: null, observedAt });
  const raw = object(data);
  if (!raw || typeof raw['is_playing'] !== 'boolean') throw new SpotifyError('INVALID_RESPONSE', 'Invalid playback response.');
  const rawItem = object(raw['item']);
  const type = text(rawItem?.['type']) ?? text(raw['currently_playing_type']) ?? 'unknown';
  const item = normalizeItem(rawItem, type);
  const base = { observedAt, timestamp: nonnegative(raw['timestamp']), isPlaying: raw['is_playing'], progressMs: nonnegative(raw['progress_ms']) };
  return immutable(item ? { ...base, status: 'available', item } : { ...base, status: 'unavailable', item: null });
}

export function normalizePlaybackState(data: unknown, observedAt: number): PlaybackState {
  const raw = object(data);
  const device = object(raw?.['device']);
  const context = object(raw?.['context']);
  const repeat = raw?.['repeat_state'];
  return immutable({
    playback: normalizeNowPlaying(data, observedAt),
    device: device ? {
      id: text(device['id']), name: text(device['name']), type: text(device['type']),
      isActive: device['is_active'] === true, isPrivateSession: device['is_private_session'] === true,
      isRestricted: device['is_restricted'] === true, volumePercent: nonnegative(device['volume_percent']),
    } : null,
    context: context ? { type: text(context['type']), uri: text(context['uri']), url: external(context['external_urls']) } : null,
    repeatState: repeat === 'off' || repeat === 'track' || repeat === 'context' ? repeat : null,
    shuffleState: typeof raw?.['shuffle_state'] === 'boolean' ? raw['shuffle_state'] : null,
  });
}

export function normalizeRecentlyPlayed(data: unknown): RecentlyPlayed {
  const raw = object(data);
  if (!raw || !Array.isArray(raw['items'])) throw new SpotifyError('INVALID_RESPONSE', 'Invalid history response.');
  const cursors = object(raw['cursors']);
  return immutable({
    items: raw['items'].flatMap((entry: unknown) => {
      const row = object(entry);
      const track = object(row?.['track']);
      return row && track ? [{ track: normalizeTrack(track), playedAt: text(row['played_at']) }] : [];
    }),
    cursors: { after: text(cursors?.['after']), before: text(cursors?.['before']) },
    next: safeUrl(raw['next']),
  });
}
