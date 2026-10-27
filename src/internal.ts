import { SpotifyError } from './errors.js';
import type { Clock, Scheduler } from './types.js';

export const defaultClock: Clock = {
  now: () => Date.now(),
  monotonic: () => globalThis.performance.now(),
};

export const defaultScheduler: Scheduler = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** A caller may detach without abandoning the underlying operation. */
export function detach<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

export function sleep(delay: number, signal: AbortSignal, scheduler: Scheduler): Promise<void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const handle = scheduler.setTimeout(() => { cleanup(); resolve(); }, delay);
    const abort = () => { scheduler.clearTimeout(handle); cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function finiteOption(value: number, name: string, min: number, max = 86_400_000): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new SpotifyError('CONFIG', `Invalid ${name}.`);
  }
  return value;
}

export function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
