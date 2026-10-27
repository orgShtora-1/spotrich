# Examples

Small examples with no extra dependencies and no open server/listener by
default. Only the CLIs make a real Spotify call when executed with valid
credentials; do not run without authorization. Web modules deny access by
default. There is no React hook, SSE client, or built-in session implementation.

## Local preparation

At the repository root, with Bun **1.4.2**:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
```

Imports use public subpaths via self-reference, so `dist` needs to be up to date.
To copy an example to another application, install the package (or the authorized
local tarball), copy the helper modules, and adjust paths. Public examples and
`.env.example` are also included in the npm tarball; they are neither exported
entrypoints nor a ready-made authentication service. Publishing/deploy is not
authorized by these instructions.

Copy [.env.example](../.env.example) to a private `.env` and replace placeholders;
never version this file or enable public prefixes. Use a secret store on the host.
There are no usable credentials in the examples.

## Node and Bun CLI — single owner

| File | Behavior |
| --- | --- |
| [now-playing.mjs](now-playing.mjs) | One snapshot; `status`/`item.kind` and `destroy` in finally |
| [poll.mjs](poll.mjs) | Polling for at most 60 s, SIGINT/SIGTERM, unsubscribe, and destroy; progress marked as estimate |

Choose your runtime; these commands **can access your real account**:

```sh
node --env-file=.env examples/now-playing.mjs
node --env-file=.env examples/poll.mjs

bun run examples/now-playing.mjs
bun run examples/poll.mjs
```

Bun reads local `.env`; alternatively, inject variables via the host. Node uses
`--env-file` in this example. CLIs require `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REFRESH_TOKEN`, with confidential grant and
`user-read-currently-playing`. They do not print tokens, upstream errors, or OAuth
URLs; the title displayed in the terminal remains personal data of the owner.

**Deliberate limit:** the refresh seed stays only on the instance. A rotation is
not saved to `.env`, so subsequent runs may need a new token. Do not turn this
example into a multi-user cron/service nor blindly reuse an old seed. Production
uses a [durable TokenStore and per-grant lock](OAUTH.md#storage-contracts).

## Web adapters

- [web/handler.mjs](web/handler.mjs): request composition of root + `/oauth` +
  `/http`; no user snapshots/credentials in shared global state.
- [web/host.mjs](web/host.mjs): **deny-by-default stub**, not ready-made auth.
- [workers/worker.mjs](workers/worker.mjs): ES module with `fetch(request, env)`.
- [next/route.mjs](next/route.mjs): copy to `app/api/now-playing/route.js` and
  adjust server-only imports; exports only host GET/runtime.
- [vercel/now-playing.mjs](vercel/now-playing.mjs): Web Handler recipe, e.g.,
  `api/now-playing.js` in an ESM app; adjust imports and target project.

To enable access, replace the import of `denyHost` with an adapter of **your own**,
server-only, with these functions:

| Host function | Mandatory contract |
| --- | --- |
| `authorizeRequest(request)` | Validates host session, Origin/CSRF policy, consent, and throttling; returns internal key of authorized grant or `null` |
| `tokenStoreFor(grantKey)` | Returns a durable TokenStore bound to **that** authorization, not a global store that changes users |
| `withGrantLock(grantKey, operation)` | Serializes the entire operation between instances/workers of the same grant, with appropriate deadline and durability |

The key comes from the authenticated session and account binding in the backend,
**never** from `?userId=...`, `?account=...`, or browser-declared identity. For two
authorized sessions A and B, the host derives distinct grants and returns distinct
stores/locks; the handler creates separate clients. Query parameters do not choose
accounts. App secrets are private bindings; user tokens live in stores per grant,
not in a multi-user `SPOTIFY_REFRESH_TOKEN` variable.

Responses are private and have no public cache. The example closes the client in
`finally` and preserves no cache/poller between requests. Rebuilding cost is
intentional in this serverless recipe; quota/cache coordination between processes
is the host's responsibility. Do not expect timers to persist after response.

These files show the integration pattern, **not** proven build/deploy of
Workers/Next/Vercel. See the [compatibility matrix](COMPATIBILITY.md) and
[React/Remix/Astro/SvelteKit/Hono/Express/Fastify recipes](COMPATIBILITY.md#integration-recipes).

## Server-mediated OAuth routes

[oauth/routes.mjs](oauth/routes.mjs) exports `createOAuthRoutes({ env, host,
transactions })`, which returns two Web handlers: `start` (POST) and `callback`
(GET). No listener is opened. The host must mount only at configured paths, use
exact redirects, and disable callback query logs.

Variables: `SPOTIFY_OAUTH_MODE` (`pkce` or `confidential`),
`SPOTIFY_CLIENT_ID`, `SPOTIFY_REDIRECT_URI`, `APP_ORIGIN`; confidential also
requires `SPOTIFY_CLIENT_SECRET`. Origin is trusted operator configuration, not
user Host/returnTo header. PKCE does not pass secrets to the OAuth provider.

The host OAuth adapter must implement:

- `authorizeLinkStart(request)`: same host auth, plus consent and Origin/CSRF
  protection; returns session with opaque `id` or `null`.
- `getSession(request)`: retrieves the **same authenticated session** in the
  callback, not an invented session from state/query.
- `tokenStoreForSession(session)`: durable TokenStore linked to the user/grant of
  that session.
- `withSessionGrantLock(session, operation)`: uses the same coordination as other
  writers/refreshes of this grant and only resolves after durable save.

Provide durable `transactions` with atomic `consume({sessionId, state})`. The
callback persists tokens before redirecting to a fixed host page; no credentials
go to the browser. Start requires POST in the example to allow explicit host
protection; subsequent navigation to Spotify continues via OAuth GET.

**For local development in a single process only**, you can create the
TransactionStore once and keep the same instance between start/callback:

```js
import { createMemoryTransactionStore } from '@shtora/spotrich/oauth';
import { createOAuthRoutes } from './oauth/routes.mjs';

// host remains mandatory: this store DOES NOT create sessions or token persistence.
const transactions = createMemoryTransactionStore(); // LOCAL DEV ONLY
const routes = createOAuthRoutes({ env, host, transactions });
```

Do not recreate this store on every request and do not use it in production,
replicas, or serverless deployments. Restarting loses transactions. In
production, sessions, stores, and locks must be implemented by the host with the
guarantees in [OAUTH.md](OAUTH.md).

## Headless browser consumption

[browser/now-playing.mjs](browser/now-playing.mjs) makes only same-origin fetch of
`/api/now-playing`, with host session, without SDK imports or Spotify credentials.
The function is on-demand and returns sign-in/waiting/failure states without an
automatic loop. Cancel `AbortController` on unmount/navigation and render text,
not metadata HTML. A 401 may require host login or reconnecting Spotify.

A UI choosing to poll periodically must limit requests, honor 429/Retry-After,
handle absence/pause, and obtain proper consent. There is no hook or push channel
implemented here. Host SSE would continue distributing data obtained via Spotify
polling.

## Local smoke without credentials

After build:

```sh
node --test examples/smoke.test.mjs
bun test examples/smoke.test.mjs
```

The smoke uses synthetic Requests and deny-by-default host; does not call Spotify,
does not open ports, and does not validate remote runtime. Tests private denial,
methods, and absence of store access for unauthorized requests. Real framework
execution and authenticated integration are separate gates, not consequences of
this smoke.
