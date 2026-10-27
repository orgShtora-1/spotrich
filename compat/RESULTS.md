# Observed local evidence — 2026-10-27

The former tooling-only handoff is superseded by integrated checks against the
implemented SDK and its actual npm tarball. Host: Windows x64, Node **24.18.0**,
npm **11.16.0**, Bun **1.4.2**, TypeScript **7.0.2**.

## Passed

- Frozen root install with lifecycle scripts disabled; synchronized `bun.lock`.
- `bun run check`: source policy/syntax, real ESM/declaration build, strict types,
  **288 Node tests and 288 Bun tests**, and isolated installed-package checks.
- Separate strict Bundler consumer, in addition to NodeNext.
- `bun audit --audit-level=low`: zero known vulnerabilities in the root lock's
  21 packages. Fixture toolchains are a separate dependency surface.
- `node scripts/compat.mjs --install --all`:
  - **workers:** actual workerd dispatch, no Node compatibility/globals and zero
    external requests, consuming the installed tarball.
  - **next:** Next 16.4.3 / React 19.3.1 production webpack build, `next start`,
    and HTTP request to the dynamic App Router Node route; mocked Spotify.
  - **vercel:** official EdgeVM local execution of installed-package bundle and
    fetch event, no Node globals and zero external requests; **not a deployment**.
- Mocked benchmark request counts: 1000 uncached / 1 settled cache / 40 groups of
  25 coalesced reads per 1000 operations. No timing or live-latency guarantee.

## Not established

Authenticated Spotify, real consent/account eligibility, deployed Cloudflare or
Vercel behavior, Linux CI, Deno/browser matrix, deprecated Next Edge, registry
publication and npm scope ownership remain unverified. No deployment, publication
or release was performed or authorized.

The public [verification record](VERIFICATION.md) contains the command
results, benchmark measurements, security evidence boundaries and remaining host
responsibilities. [README.md](../README.md) explains how to reproduce these fixtures.
