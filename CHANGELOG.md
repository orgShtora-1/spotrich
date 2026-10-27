# Changelog

Relevant project changes. Version follows Semantic Versioning; the `0.x` series
may still have incompatible changes, which should be recorded here.

## [0.1.1] — 2026-10-27

### Added

- **`/sse` subpath** — `createSpotifySSE(options)` and `handleSSEResponse(request, options)` for real-time Server-Sent Events streaming of playback snapshots and progress
- SSE stream emits typed events: `open` (connection established), `track` (snapshot), `progress` (ProgressEstimate), `error` (with `willRetry`)
- Configurable heartbeat interval (`heartbeatMs`, default 15 s) to prevent proxy timeouts
- Configurable progress update interval (`progressIntervalMs`, default 1 s) for smooth progress bars
- Optional `market` parameter for territory-aware track availability
- SSE stream auto-cleans up on client disconnect via `AbortController` and `client.destroy()`
- Package exports now include `./sse` subpath alongside existing `.` `./oauth` e `./http`

### Fixed

- **A01**: 429 cooldown with numeric `Retry-After` is now protected against concurrency; `QUOTA_EXCEEDED` responses without reset do not wipe known deadlines installed by concurrent callers.
- **A02**: The rate-limit gate uses a monotonic clock for verification, preventing wall-clock jumps (forward or backward) from inappropriately bypassing or extending cooldowns.
- **A03**: The flight is registered in the `flights` map before invoking host callbacks (fetch / provider); a synchronous `destroy()` inside those callbacks now aborts the flight immediately instead of letting the timer run until timeout.
- **A04**: Vulnerable transitive dependencies (`sharp`, `undici`) are pinned via `overrides` in the Workers compatibility package.json.
- **A05**: Import graph regex now captures multiline `from` clauses in ESM, preventing incomplete graphs during artifact generation.
- **A06**: Isolated env filter changed from a blacklist to an explicit allowlist, rejecting `SPOTIFY_TOKEN`, `BOTO_*`, `CYPRESS_*`, and `SUPABASE_*`.

## [0.1.0] — 2026-10-27

### Added

- Headless ESM client with zero runtime dependencies for current playback, player state, and recent track history.
- Discriminated and immutable snapshots with track/local/episode/ad/unknown items and local progress estimation separated from observed data.
- Per-account cache, request coalescing, independent cancellation, limited GET retries, and instance-shared cooldown.
- Opt-in subscriptions with adaptive polling and explicit resource termination.
- `/oauth` subpath with server-mediated PKCE/confidential flows, session-linked transactions, and refresh persistence/serialization contracts.
- `/http` subpath with host authorization boundary and private/no-store responses.
- Documentation and Node/Bun and Web Request deny-by-default examples.
- MIT license for original code.

### Release Pending Items

- Unauthorized publication; repository metadata, private security channel, and ownership of `@shtora` need to be configured/verified by the maintainer.
- Compatibility, local fixtures, and authenticated tests must be evaluated by the evidence level of [COMPATIBILITY.md](COMPATIBILITY.md), not this list.
- No remote deploy or authenticated Spotify integration with credentials is asserted here.
