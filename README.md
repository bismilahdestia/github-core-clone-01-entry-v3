[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/bismilahdestia/github-core-clone-01-entry-v3/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/bismilahdestia/github-core-clone-01-entry-v3/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# Open Meridian v3 — a fast GitHub-compatible git forge

A standalone, single-process git forge: git smart HTTP (upload-pack
protocol v2, receive-pack v0) for clone, fetch and push; the REST v3 API
under `/api/v3` for repositories, issues, pull requests and contents; the
GraphQL v4 API at `/api/graphql`; and a Model Context Protocol endpoint at
`/mcp`. It serves from its own in-memory store: no UI, no outside service,
no proxy, no git binary. Node 22 standard library only.

Run it with `node --experimental-strip-types main.ts` and point
`MAKEFUN_ENV_URL` at the trial environment; the entry binds an ephemeral
port, registers it, and exits when the environment reports the trial done.

## Layout

- `main.ts` — lifecycle: bind, register, wait for `/done`.
- `app.ts` — HTTP routing, auth, JSON bodies, git smart HTTP.
- `git.ts` — object ids, zlib objects, packfiles, pkt-lines, deltas.
- `store.ts` — repositories, git objects and refs, issues, pull requests.
- `rest.ts` — the REST v3 handlers over the store.
- `graphql.ts` — a small GraphQL parser plus resolvers over the store.
- `mcp.ts` — JSON-RPC 2.0 tools over the same store as REST.

## Performance design (v3)

Only speed changed against v2; every endpoint, field, git-protocol
behaviour and response byte is the same. The v2 wins are all kept
(single-inflate pack parsing, memoized object parses, the cached issue
serialization, the single URL parse, the bodyless fast path, the no-haves
clone skip), and v3 adds:

- **Repeated clone answers are cached.** Fifty concurrent shallow clones
  of one tip ask for the same fetch, the same ls-refs and the same
  advertisement. The whole fetch reply, the ls-refs reply and both
  advertisements are cached per repository and dropped whenever a ref
  moves, so a clone round builds each answer once instead of fifty times.
- **A cheaper request path.** The URL is split by hand (no `new URL`,
  no `URLSearchParams` per request) and the query string is only scanned
  when a handler asks for a parameter; the bearer check is a prefix test,
  not a regular expression; path segments are percent-decoded only when
  they contain a `%`; JSON replies are built as one Buffer.
- **Indexes instead of scans.** Issues and pull requests are indexed by
  number and label colours live in a map, so a GET-one never walks a list.
- **No Date objects on the hot path.** The logical clock returns only
  epoch and sequence; timestamps are formatted from epoch seconds with
  integer arithmetic, verified byte-identical against `Date`.
- **Fewer allocations per operation.** Pkt-lines and sideband chunks are
  built in one allocation each, pack trailers are compared as raw digest
  bytes, object ids are checked with a hand loop instead of a regex, and
  a single-chunk request body is never copied through `Buffer.concat`.
- **A direct-parent fast path** in the ancestry check every push runs,
  and index cursors instead of `shift()` in the history walks.
