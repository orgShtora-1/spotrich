# Security policy

## Support status

`0.1.0` is an initial pre-release version. There is currently no support window
or announced SLA. Do not interpret the existence of this file as independent
audit, Spotify approval, or a guarantee of production readiness.

## Private reporting — pending configuration

The official repository and a monitored private channel **have not yet been
configured**. The maintainer must define the repository identity and enable
private vulnerability reporting, or publish a verified security contact, before
distributing the package. No report address or URL is assumed here.

Until that channel exists, do not send sensitive details to public issues, public
chats, or an inferred address. Ask the maintainer for a verified private channel
without attaching secrets. A contribution to configure this process does not
authorize npm publication.

When reporting, include version, runtime, affected surface, impact, and a minimal
reproduction with synthetic data. Never include Client Secret, access/refresh
token, session cookie, OAuth code, `state`, verifier, or full callback URL. Do
not test third-party accounts, endpoints, or infrastructure without authorization.

## If a secret leaked

1. Revoke the affected authorization on Spotify; rotate the Client Secret when
   applicable and terminate compromised sessions.
2. Remove sensitive data from logs, caches, artifacts, and observability systems.
   Deleting a file from the codebase does not invalidate an already-exposed token.
3. Force re-authorization only for the affected account; do not reuse a
   compromised grant.
4. Investigate account isolation and store permissions before reactivating.

See [the threat model and host controls](SECURITY.md) and
[OAuth storage contracts](OAUTH.md#storage-contracts).
