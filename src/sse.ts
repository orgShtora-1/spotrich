import { defaultClock, defaultScheduler, finiteOption, immutable, sleep } from './internal.js';
import { createSpotifyClient } from './client.js';
import type {
  AccessTokenProvider,
  NowPlaying,
  PollingOptions,
  SubscriptionEvent,
} from './types.js';

export interface SSEOptions {
  /** Token provider (PKCE or confidential). Required for server-side streaming. */
  auth: string | AccessTokenProvider;
  /** Custom fetch implementation. */
  fetch?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Cache TTL in milliseconds (0 = no cache). */
  cacheTtlMs?: number;
  /** Maximum retries for failed requests (0-2). */
  maxRetries?: 0 | 1 | 2;
  /** Polling intervals for different playback states. */
  polling?: Partial<PollingOptions>;
  /** Custom clock implementation. */
  clock?: { now(): number; monotonic(): number };
  /** Custom scheduler implementation. */
  scheduler?: { setTimeout(cb: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** Random number generator (0-1). */
  random?: () => number;
  /** Diagnostic callback. */
  onDiagnostic?: (event: { type: string; [key: string]: unknown }) => void;
  /** Heartbeat interval in milliseconds (default: 15000). Set to 0 to disable. */
  heartbeatMs?: number;
  /** Progress update interval in milliseconds (default: 1000). Set to 0 to disable. */
  progressIntervalMs?: number;
  /** Market code for track availability (ISO 3166-1 alpha-2). */
  market?: string;
}

export interface SSEStream {
  readonly stream: ReadableStream<Uint8Array>;
  readonly controller: AbortController;
  readonly cleanup: () => void;
}

function encodeEvent(data: object, type?: string): Uint8Array {
  let event = '';
  if (type !== undefined) event += `event: ${type}\n`;
  event += `data: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(event);
}

function encodeHeartbeat(): Uint8Array {
  return new TextEncoder().encode(': keepalive\n\n');
}

export function createSpotifySSE(options: SSEOptions): SSEStream {
  if (!options || (typeof options.auth !== 'string' && typeof options.auth?.getAccessToken !== 'function')) {
    throw new Error('An account-bound token or token provider is required.');
  }

  const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required.');

  const clock = options.clock ?? defaultClock;
  const scheduler = options.scheduler ?? defaultScheduler;
  const random = options.random ?? Math.random;
  const timeoutMs = finiteOption(options.timeoutMs ?? 10_000, 'timeoutMs', 1);
  const cacheTtlMs = finiteOption(options.cacheTtlMs ?? 0, 'cacheTtlMs', 0);
  const maxRetries = options.maxRetries ?? 2;
  if (![0, 1, 2].includes(maxRetries)) throw new Error('Invalid maxRetries.');

  const polling: PollingOptions = {
    playingIntervalMs: options.polling?.playingIntervalMs ?? 5_000,
    pausedIntervalMs: options.polling?.pausedIntervalMs ?? 15_000,
    idleIntervalMs: options.polling?.idleIntervalMs ?? 30_000,
    maxBackoffMs: options.polling?.maxBackoffMs ?? 60_000,
  };
  for (const [name, value] of Object.entries(polling)) finiteOption(value, name, 1_000);

  const heartbeatMs = finiteOption(options.heartbeatMs ?? 15_000, 'heartbeatMs', 0);
  const progressIntervalMs = finiteOption(options.progressIntervalMs ?? 1_000, 'progressIntervalMs', 0);
  const market = options.market ?? undefined;

  const controller = new AbortController();
  const signal = controller.signal;

  const client = createSpotifyClient({
    auth: options.auth,
    fetch: fetcher,
    timeoutMs,
    cacheTtlMs,
    maxRetries,
    polling,
    clock,
    scheduler,
    random,
    onDiagnostic: options.onDiagnostic ?? (() => {}),
  });

  let heartbeatTimer: unknown;
  let progressTimer: unknown;
  let lastSnapshot: NowPlaying | undefined;
  let destroyed = false;

  function cleanup(): void {
    if (destroyed) return;
    destroyed = true;
    if (heartbeatTimer !== undefined) scheduler.clearTimeout(heartbeatTimer);
    if (progressTimer !== undefined) scheduler.clearTimeout(progressTimer);
    controller.abort();
    client.destroy();
  }

  function scheduleHeartbeat(): void {
    if (destroyed || heartbeatMs === 0) return;
    heartbeatTimer = scheduler.setTimeout(() => {
      heartbeatTimer = undefined;
      if (!destroyed) controller.signal.reason ?? scheduleHeartbeat();
    }, heartbeatMs);
  }

  function scheduleProgress(): void {
    if (destroyed || progressIntervalMs === 0) return;
    progressTimer = scheduler.setTimeout(() => {
      progressTimer = undefined;
      if (!destroyed) controller.signal.reason ?? scheduleProgress();
    }, progressIntervalMs);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller_) {
      // Initial connection event
      controller_.enqueue(encodeEvent({ type: 'connected', timestamp: clock.now() }, 'open'));

      // Subscribe to track changes
      const unsubscribe = client.subscribe((event: SubscriptionEvent) => {
        if (destroyed) return;
        if (event.type === 'update') {
          lastSnapshot = event.snapshot;
          try {
            controller_.enqueue(encodeEvent(immutable(event.snapshot), 'track'));
          } catch { /* Stream closed */ }
        } else if (event.type === 'error') {
          try {
            controller_.enqueue(encodeEvent(immutable({ error: event.error, willRetry: event.willRetry }), 'error'));
          } catch { /* Stream closed */ }
          if (!event.willRetry) cleanup();
        }
      }, { signal });

      // Initial snapshot
      try {
        const initial = market !== undefined
          ? await client.getNowPlaying({ signal, fresh: true, market })
          : await client.getNowPlaying({ signal, fresh: true });
        lastSnapshot = initial;
        controller_.enqueue(encodeEvent(immutable(initial), 'track'));
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Failed to fetch initial track');
        controller_.enqueue(encodeEvent(immutable({ message: err.message }), 'error'));
      }

      scheduleHeartbeat();
      scheduleProgress();

      // Progress emission loop
      while (!destroyed && !signal.aborted) {
        try {
          await sleep(progressIntervalMs ?? 1_000, signal, scheduler);
        } catch {
          break;
        }
        if (destroyed || signal.aborted) break;

        if (lastSnapshot && progressIntervalMs > 0) {
          const progress = client.getProgress(lastSnapshot);
          if (progress.progressMs !== null && !progress.stale) {
            try {
              controller_.enqueue(encodeEvent(immutable(progress), 'progress'));
            } catch { /* Stream closed */ }
          }
        }

        if (heartbeatMs > 0) {
          try {
            controller_.enqueue(encodeHeartbeat());
          } catch { /* Stream closed */ }
        }

        scheduleHeartbeat();
        scheduleProgress();
      }

      unsubscribe();
    },
    cancel() {
      cleanup();
    },
  });

  return { stream, controller, cleanup };
}

export function handleSSEResponse(
  request: Request,
  options: SSEOptions
): Response {
  const { stream, cleanup } = createSpotifySSE(options);

  const response = new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });

  // Cleanup when request is aborted
  const signal = request.signal;
  if (signal.aborted) {
    cleanup();
  } else {
    signal.addEventListener('abort', cleanup, { once: true });
  }

  return response;
}