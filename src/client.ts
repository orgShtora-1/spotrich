import { SpotifyError } from './errors.js';
import {
  abortError, checkSignal, defaultClock, defaultScheduler, detach, finiteOption,
  immutable, object, sleep,
} from './internal.js';
import { normalizeNowPlaying, normalizePlaybackState, normalizeRecentlyPlayed } from './normalize.js';
import type {
  AccessTokenProvider, DiagnosticEvent, NowPlaying, PlaybackState, PollingOptions,
  ProgressEstimate, RecentOptions, RecentlyPlayed, RequestOptions, SpotifyClient,
  SpotifyClientOptions, SubscriptionEvent,
} from './types.js';

interface Flight {
  readonly controller: AbortController;
  promise: Promise<unknown>;
  waiters: number;
  settled: boolean;
}

interface Observer {
  readonly listener: (event: SubscriptionEvent) => void;
  readonly cleanup: () => void;
}

const minimumInterval = 1_000;
const timerMaximum = 2_147_483_647;

/** One client is one account. No credentials, cache or pollers are shared globally. */
export function createSpotifyClient(options: SpotifyClientOptions): SpotifyClient {
  if (!options || (typeof options.auth !== 'string' && typeof options.auth?.getAccessToken !== 'function')) {
    throw new SpotifyError('CONFIG', 'An account-bound token or token provider is required.');
  }
  const auth = options.auth;
  if (typeof auth === 'string') validateToken(auth);
  const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetcher !== 'function') throw new SpotifyError('CONFIG', 'A fetch implementation is required.');
  const clock = options.clock ?? defaultClock;
  const scheduler = options.scheduler ?? defaultScheduler;
  const random = options.random ?? Math.random;
  const timeoutMs = finiteOption(options.timeoutMs ?? 10_000, 'timeoutMs', 1);
  const cacheTtlMs = finiteOption(options.cacheTtlMs ?? 0, 'cacheTtlMs', 0);
  const maxRetries = options.maxRetries ?? 2;
  if (![0, 1, 2].includes(maxRetries)) throw new SpotifyError('CONFIG', 'Invalid maxRetries.');
  const polling: PollingOptions = {
    playingIntervalMs: options.polling?.playingIntervalMs ?? 5_000,
    pausedIntervalMs: options.polling?.pausedIntervalMs ?? 15_000,
    idleIntervalMs: options.polling?.idleIntervalMs ?? 30_000,
    maxBackoffMs: options.polling?.maxBackoffMs ?? 60_000,
  };
  for (const [name, value] of Object.entries(polling)) finiteOption(value, name, minimumInterval);
  const cache = new Map<string, { readonly value: unknown; readonly expires: number }>();
  const flights = new Map<string, Flight>();
  const observers = new Map<symbol, Observer>();
  const anchors = new WeakMap<NowPlaying, number>();
  let destroyed = false;
  let stopped = false;
  // Monotonic deadline for numeric Retry-After enforcement. Never cleared by resumePolling.
  let deadlineMs: number | null = null;
  // Wall-clock retry timestamp used only for user-visible status reporting.
  let retryAt: number | null = null;
  let quotaExceeded = false;
  let quotaSuspended = false;
  // True once any response carried a numeric Retry-After header.
  let sawRetryAfter = false;
  let pollTimer: unknown;
  let activePoll: { readonly controller: AbortController } | null = null;
  let failures = 0;
  let last: NowPlaying | undefined;
  let fingerprint: string | undefined;

  function alive(): void {
    if (destroyed) throw new SpotifyError('DESTROYED', 'This Spotify client has been destroyed.');
  }

  function diagnostic(event: DiagnosticEvent): void {
    try { options.onDiagnostic?.(immutable(event)); } catch { /* Observability cannot affect requests. */ }
  }

  function emit(event: SubscriptionEvent): void {
    for (const [key, observer] of [...observers]) {
      if (destroyed || !observers.has(key)) continue;
      try { observer.listener(immutable(event)); } catch { diagnostic({ type: 'observer-error' }); }
    }
  }

  function remember(snapshot: NowPlaying): void {
    if (destroyed) return;
    anchors.set(snapshot, clock.monotonic());
    last = snapshot;
    const next = JSON.stringify([snapshot.status, snapshot.isPlaying, snapshot.item]);
    const changed = next !== fingerprint;
    fingerprint = next;
    emit({ type: 'update', snapshot, changed });
  }

  function checkGate(): void {
    if (deadlineMs !== null && deadlineMs <= clock.monotonic()) {
      deadlineMs = null;
      if (!quotaSuspended) retryAt = null;
      if (!quotaSuspended) quotaExceeded = false;
    }
    if (quotaSuspended || deadlineMs !== null) {
      const code = quotaExceeded ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED';
      throw new SpotifyError(code, 'Spotify requests are temporarily suspended.', {
        status: 429, transient: !quotaSuspended,
        ...(deadlineMs === null ? {} : { retryAfterMs: Math.max(0, deadlineMs - clock.monotonic()) }),
      });
    }
  }

  function jitter(base: number): number {
    const sample = random();
    return base * (0.75 + Math.max(0, Math.min(1, Number.isFinite(sample) ? sample : 0.5)) * 0.5);
  }

  async function token(provider: AccessTokenProvider, signal: AbortSignal, rejected?: string): Promise<string> {
    checkSignal(signal);
    try {
      const value = await detach(provider.getAccessToken({ signal, ...(rejected === undefined ? {} : { rejectedAccessToken: rejected }) }), signal);
      checkSignal(signal);
      validateToken(value);
      return value;
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof SpotifyError) throw error;
      throw new SpotifyError('AUTH_REQUIRED', 'The token provider could not supply an access token.');
    }
  }

  async function resource(path: string, controller: AbortController): Promise<unknown> {
    const signal = controller.signal;
    let timedOut = false;
    const deadline = scheduler.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let retries = 0;
    let recovered401 = false;
    let accessToken: string | undefined;
    try {
      while (true) {
        alive();
        checkSignal(signal);
        checkGate();
        accessToken ??= typeof auth === 'string' ? auth : await token(auth, signal);
        alive();
        checkSignal(signal);
        checkGate();
        const started = clock.monotonic();
        let response: Response;
        try {
          response = await detach(fetcher(`https://api.spotify.com/v1/me/player${path}`, {
            method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
          }), signal);
        } catch {
          checkSignal(signal);
          if (retries < maxRetries) {
            const delayMs = jitter(500 * 2 ** retries++);
            diagnostic({ type: 'retry', delayMs });
            await sleep(delayMs, signal, scheduler);
            continue;
          }
          throw new SpotifyError('NETWORK', 'Spotify could not be reached.', { transient: true });
        }
        checkSignal(signal);
        alive();
        const endpoint = path.startsWith('/recently-played') ? 'recently-played' : path.startsWith('/currently-playing') ? 'currently-playing' : 'player';
        diagnostic({ type: 'request', endpoint, status: response.status, durationMs: Math.max(0, clock.monotonic() - started) });
        if (signal.aborted) {
          discard(response);
          checkSignal(signal);
        }
        if (response.status === 401) {
          discard(response);
          if (typeof auth === 'string' || recovered401) throw new SpotifyError('AUTH_REQUIRED', 'Spotify authorization is required.', { status: 401 });
          recovered401 = true;
          accessToken = await token(auth, signal, accessToken);
          continue;
        }
        if (response.status === 429) {
          const header = response.headers.get('Retry-After');
          let delayMs: number | null = null;
          if (header !== null && header.trim() !== '') {
            const seconds = Number(header);
            if (Number.isFinite(seconds) && seconds >= 0) delayMs = Math.min(Number.MAX_SAFE_INTEGER, seconds * 1_000);
            else {
              // Convert HTTP-date to elapsed milliseconds at receipt, independent of wall-clock drift.
              const date = Date.parse(header);
              if (Number.isFinite(date)) delayMs = Math.max(0, date - clock.now());
            }
          }
          // Install a monotonic deadline so that both wall-clock shifts and concurrent unknown-reset
          // responses cannot erase an authoritative cooldown already observed by another caller.
          const deadline = clock.monotonic() + (delayMs ?? 60_000);
          deadlineMs = Math.max(deadlineMs ?? 0, deadline);
          if (delayMs !== null) {
            sawRetryAfter = true;
            // Set retryAt immediately from the header so stalled bodies do not hide it.
            retryAt = clock.now() + delayMs;
          } else if (!quotaSuspended) {
            // For unknown-reset, seed retryAt to the default so subsequent reads see a gate.
            retryAt = clock.now() + (deadlineMs - clock.monotonic());
          }
          let reason: unknown;
          try { reason = object(object(await detach(response.json() as Promise<unknown>, signal))?.['error'])?.['reason']; }
          catch { checkSignal(signal); }
          const quota = reason === 'QUOTA_EXCEEDED';
          quotaExceeded ||= quota;
          quotaSuspended ||= quota && delayMs === null;
          // If this is a true indefinite suspension with no known Retry-After, clear retryAt.
          if (quotaSuspended && delayMs === null && !sawRetryAfter) {
            retryAt = null;
          }
          throw new SpotifyError(quota ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED', 'Spotify request limit reached.', {
            status: 429, transient: !quotaSuspended,
            ...(quotaSuspended ? {} : { retryAfterMs: Math.max(0, (deadlineMs ?? clock.monotonic()) - clock.monotonic()) }),
          });
        }
        if ([500, 502, 503, 504].includes(response.status) && retries < maxRetries) {
          discard(response);
          const delayMs = jitter(500 * 2 ** retries++);
          diagnostic({ type: 'retry', delayMs });
          await sleep(delayMs, signal, scheduler);
          continue;
        }
        if (!response.ok) {
          discard(response);
          throw new SpotifyError('HTTP', 'Spotify rejected the request.', {
            status: response.status, transient: [500, 502, 503, 504].includes(response.status),
          });
        }
        if (response.status === 204) return null;
        try {
          const body: unknown = await detach(response.json() as Promise<unknown>, signal);
          checkSignal(signal);
          return body;
        } catch {
          checkSignal(signal);
          throw new SpotifyError('INVALID_RESPONSE', 'Spotify returned an invalid response.');
        }
      }
    } catch (error) {
      if (timedOut) throw new SpotifyError('TIMEOUT', 'The Spotify request timed out.', { transient: true });
      if (signal.aborted) throw abortError();
      throw error;
    } finally { scheduler.clearTimeout(deadline); }
  }

  function read<T>(path: string, normalize: (data: unknown, observedAt: number) => T, request: { readonly signal?: AbortSignal; readonly fresh?: boolean }): Promise<T> {
    alive();
    checkSignal(request.signal);
    checkGate();
    const cached = cache.get(path);
    if (!request.fresh && cached && cached.expires > clock.monotonic()) return Promise.resolve(cached.value as T);
    if (cached) cache.delete(path);
    let flight = flights.get(path);
    if (!flight) {
      const controller = new AbortController();
      flight = { controller, promise: null as unknown as Promise<unknown>, waiters: 0, settled: false };
      const current = flight;
      flights.set(path, current);
      // Start the resource operation AFTER the flight is registered, so a synchronous
      // destroy() invoked by a host callback will find and abort this flight.
      current.promise = resource(path, controller).then((data) => {
        alive();
        checkSignal(controller.signal);
        const value = normalize(data, clock.now());
        alive();
        checkSignal(controller.signal);
        if (cacheTtlMs > 0) {
          if (cache.size >= 64) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(path, { value, expires: clock.monotonic() + cacheTtlMs });
        }
        return value;
      });
      // Both handlers consume rejection even when every caller has detached.
      current.promise.then(() => finish(), () => finish());
      function finish() {
        current.settled = true;
        if (flights.get(path) === current) flights.delete(path);
      }
    }
    const current = flight;
    current.waiters++;
    return new Promise<T>((resolve, reject) => {
      let attached = true;
      const release = () => {
        if (!attached) return;
        attached = false;
        request.signal?.removeEventListener('abort', abort);
        current.waiters--;
        if (!current.settled && current.waiters === 0) {
          if (flights.get(path) === current) flights.delete(path);
          current.controller.abort();
        }
      };
      const abort = () => { release(); reject(abortError()); };
      request.signal?.addEventListener('abort', abort, { once: true });
      current.promise.then((value) => {
        if (!attached) return;
        release();
        resolve(value as T);
      }, (error: unknown) => {
        if (!attached) return;
        release();
        reject(error);
      });
      // A host callback may have synchronously canceled while resource() started.
      if (request.signal?.aborted) abort();
    });
  }

  function marketPath(path: string, request: RequestOptions): string {
    const params = new URLSearchParams({ additional_types: 'track,episode' });
    if (request.market !== undefined) {
      if (!/^[a-z]{2}$/i.test(request.market)) throw new SpotifyError('CONFIG', 'Invalid market.');
      params.set('market', request.market.toUpperCase());
    }
    return `${path}?${params}`;
  }

  async function getNowPlaying(request: RequestOptions = {}): Promise<NowPlaying> {
    return read(marketPath('/currently-playing', request), (data, time) => {
      const snapshot = normalizeNowPlaying(data, time);
      remember(snapshot);
      return snapshot;
    }, request);
  }

  async function getPlaybackState(request: RequestOptions = {}): Promise<PlaybackState> {
    return read(marketPath('', request), (data, time) => {
      const state = normalizePlaybackState(data, time);
      remember(state.playback);
      return state;
    }, request);
  }

  async function getRecentlyPlayed(request: RecentOptions = {}): Promise<RecentlyPlayed> {
    const limit = request.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (request.before !== undefined && request.after !== undefined)) {
      throw new SpotifyError('CONFIG', 'Invalid history parameters.');
    }
    const params = new URLSearchParams({ limit: String(limit) });
    for (const name of ['before', 'after'] as const) {
      const value = request[name];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) throw new SpotifyError('CONFIG', 'Invalid history cursor.');
        params.set(name, String(value));
      }
    }
    return read(`/recently-played?${params}`, normalizeRecentlyPlayed, request);
  }

  function getProgress(snapshot = last, estimateOptions: { readonly staleAfterMs?: number } = {}): ProgressEstimate {
    alive();
    const staleAfterMs = finiteOption(estimateOptions.staleAfterMs ?? 30_000, 'staleAfterMs', 0);
    if (!snapshot) return immutable({ progressMs: null, estimated: false, ageMs: 0, stale: true, observedAt: null });
    const anchor = anchors.get(snapshot);
    const ageMs = Math.max(0, anchor === undefined ? clock.now() - snapshot.observedAt : clock.monotonic() - anchor);
    const canEstimate = snapshot.isPlaying && snapshot.item !== null && 'durationMs' in snapshot.item && snapshot.progressMs !== null;
    let progressMs = snapshot.progressMs === null ? null : snapshot.progressMs + (canEstimate ? ageMs : 0);
    const duration = snapshot.item && 'durationMs' in snapshot.item ? snapshot.item.durationMs : null;
    if (progressMs !== null && duration !== null) progressMs = Math.min(duration, progressMs);
    return immutable({ progressMs, estimated: canEstimate && ageMs > 0, ageMs, stale: ageMs > staleAfterMs, observedAt: snapshot.observedAt });
  }

  function clearPoll(): void {
    if (pollTimer !== undefined) scheduler.clearTimeout(pollTimer);
    pollTimer = undefined;
    const pending = activePoll;
    activePoll = null;
    pending?.controller.abort();
  }

  function interval(snapshot: NowPlaying): number {
    if (snapshot.status === 'empty' || snapshot.status === 'unavailable') return polling.idleIntervalMs;
    if (!snapshot.isPlaying) return polling.pausedIntervalMs;
    const duration = 'durationMs' in snapshot.item ? snapshot.item.durationMs : null;
    return duration !== null && snapshot.progressMs !== null
      ? Math.max(minimumInterval, Math.min(polling.playingIntervalMs, duration - snapshot.progressMs + 250))
      : polling.playingIntervalMs;
  }

  function schedule(delay: number): void {
    if (destroyed || stopped || observers.size === 0) return;
    pollTimer = scheduler.setTimeout(() => { pollTimer = undefined; startPoll(); }, Math.min(timerMaximum, Math.max(minimumInterval, delay)));
  }

  function startPoll(): void {
    if (destroyed || stopped || observers.size === 0 || activePoll || pollTimer !== undefined) return;
    const running = { controller: new AbortController() };
    activePoll = running;
    void (async () => {
      let delay = polling.idleIntervalMs;
      try {
        const snapshot = await getNowPlaying({ signal: running.controller.signal, fresh: true });
        failures = 0;
        delay = interval(snapshot);
      } catch (error) {
        if (running.controller.signal.aborted || destroyed || activePoll !== running) return;
        const safe = error instanceof SpotifyError ? error : new SpotifyError('NETWORK', 'Playback could not be updated.', { transient: true });
        failures++;
        const willRetry = safe.transient && !quotaSuspended;
        if (!willRetry) stopped = true;
        delay = Math.max(safe.retryAfterMs ?? 0, Math.min(polling.maxBackoffMs, jitter(minimumInterval * 2 ** Math.min(failures, 16))));
        emit({ type: 'error', error: safe, willRetry });
      } finally {
        if (activePoll === running) {
          activePoll = null;
          schedule(delay);
        }
      }
    })();
  }

  function subscribe(listener: (event: SubscriptionEvent) => void, subscribeOptions: { readonly signal?: AbortSignal } = {}): () => void {
    alive();
    if (typeof listener !== 'function') throw new SpotifyError('CONFIG', 'A subscription listener is required.');
    if (subscribeOptions.signal?.aborted) return () => {};
    const key = Symbol();
    const unsubscribe = () => {
      const observer = observers.get(key);
      if (!observer) return;
      observers.delete(key);
      observer.cleanup();
      if (observers.size === 0) clearPoll();
    };
    observers.set(key, { listener, cleanup: () => subscribeOptions.signal?.removeEventListener('abort', unsubscribe) });
    subscribeOptions.signal?.addEventListener('abort', unsubscribe, { once: true });
    if (last) {
      try { listener(immutable({ type: 'update', snapshot: last, changed: false })); } catch { diagnostic({ type: 'observer-error' }); }
    }
    startPoll();
    return unsubscribe;
  }

  return {
    getNowPlaying, getPlaybackState, getRecentlyPlayed, getProgress, subscribe,
    isPlaying: async (request) => (await getNowPlaying(request)).isPlaying,
    refresh: (request = {}) => getNowPlaying({ ...request, fresh: true }),
    getPollingStatus: () => {
      if (!destroyed) { try { checkGate(); } catch { /* Status reports the gate without throwing. */ } }
      return immutable({ state: destroyed ? 'destroyed' : stopped || quotaSuspended ? 'stopped' : observers.size > 0 ? 'polling' : 'idle', subscribers: observers.size, retryAt, quotaExceeded });
    },
    resumePolling: () => {
      alive();
      stopped = false;
      failures = 0;
      quotaSuspended = false;
      if (deadlineMs === null || deadlineMs <= clock.monotonic()) quotaExceeded = false;
      clearPoll();
      startPoll();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      clearPoll();
      for (const observer of observers.values()) observer.cleanup();
      observers.clear();
      for (const flight of flights.values()) flight.controller.abort();
      flights.clear();
      cache.clear();
      last = undefined;
      fingerprint = undefined;
    },
  };
}

function validateToken(token: string): void {
  if (typeof token !== 'string' || !token || /\s|[\u0000-\u001f\u007f]/.test(token)) {
    throw new SpotifyError('CONFIG', 'Invalid access token.');
  }
}

function discard(response: Response): void {
  // Do not wait for an untrusted stream's cancel hook to settle.
  try { void response.body?.cancel().catch(() => {}); } catch { /* Already closed or locked. */ }
}
