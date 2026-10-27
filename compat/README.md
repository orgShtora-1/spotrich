# Packed-artifact compatibility checks

These fixtures consume **the actual `npm pack --ignore-scripts` tarball**, installed
as `"@shtora/spotrich": "file:./spotrich.tgz"`. They never import `src`, alias the
checkout, contact Spotify, or deploy anything. Dependencies are private to the
fixtures; the published SDK has no runtime dependencies.

## Commands

Use supported Node 24.18.0/npm and Bun 1.4.2. From the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
node scripts/check.mjs
node --test scripts/tooling.test.mjs
node scripts/compat.mjs --install --all
```

The compatibility command requires **explicit installation permission**:

```sh
node scripts/compat.mjs --install workers
node scripts/compat.mjs --install next
node scripts/compat.mjs --install vercel
node scripts/compat.mjs --install workers next vercel --keep
```

With no arguments it prints a guide and exits **2**; no tests have run. A requested
target fails if dependencies, lockfiles, native binaries, builds, requests, or
assertions fail. There are no silent compatibility skips. `--help` only prints the
guide. `--keep` preserves the generated consumers and prints their location for
diagnosis; it does not change fixture source files.

The harness allocates `spotrich-compat-*` beneath
`C:\Users\airshakur88\AppData\Local\Temp\opencode` on this Windows host (the same
profile-relative approved location on Windows), or the OS temporary directory in
Linux CI. It copies the selected template, shared Web-only smoke test, and tgz
there. `npm ci --ignore-scripts --no-audit --no-fund` installs from the committed
fixture lockfile. Tooling and transitive integrity pins stay unchanged. **Only the
local SDK entry's integrity is rebound to the inspected current tgz, in the temp
lockfile**, so an old committed artifact hash cannot test stale SDK code. The SDK
version must still match the committed binding; version changes require explicit
lockfile maintenance. Root configs, root lockfiles, and all source are untouched.

No install lifecycle script is enabled, including esbuild/workerd/sharp scripts.
Native executables must be supplied by their locked platform-specific optional
packages. A missing/unsupported binary is a failure to investigate, not permission
to run postinstall/download scripts or weaken the test. Install requires public npm
registry access; compatibility runtimes use injected responses. The Workers and
EdgeVM runners also reject any accidental outbound request. npm user/global
configuration is isolated and credential-like environment variables are removed
from fixture children. Do not add secrets or cloud account bindings to these tests.
The Next runner loads its platform SWC binding before invoking the build, failing
early rather than authorizing Next's optional WASM-download fallback. The binding
preflight runs in a child process: loading a `.node` DLL in the harness itself would
keep its Windows file locked and prevent removal of the isolated consumer.

## What each target establishes

| Target | Local evidence produced when it passes | Not established |
| --- | --- | --- |
| `workers` | esbuild browser bundle of installed tgz; **actual workerd** HTTP dispatch through Miniflare; `compatibilityFlags: []`; no `process`/`Buffer`; zero outbound requests | Cloudflare deployment, production bindings/quotas, all compatibility dates |
| `next` | Next App Router **production `next build --webpack`**, `next start` on loopback, HTTP request to dynamic Node route | Vercel/other host deployment, React hooks, a real authenticated Spotify account |
| `vercel` | official `@edge-runtime/vm` executes a browser/IIFE bundle and dispatches a fetch event without Node globals; zero outbound requests | A real Vercel isolate, Vercel deployment, production limits or platform authorization |

Every target exercises root, `/oauth`, and `/http`, independent account token
injection, coalescing, cache, the three mocked read endpoints, authorization before
reads, private/no-store responses, Web Crypto PKCE and mocked callback/refresh.
Clients are destroyed and runtime processes are disposed. No subscriptions are
started in a request-scoped server/edge handler. Fixture tokens/session headers are
fixed synthetic values, **not a production authorization recipe**.

### Deprecated Next Edge experiment

```sh
node scripts/compat.mjs --install next-edge
```

Current Next documentation marks `runtime = 'edge'` **deprecated**. This optional
target copies `compat/next/edge-route.js` into the temp App Router tree, builds,
starts, and requests both routes. It is deliberately separate from the required
`--all` targets. Failure is reported, never silently retried as Node compatibility.
Next may inject a limited process/env shim: this experiment does not claim absence
of Node-shaped globals or prove a Vercel isolate. Prefer the default Node runtime
for new Next integrations.

## Package and type gates

The core policy scanner is a conservative, dependency-free lexical gate, **not a
TypeScript parser, a full secret scanner, or proof of side-effect freedom**. It
rejects Node/bare/remote imports, dynamic imports, eval/Function, logging/Node
globals, hard-coded credential literals, mutable module caches, and unreviewed
import-time execution. Typechecking and executable packed-import probes provide
independent checks. Security review remains necessary.

`node benchmarks/core.mjs` checks request counts for sequential uncached reads,
settled cache hits, and concurrent coalescing, using injected 204 responses only.
It prints host-dependent timing samples, not live Spotify latency or comparisons
against other SDKs. `BENCH_OPERATIONS` must be a multiple of 25 (25–100000).

## Optional real-account check

`node scripts/live.mjs` does nothing unless **`SPOTIFY_LIVE_TEST=1`**. Set credentials
privately in the host environment, never in files/command history committed here:

- `SPOTIFY_ACCESS_TOKEN`; or
- `SPOTIFY_CLIENT_ID` and `SPOTIFY_REFRESH_TOKEN` (PKCE), with optional server-only
  `SPOTIFY_CLIENT_SECRET` for the confidential flow.

The grant needs `user-read-currently-playing`, `user-read-playback-state`, and
`user-read-recently-played`, plus current account/app eligibility. A refresh may
rotate the token: this opt-in smoke is **not a durable token-storage integration**;
use a disposable test grant, not a production grant shared with another host. The
script performs only the three official read endpoints, never logs credentials or
listening payloads, and destroys its client in `finally`. It is not part of CI.
OAuth consent/callback in a real browser, six-month grant lifetime, eligibility and
remote production checks remain host-owned acceptance gates.

## Pinned API/version evidence (2026-10-27)

- [Miniflare stable metadata](https://registry.npmjs.org/miniflare/4.20260730.0),
  [versioned API reference](https://unpkg.com/miniflare@4.20260730.0/README.md):
  Miniflare **4.20260730.0**, workerd **1.20260730.1**, compatibility date
  **2026-07-30**. This deliberately uses the stable Miniflare API, not a guessed
  renamed Vitest-pool plugin. Current Wrangler 4.153.0 resolves Miniflare 5 beta;
  Wrangler/Vitest are unnecessary for this minimal real-workerd test.
- [esbuild metadata](https://registry.npmjs.org/esbuild/0.28.2): **0.28.2**,
  platform-specific optional binaries; fixtures use its documented `build` API.
- [Next metadata](https://registry.npmjs.org/next/16.4.3),
  [React](https://registry.npmjs.org/react/19.3.1),
  [React DOM](https://registry.npmjs.org/react-dom/19.3.1): **16.4.3 / 19.3.1**.
  [Route runtime](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#runtime),
  [Edge deprecation](https://nextjs.org/docs/messages/edge-runtime-deprecated),
  [CLI](https://nextjs.org/docs/app/api-reference/cli/next).
- [`@edge-runtime/vm` metadata](https://registry.npmjs.org/@edge-runtime%2fvm/5.0.0):
  **5.0.0**, primitives **6.0.0**;
  [official VM documentation](https://edge-runtime.vercel.app/packages/vm),
  [EdgeVM implementation](https://github.com/vercel/edge-runtime/blob/main/packages/vm/src/edge-vm.ts):
  `evaluate`, `dispatchFetch`, response `waitUntil`, and default disabled string
  code generation. This is Node `vm` emulation, not a security sandbox.
- [Bun 1.4.2 install](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/pm/cli/install.mdx),
  [lifecycle boundary](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/pm/lifecycle.mdx),
  [audit semantics](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/pm/cli/audit.mdx).

Context7 was queried for these API concepts. Nested specialist delegation was
unavailable (coordinator failure and subagent depth limit), so primary documents
were checked directly; no specialist result is claimed. See
`../.github/ACTION_PINS.md` for verified immutable CI action references. Documentation
evidence alone is not a passing runtime result; the commands must actually run.
