# Phase 4 — Wave 4: Daemon + Routes + MCP Server + Alaya-Original CLI

Phase 4 lands the runtime body. Daemon entry, route registration, MCP
server with real transport, the SSE-strip rewrite of upstream daemon
glue, and the **Alaya-original CLI features** (install / attach /
profile / secrets / operations / trust-state / doctor / status) which
have no upstream source and are all `requires-redesign` per invariant
§24 and user decision 2026-04-28.

This is the phase that turns the v0.1 build from "compiles and tests
green" into "actually works for a user".

## Card Groups

### 4A. Daemon Core (sequential first)

| Card ID | Subject | Port mode |
|---|---|---|
| P4-daemon-skeleton | `apps/core-daemon/{package.json, tsconfig.json, src/index.ts, src/app.ts}` skeleton. Strip GUI/TUI references. | adapt-and-port |
| P4-daemon-startup-ordering | `apps/core-daemon/src/{garden-runtime.ts, daemon-runtime-helpers.ts, worker-runtime-wiring.ts, background/bootstrap.ts}`. Implements daemon startup ordering per `docs/handbook/architecture.md §Daemon Startup Ordering`. SSE pipeline in background/bootstrap.ts is stripped (see P4-sse-strip). | adapt-and-port |
| P4-sse-strip | **Strip all SSE** from `apps/core-daemon/src/sse/`, `apps/core-daemon/src/routes/runs.ts` (TransformStream block), `apps/core-daemon/src/event-publisher` chain (the daemon-side SSE plumbing) per invariant §11. Preserve EventLog → audit ordering; replace SSE notify with `AlayaRuntimePort` listeners. | requires-redesign |

### 4B. Routes (parallel after 4A)

Upstream daemon has ~32 routes under `apps/core-daemon/src/routes/`.
After SSE-strip and surface-trim, Alaya needs the memory + governance
+ workspace + run + soul subset. Each batch lists the routes it owns
(card author enumerates exact files).

| Card ID | Routes |
|---|---|
| P4-routes-memory | memory-related routes (memory queries, recall, evidence) |
| P4-routes-governance | governance + green-status + lease + override routes |
| P4-routes-soul | soul / topology / garden routes |
| P4-routes-workspace | workspace + run routes (post-SSE-strip) |
| P4-routes-config | config / engine-binding / extension-descriptor routes |

Each batch card lists exact source file paths under
`vendor/do-what-new-snapshot/apps/core-daemon/src/routes/` and the
SSE-strip Adapter Points if the route had SSE.

### 4C. Daemon Auxiliary (parallel after 4A)

Upstream daemon has many auxiliary files outside routes. These were
missed in the pre-review plan; review B3 caught it. Each gets an owner
card here.

| Card ID | Files |
|---|---|
| P4-daemon-services | `apps/core-daemon/src/services/{principal-coding-availability.ts, environment-status-service.ts, embedding-status-service.ts, soul-topology-audit-service.ts}` |
| P4-daemon-glue | `apps/core-daemon/src/{manifestation-context-lens-assembler.ts, orphan-query.ts, handoff-gap-adapter.ts}` |
| P4-daemon-middleware | `apps/core-daemon/src/middleware/error-handler.ts` and any other middleware |
| P4-mcp-tooling | `apps/core-daemon/src/{daemon-mcp-tooling.ts, mcp-runtime-registry.ts, mcp-catalog.ts}` (moved here from Phase 3 per review B2). MCP tool catalog and registry. |

### 4D. MCP Server (depends on 4A + 4C)

| Card ID | Subject | Port mode |
|---|---|---|
| P4-mcp-server | Real MCP server transport (stdio + optional HTTP). Lets Codex / Claude Code attach to Alaya. | adapt-and-port |

### 4E. Alaya-Original CLI Features (all requires-redesign)

These have **no upstream source**. Each is `requires-redesign` with §0
citing invariants §21-§24 and `architecture.md §Surface Shape`. See
task-card-template Worked Example C.

| Card ID | Subject |
|---|---|
| P4-cli-bridge | `bin/alaya.mjs` Alaya-original CLI entry. Subcommand dispatch shell. Replaces upstream `bin/do-what.mjs` (which only knew `cli` / `app` for upstream surfaces). |
| P4-cli-doctor | `alaya doctor` — Alaya runtime + storage + provider health JSON report. Mirrors upstream `pnpm doctor:host` shape but Alaya-internal. |
| P4-cli-install | `alaya install` — interactive first-run setup (DB path, provider config skeleton, audit init). |
| P4-cli-status | `alaya status` — daemon up/down, current trust state per attached agent, Garden last-pass timestamp. |
| P4-attach-codex | `alaya attach codex` — preview + confirm write to `~/.codex/config.toml` MCP server entry. |
| P4-attach-claude | `alaya attach claude-code` — preview + confirm write to `~/.claude.json` MCP server entry. |
| P4-profile-mutation | Profile read/write engine that backs `attach`. Audit-recorded preview + confirm + atomic write per invariant §23. |
| P4-secrets | Secret-ref resolution: env adapter + local-file adapter. OS keychain deferred to backlog #BL-09. |
| P4-trust-state | Trust state machine producer (ContextDeliveryRecord, UsageProofRecord, trust state transitions installed/configured/delivered/used/skipped/unverifiable/mixed). Required by invariant §20 (`delivered ≠ used`); has no upstream owner. |
| P4-operations | Operations command surface: `alaya backup` (local snapshot), `alaya export` (portable bundle), `alaya import` (restore). Audit-recorded. |

### 4F. Daemon Barrel (sequential last)

| Card ID | Subject |
|---|---|
| P4-daemon-routes-register | Update `apps/core-daemon/src/app.ts` to register every Phase 4 route. Sequential; runs after all P4-routes-* close. |

## Gate-4 Acceptance

End-to-end demo on real daemon (no mocks):

1. `pnpm exec alaya install` — daemon config initialized.
2. `pnpm exec alaya attach codex` — diff printed, `[y/N]` asked, on
   `y` writes Codex MCP config atomically.
3. From inside Codex, an MCP tool call to alaya writes a memory.
4. A second Codex tool call retrieves the memory via recall.
5. Governance can reject a candidate (HITL flow visible).
6. Garden runs at least one Auditor pass without blocking the
   foreground.
7. `pnpm exec alaya status` reports trust state for attached Codex
   (delivered count, used count, last-seen timestamp).
8. `pnpm exec alaya doctor` reports green for storage / runtime / MCP
   transport / Garden.

All must pass on a real daemon. Code-map and runtime-status updated.

## Parallelism Notes

Inside Phase 4:

```
4A.1: P4-daemon-skeleton (sequential first)
4A.2: P4-daemon-startup-ordering, P4-sse-strip (parallel after 4A.1)
4B + 4C + 4D + 4E: parallel after 4A.2 closes
4F: sequential last (after all 4B routes close)
```

Maximum concurrency in 4B+4C+4D+4E: ~10 codex.

## Risks

This is the highest-risk phase because:

- It integrates everything for the first time.
- 10 of the cards are `requires-redesign` (Alaya-original) — no port
  reference, design must be reviewed against invariants.
- SSE-strip touches files that other cards in 4B / 4C also touch;
  P4-sse-strip MUST land before any 4B / 4C card that touches the
  same files.

Allocate time for a fix-loop pass after 4A and before opening 4B/4C/4D.
