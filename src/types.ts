import type { SpotifyError } from './errors.js';

export interface AccessTokenRequest {
  readonly signal?: AbortSignal;
  /** Token rejected by a 401; reuse a newer token rather than refreshing again. */
  readonly rejectedAccessToken?: string;
}

/** Must remain bound to one account/grant for its entire lifetime. */
export interface AccessTokenProvider {
  getAccessToken(options?: AccessTokenRequest): Promise<string>;
}

export interface Clock {
  now(): number;
  monotonic(): number;
}

export interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Image {
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
}

export interface Artist {
  readonly id: string | null;
  readonly name: string;
  readonly url: string | null;
}

interface MediaBase {
  readonly id: string | null;
  readonly name: string;
  readonly uri: string | null;
  readonly url: string | null;
  readonly durationMs: number | null;
  readonly explicit: boolean;
  readonly isPlayable: boolean | null;
}

export interface TrackItem extends MediaBase {
  readonly kind: 'track' | 'local';
  readonly artists: readonly Artist[];
  readonly album: {
    readonly id: string | null;
    readonly name: string;
    readonly images: readonly Image[];
    readonly url: string | null;
  } | null;
}

export interface EpisodeItem extends MediaBase {
  readonly kind: 'episode';
  readonly images: readonly Image[];
  readonly show: {
    readonly id: string | null;
    readonly name: string;
    readonly publisher: string | null;
    readonly url: string | null;
  } | null;
}

export interface UnknownItem {
  readonly kind: 'ad' | 'unknown';
  readonly type: string;
}

export type PlaybackItem = TrackItem | EpisodeItem | UnknownItem;

interface SnapshotBase {
  /** Local receipt time, in Unix milliseconds. */
  readonly observedAt: number;
  /** Spotify's last state-change time; not the receipt time. */
  readonly timestamp: number | null;
}

export type NowPlaying = SnapshotBase & (
  | { readonly status: 'empty'; readonly isPlaying: false; readonly item: null; readonly progressMs: null }
  | { readonly status: 'unavailable'; readonly isPlaying: boolean; readonly item: null; readonly progressMs: number | null }
  | { readonly status: 'available'; readonly isPlaying: boolean; readonly item: PlaybackItem; readonly progressMs: number | null }
);

export interface PlaybackDevice {
  readonly id: string | null;
  readonly name: string | null;
  readonly type: string | null;
  readonly isActive: boolean;
  readonly isPrivateSession: boolean;
  readonly isRestricted: boolean;
  readonly volumePercent: number | null;
}

export interface PlaybackState {
  readonly playback: NowPlaying;
  readonly device: PlaybackDevice | null;
  readonly context: { readonly type: string | null; readonly uri: string | null; readonly url: string | null } | null;
  readonly repeatState: 'off' | 'track' | 'context' | null;
  readonly shuffleState: boolean | null;
}

export interface RecentlyPlayed {
  readonly items: readonly { readonly track: TrackItem; readonly playedAt: string | null }[];
  readonly cursors: { readonly after: string | null; readonly before: string | null };
  readonly next: string | null;
}

export interface ProgressEstimate {
  readonly progressMs: number | null;
  readonly estimated: boolean;
  readonly ageMs: number;
  readonly stale: boolean;
  readonly observedAt: number | null;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly market?: string;
  /** Bypass settled cache, but never in-flight coalescing or rate-limit gates. */
  readonly fresh?: boolean;
}

export interface RecentOptions {
  readonly signal?: AbortSignal;
  readonly limit?: number;
  readonly before?: number;
  readonly after?: number;
  readonly fresh?: boolean;
}

export interface PollingOptions {
  readonly playingIntervalMs: number;
  readonly pausedIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly maxBackoffMs: number;
}

export type SubscriptionEvent =
  | { readonly type: 'update'; readonly snapshot: NowPlaying; readonly changed: boolean }
  | { readonly type: 'error'; readonly error: SpotifyError; readonly willRetry: boolean };

export interface PollingStatus {
  readonly state: 'idle' | 'polling' | 'stopped' | 'destroyed';
  readonly subscribers: number;
  readonly retryAt: number | null;
  readonly quotaExceeded: boolean;
}

export type DiagnosticEvent =
  | { readonly type: 'request'; readonly endpoint: 'currently-playing' | 'player' | 'recently-played'; readonly status: number; readonly durationMs: number }
  | { readonly type: 'retry'; readonly delayMs: number }
  | { readonly type: 'observer-error' };

export interface SpotifyClientOptions {
  readonly auth: string | AccessTokenProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly maxRetries?: 0 | 1 | 2;
  readonly polling?: Partial<PollingOptions>;
  readonly clock?: Clock;
  readonly scheduler?: Scheduler;
  readonly random?: () => number;
  /** Only fixed, redacted metadata. Listener exceptions are ignored. */
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
}

export interface SpotifyClient {
  getNowPlaying(options?: RequestOptions): Promise<NowPlaying>;
  getPlaybackState(options?: RequestOptions): Promise<PlaybackState>;
  getRecentlyPlayed(options?: RecentOptions): Promise<RecentlyPlayed>;
  isPlaying(options?: RequestOptions): Promise<boolean>;
  /** Local estimate only; never performs a request. */
  getProgress(snapshot?: NowPlaying, options?: { readonly staleAfterMs?: number }): ProgressEstimate;
  refresh(options?: Omit<RequestOptions, 'fresh'>): Promise<NowPlaying>;
  subscribe(listener: (event: SubscriptionEvent) => void, options?: { readonly signal?: AbortSignal }): () => void;
  getPollingStatus(): PollingStatus;
  /** Host explicitly resumes a stopped/quota-suspended poller. Cannot bypass Retry-After. */
  resumePolling(): void;
  destroy(): void;
}
