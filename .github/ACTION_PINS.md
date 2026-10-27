# CI action pins

Read-only verification on 2026-10-27 used the official repositories' Git references
and each immutable commit's `action.yml`. No remote workflow was run or deployment
authorized. These are full commit SHAs, not mutable action tags:

| Action | Observed tag | Immutable commit |
| --- | --- | --- |
| `actions/checkout` | `v6` | `d23441a48e516b6c34aea4fa41551a30e30af803` |
| `actions/setup-node` | `v6` | `249970729cb0ef3589644e2896645e5dc5ba9c38` |
| `oven-sh/setup-bun` | `v2` | `0c5077e51419868618aeaa5fe8019c62421857d6` |

Primary evidence:

- [checkout v6 reference](https://api.github.com/repos/actions/checkout/git/ref/tags/v6)
  and [pinned action.yml](https://github.com/actions/checkout/blob/d23441a48e516b6c34aea4fa41551a30e30af803/action.yml).
- [setup-node v6 reference](https://api.github.com/repos/actions/setup-node/git/ref/tags/v6)
  and [pinned action.yml](https://github.com/actions/setup-node/blob/249970729cb0ef3589644e2896645e5dc5ba9c38/action.yml).
- [setup-bun v2 reference](https://api.github.com/repos/oven-sh/setup-bun/git/ref/tags/v2)
  and [pinned action.yml](https://github.com/oven-sh/setup-bun/blob/0c5077e51419868618aeaa5fe8019c62421857d6/action.yml).

All three declare the Node 24 action runtime. Hosted Ubuntu 24.04 jobs install the
SDK's stated Node floor **24.18.0** and Bun **1.4.2**. Installs use committed locks
with lifecycle scripts disabled. The workflow has `contents: read`, no deployment
or publication permissions, no secret inputs, no `pull_request_target`, no shell
interpolation of PR content, and checkout credentials are not persisted. Matrix
values are a fixed local list and passed through a quoted environment variable.

Updates must recheck the official reference and immutable source, review the action
change, and run CI. Do not replace pins with `main`, `latest`, or a floating tag.
Repository branch protection, remote Actions execution, runner availability, and
authenticated Spotify acceptance are host-owned gates, not established by this file.
