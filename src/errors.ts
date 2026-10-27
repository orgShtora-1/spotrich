export type SpotifyErrorCode =
  | 'CONFIG'
  | 'AUTH_REQUIRED'
  | 'OAUTH_STATE'
  | 'OAUTH_DENIED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'HTTP'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'DESTROYED'
  | 'STORAGE';

export interface SpotifyErrorOptions {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly transient?: boolean;
}

/** Intentionally contains no upstream body, headers, URL, credentials or cause. */
export class SpotifyError extends Error {
  override readonly name = 'SpotifyError';
  readonly code: SpotifyErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly transient: boolean;

  constructor(code: SpotifyErrorCode, message: string, options: SpotifyErrorOptions = {}) {
    super(message);
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.transient = options.transient ?? false;
  }
}
