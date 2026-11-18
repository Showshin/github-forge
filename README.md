[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Showshin/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Showshin/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-forge

A self-contained, GitHub-compatible forge written for
[make.fun's “Build a GitHub-compatible git forge” bounty](https://make.fun/bounty/github-core-clone-01).
It implements the four surfaces the contest scores, using only the Node.js standard library and no
external processes:

- **git smart HTTP v2** — `info/refs`, `git-upload-pack` and `git-receive-pack`, with real git
  objects (blobs, trees, commits, packfiles) built and parsed in TypeScript.
- **REST v3** — repositories, branches, commits, contents, issues, comments, labels, pull requests,
  files and merges under `/api/v3`.
- **GraphQL v4** — the documents `gh` and `github-mcp-server` send, including Relay global IDs,
  connections, introspection and the create/close/merge mutations.
- **MCP** — Streamable HTTP at `/mcp`, with the 2026-07-28 `server/discover` era and a legacy
  `initialize` fallback, plus six repository/issue/pull-request tools.

The entry also registers with the harness at `MAKEFUN_ENV_URL`, binds an ephemeral port, and exits
when the trial says it is done. It targets Node 22.18 and up.

## Run it

```sh
node --experimental-strip-types main.ts
```

There is nothing to install: the program imports `node:http` and its own `app.ts` only, and the trial
has no package manager and no internet.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3 |
| `POST /api/graphql` | GitHub GraphQL v4 |
| `POST /mcp` | Model Context Protocol over streamable HTTP |
| `/<owner>/<repo>.git/...` | git smart HTTP |
| anything else | 404 `{"message":"Not Found"}` |

Every API call except the health probe carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Local verification

`run_suite.ps1` starts the contest's own environment and bot, then writes the suite's export to
`state/export/state.json` and its performance tiers to `state/export/perf.json`. The current
implementation passes **120/120 conformance checks** and **200/200 performance points** locally.

## Rules and layout

The rules, scoring weights, deadline and prizes are on the
[contest page](https://make.fun/bounty/github-core-clone-01). The trial runs Node 22 only, with no
dependencies, no internet and no `git` binary; the repository is mounted read-only at `/bot`.

- `main.ts` — the harness lifecycle (register, wait for done, exit).
- `app.ts` — the forge: git objects, smart HTTP, REST, GraphQL and MCP.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT) — metadata and licence.

Built by an AI agent for make.fun. The starter is MIT licensed; this entry carries its own MIT
licence.
