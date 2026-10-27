# Contributing

Thanks for contributing. Prioritize small contracts, verifiable documentation,
and changes that do not expose listening activity or credentials.

## Environment and installation

- Node `>=24.18.0` for the declared runtime and Node scripts.
- Bun **1.4.2**, per `packageManager`, for the repository's canonical workflow.
- TypeScript **7.0.2**, pinned in `devDependencies`; do not install another version
  globally to replace the lock's copy.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Keep only the canonical `bun.lock`; do not generate locks from other managers in
the repository. Installing the npm distribution with npm/pnpm/yarn/Bun is the
consumer's decision and does not make Bun a runtime dependency of the SDK. Do not
enable dependency lifecycle scripts without explicit review.

## Before changing

Read [ARCHITECTURE.md](ARCHITECTURE.md), [API.md](API.md),
[OAUTH.md](OAUTH.md) and [RESEARCH.md](RESEARCH.md). Preserve existing work. In
collaboration, respect assigned file ownership and coordinate any change to the
public contract before implementing it.

- A client/provider instance must remain bound to one account/grant.
- Do not introduce global credential caching, import-time side effects, framework
  dependency, Node-only imports in the core, or implicit polling.
- Preserve ESM imports with `.js`, declarations, injectable options, and rewritten
  errors. The root must not transitively import OAuth.
- Document parameters, return values, cancellation, and failure modes of any
  altered API.
- Use synthetic fixtures; no token, cookie, or live activity in commits.

## Checks

`bun run check` chains lint, build, typecheck, Node and Bun tests, and package
inspection, per `package.json`. For isolated diagnosis:

```sh
bun run lint
bun run build
bun run typecheck
bun run test
bun run test:bun
node scripts/compat.mjs --install --all
node --test examples/smoke.test.mjs
```

Examples require an up-to-date `dist`. The compatibility command installs the
pinned fixture dependencies in isolated temporary directories; it requires network
access and the explicit `--install` flag. Inspect the output and record what was
actually executed. A successful import does not prove deployment, access policy,
or integration with a real account. Benchmarks (`bun run bench`) are not an SLA.

`bun run test:live` is **opt-in**: do not run it without private test
authorization and credentials. Read the script before providing variables. Do not
replace deterministic tests with a live call, and do not publish personal data in
output.

## Submission and review

State objective, altered files, commands with real results, and pending failures.
Update [CHANGELOG.md](CHANGELOG.md) on public changes. Request independent review;
do not mark a runtime, endpoint, or deployment as validated without reproducible
evidence. Original code is MIT; do not copy implementations whose license is
incompatible or uncertain.

## Publishing and security

Publishing, creating releases, and altering remote services require separate
authorization. Before publishing: configure repository metadata and a private
security channel, confirm npm scope ownership, review the lock/tarball, and obtain
test results. The package's absence from the registry does not prove scope
ownership. Use [SECURITY.md](SECURITY.md) for responsible disclosure.
