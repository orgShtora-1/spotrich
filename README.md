# @shtora/spotrich

Headless client for reading Spotify playback: typed snapshots, server-side OAuth, per-account cache, and adaptive polling. ESM, Web Standards, and **zero runtime dependencies**. It does not play audio or control the player, and does not offer Spotify's global push.

**0.1.0, pre-release.** Publication and ownership of the `@shtora` npm scope still need to be authorized. The commands below describe package consumption when available; they do not assert the package already exists in the registry.

## Installation

```sh
npm install @shtora/spotrich
pnpm add @shtora/spotrich
yarn add @shtora/spotrich
bun add @shtora/spotrich
```

Choose **one** package manager in the consuming application. The package declares Node `>=24.18.0`; Bun is not required to use the npm distribution. In this repository, Bun **1.4.2** and `bun.lock` are the canonical development path.

## First snapshot — server only

Configure the private variables from [.env.example](.env.example). The refresh token must come from an authorization with consent, not from Client Credentials.

```js
import { createSpotifyClient } from '@shtora/spotrich';
import { createTokenProvider } from '@shtora/spotrich/oauth';

function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith('replace_with_')) {
    throw new Error(`Configure ${name} on the server.`);
  }
  return value;
}

// Example backend for a single owner. Never send these variables to the browser.
const auth = createTokenProvider({
  mode: 'confidential',
  clientId: required('SPOTIFY_CLIENT_ID'),
  clientSecret: required('SPOTIFY_CLIENT_SECRET'),
  refreshToken: required('SPOTIFY_REFRESH_TOKEN'),
});
const spotify = createSpotifyClient({ auth });

try {
  const snapshot = await spotify.getNowPlaying();
  if (snapshot.status === 'available') {
    const item = snapshot.item;
    if (item.kind === 'track' || item.kind === 'local' || item.kind === 'episode') {
      console.log(item.name, { isPlaying: snapshot.isPlaying });
    } else {
      console.log(item.kind); // ad or unknown: do not invent title/artist
    }
  } else {
    console.log(snapshot.status); // empty or unavailable; paused is not empty
  }
} finally {
  spotify.destroy();
}
```

The `refreshToken` seed above is kept only on the instance: it does not persist rotations. In production, use a durable `TokenStore` per authorization and, between instances, a durable `withRefreshLock` covering load/clear/POST/save. The old grant is invalidated before the POST; an ambiguous failure may require re-authorization. Do not recreate providers from the same old seed on every request. See [OAuth](OAUTH.md) and the [executable Node/Bun examples](examples/README.md).

## Public surface

| Import | Usage | Reference |
| --- | --- | --- |
| `@shtora/spotrich` | `createSpotifyClient`, `SpotifyError`, types; snapshot, state, history, estimate, and subscription | [API](API.md#root-client) |
| `@shtora/spotrich/oauth` | `createSpotifyOAuth`, `createTokenProvider`, `createMemoryTransactionStore` and store contracts | [OAuth](OAUTH.md) |
| `@shtora/spotrich/http` | `createNowPlayingHandler({ authorize })`, Web Request → private Response | [HTTP](API.md#http-adapter) |

There is no React hook, framework dependency, SSE, or WebSocket. The browser consumes an **authenticated endpoint on your own backend**, never the OAuth provider.
[Workers, Next.js and Vercel](examples/README.md#web-adapters) have deny-by-default modules; [other integrations](COMPATIBILITY.md#integration-recipes) are pattern-based recipes, not compatibility proof.

## Behavior and limits

- Minimal scopes: `user-read-currently-playing`, `user-read-playback-state`, and
  `user-read-recently-played`, as appropriate per method. [Configuration and consent](OAUTH.md#dashboard-and-scopes).
- One instance belongs to **one account/authorization** for its entire lifetime. The host endpoint picks the account by validated session, not by `?user=...`.
- `subscribe()` activates polling while subscribers exist: **5 s** playing,
  **15 s** paused, **30 s** empty by default. There is no detection SLA nor a universally safe interval. Call the unsubscribe function and then `destroy()` when done. Do not start persistent pollers in serverless/edge handlers.
- `getProgress()` is a **local** estimate, explicitly marked; it does not confirm the current position in Spotify and does not guess the next track. [Data semantics](API.md#snapshots-and-items).
- In 2026, Development Mode requires Premium from the **app owner**, normally limits to five authorized users, and allows up to 25 Client IDs, with shared quotas across the developer's apps. Grants expire six months after authorization;
  `invalid_grant` requires new consent. Support for Free users is
  **unverified**. [Sources and restrictions](OAUTH.md#platform-restrictions-in-2026).
- `429` respects `Retry-After`; manual recovery does not ignore the cooldown. Do not put `invalid_grant` or ambiguous refresh failures into a retry loop.
- Listening activity is personal data. Consent to publish, retention, deletion, attribution, and Spotify links are the host's obligations. Local metadata, episodes, ads, and unknown types may be partial or unavailable.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Do not use `npm install` to regenerate the lock for this repository. Local examples need the build (`bun run build`); no tests with a real account are implicit.

## Documentation

- [Full API: root, auth, and HTTP](API.md)
- [OAuth, sessions, and persistence](OAUTH.md)
- [Security model and checklist](SECURITY.md) · [responsible disclosure](SECURITY.md)
- [Compatibility and evidence limitations](COMPATIBILITY.md)
- [Executed verification and synthetic benchmark](VERIFICATION.md)
- [Examples and browser consumption](examples/README.md)
- [Architecture decisions](ARCHITECTURE.md) · [research and official sources](RESEARCH.md)
- [Contribution](CONTRIBUTING.md) · [changelog](CHANGELOG.md) · [MIT](LICENSE)

As of **2026-10-27**, local checks passed with **288 tests on Node and 288 on Bun**, consumers of the npm tarball and workerd/Next/EdgeVM fixtures. EdgeVM is local emulation, not a Vercel deployment. Commands, versions, and limits are in the
[verification record](VERIFICATION.md).

There is no claim of authenticated Spotify integration nor of proven production deployment. Repository metadata, a private security channel, and ownership of the scope are pending items for the maintainer before publication. Independent project, without affiliation or implied approval from Spotify.
