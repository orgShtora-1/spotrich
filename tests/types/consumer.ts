import { createSpotifyClient, SpotifyError } from '@shtora/spotrich';
import type {
  AccessTokenProvider, DiagnosticEvent, NowPlaying, PlaybackItem,
  ProgressEstimate, SpotifyClient, SubscriptionEvent,
} from '@shtora/spotrich';
import { createNowPlayingHandler } from '@shtora/spotrich/http';
import {
  createMemoryTransactionStore, createSpotifyOAuth, createTokenProvider,
} from '@shtora/spotrich/oauth';
import type {
  OAuthCallbackOptions, OAuthTransaction, SpotifyOAuthOptions, TokenSet, TokenStore,
} from '@shtora/spotrich/oauth';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;

export type SnapshotContract = Assert<Equal<Awaited<ReturnType<SpotifyClient['getNowPlaying']>>, NowPlaying>>;
export type SnapshotIsStrict = Assert<Equal<IsAny<NowPlaying>, false>>;
export type CallbackIsStrict = Assert<Equal<IsAny<OAuthCallbackOptions>, false>>;
export type ListenerCancellation = Assert<Equal<ReturnType<SpotifyClient['subscribe']>, () => void>>;
export type PollingState = Assert<Equal<ReturnType<SpotifyClient['getPollingStatus']>['state'], 'idle' | 'polling' | 'stopped' | 'destroyed'>>;

function expect<T>(value: T): void { void value; }

export function narrowItem(item: PlaybackItem): void {
  // @ts-expect-error an unknown/ad item has no common duration
  expect(item.durationMs);
  switch (item.kind) {
    case 'track':
    case 'local':
      expect<string | undefined>(item.artists[0]?.name);
      expect<string | null | undefined>(item.album?.id);
      // @ts-expect-error tracks are not episodes
      expect(item.show);
      break;
    case 'episode':
      expect<string | null | undefined>(item.show?.publisher);
      expect<number | null>(item.durationMs);
      // @ts-expect-error episodes are not tracks
      expect(item.artists);
      break;
    case 'ad':
    case 'unknown':
      expect<string>(item.type);
      // @ts-expect-error unknown media does not invent a title
      expect(item.name);
      break;
    default:
      expect<never>(item);
  }
}

export function narrowSnapshot(snapshot: NowPlaying): void {
  // @ts-expect-error status must be narrowed before accessing an item
  expect(snapshot.item.kind);
  if (snapshot.status === 'empty') {
    expect<null>(snapshot.item);
    expect<false>(snapshot.isPlaying);
    expect<null>(snapshot.progressMs);
  } else if (snapshot.status === 'unavailable') {
    expect<null>(snapshot.item);
    expect<boolean>(snapshot.isPlaying);
  } else {
    narrowItem(snapshot.item);
    // @ts-expect-error snapshots are immutable
    snapshot.isPlaying = false;
  }
}

export function narrowSubscription(event: SubscriptionEvent): void {
  if (event.type === 'update') {
    narrowSnapshot(event.snapshot);
    expect<boolean>(event.changed);
    // @ts-expect-error only error events expose an error
    expect(event.error);
  } else {
    expect<SpotifyError>(event.error);
    expect<boolean>(event.willRetry);
    // @ts-expect-error error events do not contain playback data
    expect(event.snapshot);
  }
}

export function narrowDiagnostic(event: DiagnosticEvent): void {
  if (event.type === 'request') expect<number>(event.status);
  // @ts-expect-error diagnostics cannot expose credentials
  expect(event.accessToken);
}

// Compile-only functions: no network, OAuth, or polling is executed by this file.
export async function consumer(provider: AccessTokenProvider, signal: AbortSignal, request: Request): Promise<void> {
  const client: SpotifyClient = createSpotifyClient({ auth: provider, onDiagnostic: narrowDiagnostic });
  const unsubscribe: () => void = client.subscribe(narrowSubscription, { signal });
  unsubscribe();
  expect<Promise<NowPlaying>>(client.getNowPlaying({ signal, market: 'ES', fresh: true }));
  expect<Promise<NowPlaying>>(client.refresh({ signal }));
  expect<ProgressEstimate>(client.getProgress());
  // @ts-expect-error cancellation is listener-scoped, not a global unsubscribe method
  client.unsubscribe();
  // @ts-expect-error only AbortSignal can cancel a poll subscription
  client.subscribe(narrowSubscription, { signal: new AbortController() });
  // @ts-expect-error exact optional properties reject a present undefined signal
  client.subscribe(narrowSubscription, { signal: undefined });
  // @ts-expect-error listener event parameters are checked contravariantly
  client.subscribe((_event: { type: 'wrong' }) => {});
  const handler = createNowPlayingHandler({ authorize: async (_request: Request) => client });
  expect<Response>(await handler(request));
  // @ts-expect-error authorize must return an account client or null
  createNowPlayingHandler({ authorize: () => 'access-token' });
  client.destroy();
}

export async function oauthConsumer(signal: AbortSignal, store: TokenStore): Promise<void> {
  const transactions = createMemoryTransactionStore();
  const oauth = createSpotifyOAuth({
    mode: 'pkce', clientId: 'compile-only', redirectUri: 'https://app.example/callback', transactions,
  });
  const callback: OAuthCallbackOptions = { sessionId: 'compile-session', url: new URL('https://app.example/callback'), signal };
  expect<Promise<TokenSet>>(oauth.handleCallback(callback));
  // @ts-expect-error callbacks must be bound to a server session
  oauth.handleCallback({ url: callback.url, signal });
  // @ts-expect-error pkce forbids a client secret
  expect<SpotifyOAuthOptions>({ mode: 'pkce', clientId: 'compile-only', clientSecret: 'not-a-secret', redirectUri: 'https://app.example/callback', transactions });
  // @ts-expect-error confidential OAuth requires its secret
  expect<SpotifyOAuthOptions>({ mode: 'confidential', clientId: 'compile-only', redirectUri: 'https://app.example/callback', transactions });
  const provider: AccessTokenProvider = createTokenProvider({ mode: 'pkce', clientId: 'compile-only', store });
  expect<Promise<string>>(provider.getAccessToken({ signal, rejectedAccessToken: 'compile-only' }));
  // @ts-expect-error token providers use either store or refreshToken, never both
  createTokenProvider({ mode: 'pkce', clientId: 'compile-only', store, refreshToken: 'compile-only' });
}

export function narrowTransaction(transaction: OAuthTransaction): void {
  if (transaction.mode === 'pkce') expect<string>(transaction.codeVerifier);
  else expect<undefined>(transaction.codeVerifier);
  // @ts-expect-error persisted transaction bindings cannot be mutated
  transaction.sessionId = 'different-session';
}
