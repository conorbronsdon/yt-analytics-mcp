# AGENTS.md

The repository contract for every agent runtime. Codex and other runtimes read this file directly; Claude Code reads it through `CLAUDE.md`, which imports it.

Working notes for agents (and humans) editing this repo. Every rule below either names the check that enforces it or is marked **unenforced**.

## What this is

An MCP server wrapping the YouTube Analytics API v2. Nine tools, all reads, all scoped to the channel the OAuth credential owns.

## The invariants

**Every tool stays read-only.**
Enforced: the "advertises no write tool at all" test in `src/__tests__/annotations.e2e.test.ts` filters a real `tools/list` for anything without `readOnlyHint: true` and asserts the list is empty. The "must-fail control" test beside it injects a fake `yt_delete_everything` tool, proving the filter can go red. Adding a write tool fails CI.

**The server can only read `channel==MINE`.**
Enforced: `YouTubeClient.buildReportUrl` in `src/client.ts` writes `ids=channel==MINE` unconditionally, and the `ReportQuery` interface has no `ids` field, so an override is not expressible. The "cannot be overridden" test in `src/__tests__/client.test.ts` passes a hostile `ids` past the type and asserts the built URL is still MINE. Do not reintroduce `q.ids ?? "channel==MINE"` — a default is not an invariant.

**No write path in the HTTP client.**
Enforced by construction: `src/client.ts` issues only `fetch(url, { headers })` with no `method`, so every request is a GET. Unenforced by a test — if you add a `method` option, nothing currently fails. Treat the `YouTubeClient` class comment in `src/client.ts` as the contract.

**stdout stays clean JSON-RPC.**
Enforced by review, not by CI: there are zero `console.log` calls in `src/` (verify with `grep -rn "console\.log" src/ | grep -v __tests__`, which must print nothing). All diagnostics use `console.error`.

**Computed values are labelled.**
Any response field the server calculated is listed under `computedFields` alongside the API's own numbers — see the `yt_traffic_sources`, `yt_geography` and `yt_episode_race` responses in `src/server.ts` (`grep -n computedFields src/server.ts`). Required by YouTube's Developer Policies §III.E.4.h, which prohibits passing derived metrics off as API data. **Unenforced** by any test; it is a review gate.

## Testing

`npm test` runs vitest with `fetch` stubbed (`vi.stubGlobal`, e.g. the "access token minting" tests in `src/__tests__/auth.test.ts`). No network calls.

Assertions pin exact values — the built query string, the exact annotation object — not shapes. A shape assertion passes every same-shape mutation and is not evidence. Carve-outs get a must-fail leg beside the must-pass one.

`node scripts/smoke.mjs` drives every tool against the real API with a real credential. Not part of `npm test`; it needs a credential and makes live calls.

## Gates

`npm run lint && npm run build && npm test` — all three run in CI on ubuntu and windows across Node 20 and 22 (`.github/workflows/ci.yml`). Branch protection should require only the `ci-passed` aggregate check.

## The API disagrees with its own docs

Verify any new dimension/metric combination against the live API before wiring it. Known traps, all verified live rather than inferred:

- The retention report accepts a comma-separated video list and silently returns only the first video's curve with HTTP 200. This server rejects lists.
- `impressions`, `impressionsCtr`, and unique viewers do not exist in the Analytics API, only in Studio.
- Video-ranked reports require an explicit sort and cap at 200 rows; month grouping requires whole-month boundaries.
