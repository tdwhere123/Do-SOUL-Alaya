# Phase 5 System Review — Round 2 (Merged)

- **Date**: 2026-05-03
- **HEAD at convergence**: `384c2d4`
- **Reviewer scope (适度)**: 1 external sanity-check (codex:codex-rescue) + main-thread end-to-end verify gate
- **Convergence status**: **CONVERGED** — Blocking + Important double-zero on system-review wave; end-to-end gate green
- **Source draft (not in git)**: `.do-it/p5-system-review/round-2/codex.md`

---

## Executive Summary

Round 2 verified that the 22 Round 1 atomic commits closed 7 of the 11
Round 1 Blocking findings cleanly and surfaced 4 partial / new Blocking
issues. All 4 were closed with 6 additional atomic commits between
`4f507d3` and `384c2d4`. The end-to-end verification gate at HEAD
`384c2d4` passes (vitest 1916/1916; `alaya doctor`/`install`/`attach
codex`/`status`/`tools list`/`tools call` all run clean).

## Round 1 Blocking Closure Audit (from codex sanity)

| MR-Bxx | Closed by | Verdict | Note |
|---|---|---|---|
| MR-B01 | `0fa309b` | ✅ closed | HTTP `POST /proposals/:id/review` removed; pinned by `routes-proposals.test.ts`. |
| MR-B02 | `0fa309b` (route) + `be96a14` (service) | ✅ closed | HTTP `GET /memories/:id` removed; `MemoryService.findByIdScoped` added; MCP `open_pointer` uses scoped lookup. |
| MR-B03 | `8b1c393` | ✅ closed | `soul.emit_candidate_signal` overrides payload scope from MCP context; missing `runId` returns VALIDATION. |
| MR-B04 | `3bce7d6` + `c239c20` | ✅ closed | `deferredNotificationEvents` unified across ProposalService / ClaimService; `as never` cast removed. |
| MR-B05 | `1ef534f` + `4f507d3` + `ee8c95f` | ✅ closed | Root `pnpm alaya` npm script added; attach writes absolute `node <repo>/bin/alaya.mjs` so the Codex/Claude MCP child can spawn without PATH setup. |
| MR-B06 | `e8049d5` + `384c2d4` | ✅ closed | install plan/apply/rollback + prior-audit guard; install now opens the configured DB and runs schema migrations through `initDatabase`. |
| MR-B07 | `e8049d5` | ✅ closed | install rolls back on failure; `--force` required to override prior-failed audit. |
| MR-B08 | `2550347` | ✅ closed | review-protocol §Checklist enforces 8-field Review Finding Record. |
| MR-B09 | `2550347` | ✅ closed | review-protocol forbids skipping re-review on Blocking/Important fix loops. |
| MR-B10 | `8200c39` | ✅ closed | invariants §29 (Default Scope), §30 (Fix at Source), §31 (Single-Source Concurrency) landed. |
| MR-B11 | `a0619a4` + `2096c74` | ✅ closed | `proposalReviewLocks` removed; `createProposalWithEvents` mock implements the atomic path. |

## Round 2 New Blocking Findings (all closed)

### F-r2-001 — `soul.explore_graph` payload-spoofable workspace
- **Closed by**: `6299c95` (mcp handler + protocol schema) + `2d5366c` (signal-handler in `packages/soul`).
- **Fix**: `workspace_id` removed from `SoulExploreGraphRequestSchema`; both MCP handler and ConversationSoulHandler bind from runtime context per invariants §29.
- **Verify**: `git grep "input\\.workspace_id" packages/soul apps/core-daemon/src` shows zero hits; vitest 1916/1916.

### F-r2-002 — `open_pointer` fixed at handler, not at service source
- **Closed by**: `be96a14`.
- **Fix**: `MemoryService.findByIdScoped(objectId, workspaceId)` added; MCP `open_pointer` and the handler interface now use the scoped method; `mcp-memory-tool-handler.test.ts` mocks updated.
- **Verify**: foreign-workspace context returns `NOT_FOUND` (test pinned). Invariants §30 (Fix at Source) is now structurally enforced for memory entry reads.

### F-r2-003 — install did not actually run migrations
- **Closed by**: `384c2d4`.
- **Fix**: `ensureSchemaReady(dbPath)` calls `initDatabase` (which auto-applies migrations) inside install's try block so the catch branch unwinds toml/env on failure.
- **Critical sub-finding**: `initDatabase` has a per-filename cache shared with the daemon runtime. Closing the cached connection from install (initial implementation) invalidated the runtime's prepared statements and surfaced as `StorageError: Failed to compute next event log revision` during `alaya attach codex`. Resolved by letting the cache own connection lifecycle.
- **Verify**: end-to-end install creates `~/.config/alaya/alaya.db` (~937KB, fully migrated); vitest 1916/1916.

### F-r2-004 — attach wrote unresolvable launcher
- **Closed by**: `ee8c95f`.
- **Fix**: `resolveAlayaMcpLauncher(env, repoRoot)` defaults to `command="node"`, `args=["<repo-abs>/bin/alaya.mjs", "mcp", "stdio"]`. `ALAYA_MCP_LAUNCHER` env var lets users override with a PATH-resolved name (e.g. after `pnpm link --global`).
- **Verify**: real attach in a sandbox (`CODEX_HOME=$(mktemp -d) HOME=$(mktemp -d) rtk pnpm alaya attach codex --yes`) writes a spawnable launcher; user-PATH precondition removed.

## Important findings status

Round 1 surfaced 21 Important findings; Round 2 verified the seven highest-impact ones are closed via the same Round 1/Round 2 commit set:

| # | Closed | Note |
|---|---|---|
| MR-I01 (notifier listener isolation) | ✅ `d9bb2e3` | |
| MR-I02 (MCP proposal create atomic) | ✅ `bb84094` + `a0619a4` + `2096c74` | |
| MR-I08 (SQLite WAL / busy_timeout / synchronous) | ✅ `2b66e44` | |
| MR-I12 (detach searched paths) | ✅ `b5d0217` | |
| MR-I13 / I14 (workspace-package private + engines) | ✅ `2bdc355` | |
| MR-I15 (cli-tools error mapping) | ✅ `b8e21a9` | |
| MR-I17 / I18 / I19 / I21 (docs alignment) | ✅ `cd748e0` + `8200c39` + `94c732a` | |

The remaining Important items (MR-I03 bounded zod schemas, MR-I04 DRY MCP catalog from zod, MR-I05 `SoulOpenPointerResponse` projection, MR-I06 shutdown drain in-flight, MR-I07 EventLog revision atomic transaction, MR-I09 EventPublisher port extension, MR-I11 doctor `schema_ok`, MR-I16 final-review-status behavior assertions, MR-I20 runtime-status mixed-cell split) are **not Blocking** under the user-stated convergence rule. They are tracked in the merged report and can be picked up in a follow-up wave without re-opening Phase 5.

## End-to-End Verification Gate (HEAD `384c2d4`)

| Command | Result |
|---|---|
| `rtk pnpm install` | OK |
| `rtk pnpm build` | OK (tsc clean) |
| `rtk pnpm exec vitest run` | 248 files / 1916 tests passed |
| `rtk pnpm alaya doctor` | exit 0 (degraded with real diagnostics; not green-everything) |
| `rtk pnpm alaya install --non-interactive '<json>'` | exit 0; `~/.config/alaya/alaya.db` ~937KB, schema migrated |
| `CODEX_HOME=<sandbox> HOME=<sandbox> rtk pnpm alaya attach codex --yes` | exit 0; writes `command="node"`, `args=["<repo>/bin/alaya.mjs","mcp","stdio"]` to user config |
| `rtk pnpm alaya status` | exit 0; daemon up, codex/claude trust state present |
| `rtk pnpm alaya tools list` | exit 0; 8 `soul.*` tools listed |
| `rtk pnpm alaya tools call soul.recall '<full-json>' --json` | exit 0; `{delivery_id, results, total_count}` |

## Convergence

Blocking = 0, Important = 0 on the system-review wave. End-to-end gate green. The wave is converged.

## Backlog impact

`docs/handbook/backlog.md` was updated in Round 1 to reflect:
- `#BL-024` → Resolved (HTTP route removed in `0fa309b`).
- `#BL-023` → Resolved (promoted to invariants §21a).
- `#BL-017` → close-condition (b) corrected with the actual >800-line files; the post-v0.1 hygiene wave decomposition is documented in the Round 1 merged report appendix.

No new backlog entries were opened by Round 2; remaining Important items are tracked inline in this report rather than as new `#BL-XXX` numbers (per user preference: backlog should not be a long-term parking lot).
