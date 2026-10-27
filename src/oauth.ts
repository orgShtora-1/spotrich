import { SpotifyError } from './errors.js';
import type { AccessTokenProvider, AccessTokenRequest } from './types.js';

export type { AccessTokenProvider, AccessTokenRequest } from './types.js';

export type OAuthCredentials =
  | { readonly mode: 'pkce'; readonly clientSecret?: never }
  | { readonly mode: 'confidential'; readonly clientSecret: string };

interface TransactionBinding {
  readonly sessionId: string;
  readonly state: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Unix milliseconds. Hosts must enforce this when consuming persisted state. */
  readonly expiresAt: number;
}

export type OAuthTransaction = TransactionBinding & (
  | { readonly mode: 'pkce'; readonly codeVerifier: string }
  | { readonly mode: 'confidential'; readonly codeVerifier?: never }
);

export interface ConsumeTransactionOptions {
  readonly sessionId: string;
  readonly state: string;
}

/** Server-side storage. consume must atomically find AND delete the bound state. */
export interface TransactionStore {
  put(transaction: OAuthTransaction): Promise<void>;
  consume(options: ConsumeTransactionOptions): Promise<OAuthTransaction | null>;
}

export interface MemoryTransactionStoreOptions {
  readonly now?: () => number;
  /** Live entries are never evicted to admit another login; a full store fails. */
  readonly maxEntries?: number;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly scope: readonly string[];
  readonly tokenType: 'Bearer';
  /** Initial local authorization time, or null for a refresh-only seed. */
  readonly authorizedAt: number | null;
}

/**
 * Bound to exactly one user/grant; use secure, host-owned persistence.
 * Host I/O must settle with its own deadlines; a pending save is never canceled.
 * clear/save acknowledgments must be atomic and crash-durable. Before a refresh
 * POST, clear quarantines the old grant; only a successful save makes it reusable.
 */
export interface TokenStore {
  load(): Promise<TokenSet | null>;
  save(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

interface TokenTransportOptions {
  readonly clientId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export type SpotifyOAuthOptions = OAuthCredentials & TokenTransportOptions & {
  readonly redirectUri: string;
  readonly transactions: TransactionStore;
  readonly transactionTtlMs?: number;
};

export interface AuthorizationUrlOptions {
  readonly sessionId: string;
  readonly scopes?: readonly string[];
}

export interface OAuthCallbackOptions {
  readonly url: string | URL;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

export interface SpotifyOAuth {
  getAuthorizationUrl(options: AuthorizationUrlOptions): Promise<string>;
  handleCallback(options: OAuthCallbackOptions): Promise<TokenSet>;
}

/** All grant writers share this lock through clear/POST/save; leased locks need fenced writes. */
export type RefreshLock = <T>(operation: () => Promise<T>) => Promise<T>;

export type TokenProviderOptions = OAuthCredentials & TokenTransportOptions & (
  | { readonly refreshToken: string; readonly store?: never }
  | { readonly store: TokenStore; readonly refreshToken?: never }
) & {
  readonly withRefreshLock?: RefreshLock;
};

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const DEFAULT_SCOPES: readonly string[] = Object.freeze(['user-read-currently-playing']);
const RESPONSE_PARAMS = new Set(['code', 'state', 'error', 'error_description', 'error_uri']);
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

function serverOnly(): void {
  if ('window' in globalThis) {
    throw new SpotifyError('CONFIG', 'OAuth credentials and state require a server environment.');
  }
}

function configuration(message: string): never {
  throw new SpotifyError('CONFIG', message);
}

function stateError(): never {
  throw new SpotifyError('OAUTH_STATE', 'OAuth callback or transaction is invalid.');
}

function storageError(): SpotifyError {
  return new SpotifyError('STORAGE', 'OAuth storage or refresh serialization failed.');
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function positiveInteger(value: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function clockNow(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    return configuration('The OAuth clock failed.');
  }
  if (!timestamp(value)) configuration('The OAuth clock must return Unix milliseconds.');
  return value;
}

function scopes(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !SCOPE_TOKEN.test(value))) {
    configuration('OAuth scopes must be individual nonempty scope names.');
  }
  return Object.freeze([...new Set(values)]);
}

function session(value: string): void {
  if (!opaque(value)) configuration('An opaque server session identifier is required.');
}

function parseRedirect(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configuration('A valid absolute OAuth redirect URI is required.');
  }
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = authority !== undefined && (
    /^127\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})(?::\d+)?$/.test(authority)
      && url.hostname === authority.replace(/:\d+$/, '')
    || /^\[[\da-f:.]+\](?::\d+)?$/i.test(authority) && url.hostname === '[::1]'
  );
  if (/[\x00-\x20\x7f\\]/.test(value) || value.includes('#') || authority === undefined || authority === ''
    || authority.includes('@') || url.username !== '' || url.password !== ''
    || hostname === 'localhost' || hostname.endsWith('.localhost')
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    configuration('OAuth redirects require HTTPS, or an explicit loopback IP using HTTP, without userinfo or fragments.');
  }
  for (const key of RESPONSE_PARAMS) {
    if (url.searchParams.has(key)) configuration('The redirect query must not contain OAuth response parameters.');
  }
  return url;
}

function callbackUrl(value: string | URL, redirect: URL): URL {
  const raw = typeof value === 'string' ? value : value.href;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return stateError();
  }
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1];
  if (/[\x00-\x20\x7f\\]/.test(raw) || raw.includes('#') || authority === undefined || authority === '' || authority.includes('@')
    || url.username !== '' || url.password !== '' || url.origin !== redirect.origin
    || url.pathname !== redirect.pathname) stateError();
  for (const key of RESPONSE_PARAMS) {
    if (url.searchParams.getAll(key).length > 1) stateError();
  }
  const actual = new URLSearchParams(url.search);
  for (const key of RESPONSE_PARAMS) actual.delete(key);
  const keys = new Set([...redirect.searchParams.keys(), ...actual.keys()]);
  for (const key of keys) {
    const expectedValues = redirect.searchParams.getAll(key);
    const actualValues = actual.getAll(key);
    if (expectedValues.length !== actualValues.length
      || expectedValues.some((entry, index) => entry !== actualValues[index])) stateError();
  }
  return url;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(length: number): string {
  try {
    return base64url(globalThis.crypto.getRandomValues(new Uint8Array(length)));
  } catch {
    return configuration('Web Crypto is required for OAuth state and PKCE.');
  }
}

async function challenge(verifier: string): Promise<string> {
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64url(new Uint8Array(digest));
  } catch {
    return configuration('Web Crypto SHA-256 is required for PKCE.');
  }
}

interface Transport {
  readonly credentials: OAuthCredentials;
  readonly clientId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly timeoutMs: number;
}

function transport(options: OAuthCredentials & TokenTransportOptions): Transport {
  serverOnly();
  if (!opaque(options.clientId) || options.clientId.includes(':')) configuration('A valid OAuth client ID is required.');
  let credentials: OAuthCredentials;
  if (options.mode === 'pkce' && options.clientSecret === undefined) {
    credentials = { mode: 'pkce' };
  } else if (options.mode === 'confidential' && opaque(options.clientSecret)) {
    credentials = { mode: 'confidential', clientSecret: options.clientSecret };
  } else {
    return configuration('Choose PKCE without a secret, or confidential OAuth with a client secret.');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!positiveInteger(timeoutMs, 2_147_483_647)) configuration('OAuth timeoutMs must be a positive timer duration.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  if (typeof fetcher !== 'function' || typeof now !== 'function') configuration('OAuth requires fetch and a clock.');
  return { credentials, clientId: options.clientId, fetch: fetcher, now, timeoutMs };
}

function authenticate(config: Transport, params: URLSearchParams): Headers {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });
  if (config.credentials.mode === 'pkce') {
    params.set('client_id', config.clientId);
  } else {
    headers.set('authorization', `Basic ${base64(new TextEncoder().encode(`${config.clientId}:${config.credentials.clientSecret}`))}`);
  }
  return headers;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One POST, including its response body, bounded even when an injected fetch ignores abort. */
async function tokenPost(config: Transport, params: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
  serverOnly();
  throwIfAborted(signal);
  const headers = authenticate(config, params);
  const controller = new AbortController();
  let rejectCancellation: (error: Error) => void = () => {};
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const onAbort = (): void => {
    rejectCancellation(abortError());
    controller.abort();
  };
  const timeout = setTimeout(() => {
    rejectCancellation(new SpotifyError('TIMEOUT', 'The OAuth token request timed out.'));
    controller.abort();
  }, config.timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const operation = async (): Promise<unknown> => {
      let response: Response;
      try {
        response = await config.fetch(TOKEN_URL, {
          method: 'POST', headers, body: params, signal: controller.signal,
          redirect: 'error', cache: 'no-store', credentials: 'omit',
        });
      } catch {
        throw new SpotifyError('NETWORK', 'The OAuth token request failed.', { transient: true });
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        if (response.ok) throw new SpotifyError('INVALID_RESPONSE', 'The OAuth token response is invalid.');
      }
      if (!response.ok) {
        if (record(data) && data['error'] === 'invalid_grant') {
          throw new SpotifyError('AUTH_REQUIRED', 'Spotify authorization is required.');
        }
        if (response.status === 429) {
          throw new SpotifyError('RATE_LIMITED', 'The OAuth token request was rate limited.', { status: 429, transient: true });
        }
        throw new SpotifyError('HTTP', 'The OAuth token request was rejected.', {
          status: response.status, transient: response.status >= 500,
        });
      }
      return data;
    };
    return await Promise.race([operation(), cancellation]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function tokenSet(data: unknown, now: number, previous: {
  readonly refreshToken: string | null;
  readonly scope: readonly string[];
  readonly authorizedAt: number | null;
}): TokenSet {
  const invalid = (): never => { throw new SpotifyError('INVALID_RESPONSE', 'The OAuth token response is invalid.'); };
  if (!record(data) || !opaque(data['access_token'])
    || typeof data['token_type'] !== 'string' || !/^Bearer$/i.test(data['token_type'])
    || typeof data['expires_in'] !== 'number' || !positiveInteger(data['expires_in'])
    || !timestamp(now + data['expires_in'] * 1000)) return invalid();
  let granted = previous.scope;
  if (data['scope'] !== undefined) {
    if (typeof data['scope'] !== 'string') return invalid();
    const list = data['scope'] === '' ? [] : data['scope'].split(' ');
    if (list.some((value) => !SCOPE_TOKEN.test(value))) return invalid();
    granted = Object.freeze([...new Set(list)]);
  }
  if (data['refresh_token'] !== undefined && !opaque(data['refresh_token'])) return invalid();
  const refreshToken = data['refresh_token'] === undefined ? previous.refreshToken : data['refresh_token'];
  if (refreshToken !== null && !opaque(refreshToken)) return invalid();
  return Object.freeze({
    accessToken: data['access_token'], refreshToken, expiresAt: now + data['expires_in'] * 1000,
    scope: Object.freeze([...granted]), tokenType: 'Bearer', authorizedAt: previous.authorizedAt,
  });
}

/** Process-local only. No timers, shared globals, or persistence across restarts. */
export function createMemoryTransactionStore(options: MemoryTransactionStoreOptions = {}): TransactionStore {
  serverOnly();
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1000;
  if (typeof now !== 'function' || !positiveInteger(maxEntries)) configuration('A clock and positive transaction capacity are required.');
  const entries = new Map<string, OAuthTransaction>();
  const key = (value: ConsumeTransactionOptions): string => JSON.stringify([value.sessionId, value.state]);
  const prune = (): void => {
    const time = clockNow(now);
    for (const [id, value] of entries) if (value.expiresAt <= time) entries.delete(id);
  };
  return {
    async put(transaction) {
      serverOnly();
      prune();
      const id = key(transaction);
      if (entries.size >= maxEntries || entries.has(id) || !timestamp(transaction.expiresAt)
        || transaction.expiresAt <= clockNow(now)) throw storageError();
      entries.set(id, Object.freeze({ ...transaction, scopes: Object.freeze([...transaction.scopes]) }));
    },
    async consume(options) {
      serverOnly();
      prune();
      const id = key(options);
      const transaction = entries.get(id) ?? null;
      entries.delete(id);
      return transaction;
    },
  };
}

/** Both flows are server-mediated: never put a transaction or verifier in frontend storage. */
export function createSpotifyOAuth(options: SpotifyOAuthOptions): SpotifyOAuth {
  const config = transport(options);
  const redirectUri = options.redirectUri;
  if (typeof redirectUri !== 'string') configuration('A valid absolute OAuth redirect URI is required.');
  const redirect = parseRedirect(redirectUri);
  const transactions = options.transactions;
  if (typeof transactions?.put !== 'function' || typeof transactions.consume !== 'function') {
    configuration('An atomic server-side OAuth transaction store is required.');
  }
  const transactionTtlMs = options.transactionTtlMs ?? 600_000;
  if (!positiveInteger(transactionTtlMs)) configuration('transactionTtlMs must be positive Unix milliseconds.');
  return {
    async getAuthorizationUrl(input) {
      serverOnly();
      session(input.sessionId);
      const requestedScopes = scopes(input.scopes ?? DEFAULT_SCOPES);
      const state = randomString(32);
      const expiresAt = clockNow(config.now) + transactionTtlMs;
      if (!timestamp(expiresAt)) configuration('The OAuth transaction expiry is invalid.');
      const binding: TransactionBinding = {
        state, sessionId: input.sessionId, clientId: config.clientId, redirectUri, expiresAt, scopes: requestedScopes,
      };
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri,
        state, scope: requestedScopes.join(' '),
      }).toString();
      let transaction: OAuthTransaction;
      if (config.credentials.mode === 'pkce') {
        const codeVerifier = randomString(64);
        transaction = Object.freeze({ ...binding, mode: 'pkce', codeVerifier });
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('code_challenge', await challenge(codeVerifier));
      } else {
        transaction = Object.freeze({ ...binding, mode: 'confidential' });
      }
      try {
        await transactions.put(transaction);
      } catch {
        throw storageError();
      }
      return url.href;
    },
    async handleCallback(input) {
      serverOnly();
      throwIfAborted(input.signal);
      session(input.sessionId);
      const url = callbackUrl(input.url, redirect);
      const state = url.searchParams.get('state');
      if (!opaque(state)) stateError();
      let transaction: OAuthTransaction | null;
      try {
        transaction = await transactions.consume({ sessionId: input.sessionId, state });
      } catch {
        throw storageError();
      }
      if (!record(transaction) || transaction.state !== state || transaction.sessionId !== input.sessionId
        || transaction.clientId !== config.clientId || transaction.redirectUri !== redirectUri
        || transaction.mode !== config.credentials.mode || !timestamp(transaction.expiresAt)
        || transaction.expiresAt <= clockNow(config.now)
        || !Array.isArray(transaction.scopes) || transaction.scopes.some((value) => typeof value !== 'string' || !SCOPE_TOKEN.test(value))
        || (transaction.mode === 'pkce' && !/^[A-Za-z\d._~-]{43,128}$/.test(transaction.codeVerifier))
        || (transaction.mode === 'confidential' && transaction.codeVerifier !== undefined)) stateError();
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error !== null) {
        if (!opaque(error) || code !== null) stateError();
        throw new SpotifyError('OAUTH_DENIED', 'Spotify authorization was denied.');
      }
      if (!opaque(code)) stateError();
      throwIfAborted(input.signal);
      const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      if (transaction.mode === 'pkce') params.set('code_verifier', transaction.codeVerifier);
      const data = await tokenPost(config, params, input.signal);
      const time = clockNow(config.now);
      return tokenSet(data, time, { refreshToken: null, scope: transaction.scopes, authorizedAt: time });
    },
  };
}

function storedTokens(value: TokenSet | null): TokenSet | null {
  if (value === null) return null;
  if (!record(value) || !opaque(value['accessToken'])
    || (value['refreshToken'] !== null && !opaque(value['refreshToken']))
    || !timestamp(value['expiresAt']) || value['tokenType'] !== 'Bearer'
    || (value['authorizedAt'] !== null && !timestamp(value['authorizedAt']))
    || !Array.isArray(value['scope'])
    || value['scope'].some((entry: unknown) => typeof entry !== 'string' || !SCOPE_TOKEN.test(entry))) throw storageError();
  return Object.freeze({
    accessToken: value['accessToken'], refreshToken: value['refreshToken'], expiresAt: value['expiresAt'],
    scope: Object.freeze([...value['scope']] as string[]), tokenType: 'Bearer', authorizedAt: value['authorizedAt'],
  });
}

/** Cancellation detaches this caller only; it must never discard a rotated refresh token. */
function waitFor<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(abortError()); };
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort); };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (result) => { cleanup(); resolve(result); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

interface RefreshResult {
  readonly tokens: TokenSet;
  readonly refreshed: boolean;
}

export function createTokenProvider(options: TokenProviderOptions): AccessTokenProvider {
  const config = transport(options);
  const store = options.store;
  let seed: string | null = options.refreshToken ?? null;
  if ((store === undefined) === (seed === null) || (seed !== null && !opaque(seed))
    || (store !== undefined && (typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.clear !== 'function'))
    || (options.withRefreshLock !== undefined && typeof options.withRefreshLock !== 'function')) {
    configuration('Provide exactly one refresh token or account-bound TokenStore, and an optional refresh lock.');
  }
  const lock: RefreshLock = options.withRefreshLock ?? ((operation) => operation());
  let cached: TokenSet | null = null;
  let terminal: SpotifyError | null = null;
  let flight: Promise<RefreshResult> | null = null;
  const usable = (tokens: TokenSet | null, rejected: string | undefined): boolean => (
    tokens !== null && tokens.expiresAt > clockNow(config.now) && tokens.accessToken !== rejected
  );
  const failStorage = (): never => {
    cached = null;
    seed = null;
    terminal = storageError();
    throw terminal;
  };
  const refresh = async (rejected: string | undefined): Promise<RefreshResult> => {
    let operationFailure: unknown;
    let completed: RefreshResult | undefined;
    try {
      const result = await lock(async () => {
        try {
          // Another instance may have rotated this grant while this caller waited for the host lock.
          let current = cached;
          if (store !== undefined) {
            try { current = storedTokens(await store.load()); } catch { return failStorage(); }
          }
          if (current !== null && usable(current, rejected)) {
            cached = current;
            completed = { tokens: current, refreshed: false };
            return completed;
          }
          const refreshToken = current?.refreshToken ?? (store === undefined ? seed : null);
          if (refreshToken === null) {
            terminal = new SpotifyError('AUTH_REQUIRED', 'Spotify authorization is required.');
            throw terminal;
          }
          // Write-ahead invalidation: a crash, ambiguous POST or failed save must
          // not leave the old refresh token available to a reconstructed provider.
          // A failed durable clear prevents dispatch altogether.
          if (store !== undefined) {
            try { await store.clear(); } catch { return failStorage(); }
          }
          cached = null;
          seed = null;
          const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
          let tokens: TokenSet;
          try {
            const data = await tokenPost(config, params);
            tokens = tokenSet(data, clockNow(config.now), {
              refreshToken, scope: current?.scope ?? [], authorizedAt: current?.authorizedAt ?? null,
            });
          } catch (error) {
            // Never restore the old record based merely on an HTTP status.
            terminal = error instanceof SpotifyError
              ? new SpotifyError(error.code, error.message, { ...(error.status === undefined ? {} : { status: error.status }) })
              : new SpotifyError('AUTH_REQUIRED', 'Spotify authorization is required.');
            throw terminal;
          }
          if (store !== undefined) {
            try { await store.save(tokens); } catch { return failStorage(); }
          }
          cached = tokens;
          seed = tokens.refreshToken;
          completed = { tokens, refreshed: true };
          return completed;
        } catch (error) {
          operationFailure = error;
          throw error;
        }
      });
      if (completed === undefined || result !== completed) return failStorage();
      return result;
    } catch (error) {
      if (operationFailure !== undefined && error === operationFailure) throw error;
      return failStorage();
    }
  };
  const acquire = async (rejected: string | undefined): Promise<string> => {
    if (terminal !== null) throw terminal;
    if (flight === null && cached !== null && usable(cached, rejected)) return cached.accessToken;
    if (flight === null) {
      const running = refresh(rejected);
      flight = running;
      // A rejection handler is installed even when every waiting caller cancels.
      void running.then(
        () => { if (flight === running) flight = null; },
        () => { if (flight === running) flight = null; },
      );
    }
    const result = await flight;
    // A concurrent initial load may have returned the very token rejected by this caller.
    if (!result.refreshed && result.tokens.accessToken === rejected) return acquire(rejected);
    return result.tokens.accessToken;
  };
  return {
    async getAccessToken(input: AccessTokenRequest = {}) {
      serverOnly();
      throwIfAborted(input.signal);
      return waitFor(acquire(input.rejectedAccessToken), input.signal);
    },
  };
}
