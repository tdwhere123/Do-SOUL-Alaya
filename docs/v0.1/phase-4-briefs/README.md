# Phase 4 — Wave 4: Daemon + Routes + MCP Server + Alaya-Original CLI + Memory Inspector

Phase 4 lands the runtime body. Daemon entry, route registration,
first-party MCP memory tools, MCP server with real transport, the
SSE-strip rewrite of upstream daemon glue, and the **Alaya-original CLI
features** (install / attach / detach / profile / secrets / operations /
trust-state / doctor / status / inspect / tools fallback) which have no
upstream source and are all `requires-redesign` per invariant §24 and
user decision 2026-04-28.

On 2026-04-29 the scope was extended per invariant §21 narrowing and
the backlog reshape: the **Memory Inspector** (`apps/inspector` server
+ `alaya inspect` CLI + Gemini-CLI-authored frontend), `alaya detach`,
and the cross-workspace `GlobalMemoryRecallService` cache fix were
brought into v0.1 from the deferred set (closes backlog #BL-010,
#BL-011, #BL-012).

This is the phase that turns the v0.1 build from "compiles and tests
green" into "actually works for a user".

## Card Groups

### 4A. Daemon Core (sequential first)

| Card ID | Subject | Port mode |
|---|---|---|
| P4-daemon-skeleton | `apps/core-daemon/{package.json, tsconfig.json, src/index.ts, src/app.ts}` skeleton. Strip GUI/TUI references. | adapt-and-port |
| P4-daemon-startup-ordering | `apps/core-daemon/src/{garden-runtime.ts, daemon-runtime-helpers.ts, worker-runtime-wiring.ts, background/bootstrap.ts}`. Implements daemon startup ordering per `docs/handbook/architecture.md §Daemon Startup Ordering`. SSE pipeline in background/bootstrap.ts is stripped (see P4-sse-strip). | adapt-and-port |
| P4-sse-strip | **Strip all SSE** from `apps/core-daemon/src/sse/`, `apps/core-daemon/src/routes/runs.ts` (TransformStream block), daemon startup references to upstream `SseManager` and the already-redesigned P2 `EventPublisher` listener boundary per invariant §11. Preserve EventLog → audit ordering; replace SSE notify with `RuntimeNotifier` listeners (interface in `packages/core/src/event-publisher.ts`). | requires-redesign |

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

### 4C. Daemon Auxiliary + Service Fixes (parallel after 4A)

Upstream daemon has many auxiliary files outside routes. These were
missed in the pre-review plan; review B3 caught it. Each gets an owner
card here. Also includes service-level fixes scheduled into v0.1
during the 2026-04-29 backlog reshape.

| Card ID | Files |
|---|---|
| P4-daemon-services | `apps/core-daemon/src/services/{principal-coding-availability.ts, environment-status-service.ts, embedding-status-service.ts, soul-topology-audit-service.ts, config-service.ts, soul-approval-service.ts, workspace-engine-config-repo.ts}` plus daemon helper files |
| P4-daemon-glue | `apps/core-daemon/src/{manifestation-context-lens-assembler.ts, orphan-query.ts, handoff-gap-adapter.ts}` |
| P4-daemon-middleware | `apps/core-daemon/src/middleware/error-handler.ts` and any other middleware |
| P4-mcp-tooling | `apps/core-daemon/src/{daemon-mcp-tooling.ts, mcp-runtime-registry.ts, mcp-catalog.ts}` (moved here from Phase 3 per review B2). Upstream daemon MCP catalog and runtime registry only; it is a prerequisite for, not the closure of, Alaya's first-party memory surface. |
| P4-svc-global-recall-cache | `packages/core/src/global-memory-recall-service.ts` cache invalidation across workspaces. Listens to `memory.created` / `memory.updated` / `memory.deleted` notifier events and invalidates other workspaces' cache entries that reference the affected memory id. Closes backlog #BL-011. |

### 4D. CLI Bridge + Trust State Prerequisites (after 4A)

| Card ID | Subject | Port mode |
|---|---|---|
| P4-cli-bridge | `bin/alaya.mjs` Alaya-original CLI entry. Subcommand dispatch shell. Replaces upstream `bin/do-what.mjs` (which only knew `cli` / `app` for upstream surfaces). | requires-redesign |
| P4-trust-state | Trust state machine producer (ContextDeliveryRecord, UsageProofRecord, trust state transitions installed/configured/delivered/used/skipped/unverifiable/mixed). Required by invariant §20 (`delivered ≠ used`); has no upstream owner. | requires-redesign |

### 4E. MCP Memory Tool Contract (depends on 4A + 4C + 4D)

| Card ID | Subject | Port mode |
|---|---|---|
| P4-mcp-memory-tools | First-party `soul.*` MCP memory tool catalog, schema validation, handler bridge, trust-state delivery / usage proof, and CLI fallback parity (`alaya tools list`, `alaya tools call --json`). Depends on P4-cli-bridge for CLI dispatch. Fixed public namespace: `soul.recall`, `soul.open_pointer`, `soul.emit_candidate_signal`, `soul.propose_memory_update`, `soul.review_memory_proposal`, `soul.apply_override`, `soul.explore_graph`, `soul.report_context_usage`. | requires-redesign |

### 4F. MCP Server (depends on 4A + 4C + 4E)

| Card ID | Subject | Port mode |
|---|---|---|
| P4-mcp-server | Real MCP server transport (stdio + optional HTTP). Lets Codex / Claude Code attach to Alaya and exposes the complete P4-mcp-memory-tools first-party catalog through `tools/list` and `tools/call`. | requires-redesign |

### 4G. Remaining Alaya-Original CLI Features (all requires-redesign)

These have **no upstream source**. Each is `requires-redesign` with §0
citing invariants §21-§24 and `architecture.md §Surface Shape`. See
task-card-template Worked Example C.

| Card ID | Subject |
|---|---|
| P4-cli-doctor | `alaya doctor` — Alaya runtime + storage + provider health JSON report. Mirrors upstream `doctor:host` report shape but Alaya-internal. |
| P4-cli-install | `alaya install` — interactive first-run setup (DB path, provider config skeleton, secret-ref skeleton, audit init). |
| P4-cli-status | `alaya status` — daemon up/down, current trust state per attached agent, Garden last-pass timestamp. |
| P4-cli-detach | `alaya detach codex` / `alaya detach claude-code` — preview + confirm reverse-attach write that removes the Alaya MCP server entry and the `/alaya-inspect` slash registration from the target agent profile. Closes backlog #BL-010. |
| P4-cli-inspect | `alaya inspect [--open]` — start `apps/inspector` HTTP server on `127.0.0.1:5174` with a per-launch random token, print the URL with the token query parameter, optionally open the user's default browser. Memory Inspector entry surface. |
| P4-attach-codex | `alaya attach codex` — preview + confirm write to `~/.codex/config.toml` MCP server entry **and** `/alaya-inspect` slash registration. |
| P4-attach-claude | `alaya attach claude-code` — preview + confirm write to `~/.claude.json` MCP server entry **and** `/alaya-inspect` slash registration. |
| P4-profile-mutation | Profile read/write engine that backs `attach` and `detach`. Audit-recorded preview + confirm + atomic write per invariant §23. |
| P4-secrets | Secret-ref resolution: env adapter + local-file adapter. OS keychain deferred to backlog #BL-009. |
| P4-operations | Operations command surface: `alaya backup` (local snapshot), `alaya export` (portable bundle), `alaya import` (restore). Audit-recorded. |

### 4H. Memory Inspector (depends on 4B + 4C + 4G P4-cli-inspect)

The Memory Inspector is a local-only memory-tooling surface authorized
by the 2026-04-29 narrowing of invariant §21. It provides the
provider/runtime config write surface, the memory-graph viewer, and a
read-only trust/status mirror; it never participates in agent control
flow. Closes backlog #BL-012.

Listens on `127.0.0.1:5174` only, with a per-launch random token in
the URL query string. Inspector writes are limited to daemon runtime
parameters (provider URL, secret-ref, embedding model id, SoulConfig /
StrategyConfig / EnvironmentConfig); memory ontology writes still go
through `soul.propose_memory_update` per invariant §19.

| Card ID | Subject | Port mode |
|---|---|---|
| P4-inspector-server | `apps/inspector/{package.json, tsconfig.json, src/server.ts, src/auth.ts, src/routes/*.ts, src/__tests__/*.ts}` HTTP server, token middleware, JSON proxy to daemon HTTP routes (read: graph + trust-state + config; write: config only), static asset hosting for the frontend bundle. | requires-redesign |
| P4-inspector-frontend | `apps/inspector/web/{package.json, vite.config.ts, src/App.tsx, src/pages/Config.tsx, src/pages/Graph.tsx, src/pages/Status.tsx, src/api.ts}` 3-page SPA. **Implementation explicitly delegated to Gemini CLI.** The Alaya owner authors §0-§3 of the card and reviews the Gemini output for: (a) write paths only hit the Provider/Config endpoints (no memory CRUD), (b) the page does not introduce any agent-flow UI per §21, (c) audit / trust-state flows match the daemon contract. The Gemini handoff process is documented in the card's §2 Required Behavior. | requires-redesign |

### 4I. Daemon Barrel (sequential last)

| Card ID | Subject |
|---|---|
| P4-daemon-routes-register | Update `apps/core-daemon/src/app.ts` to register every Phase 4 route. Sequential; runs after all P4-routes-* close. |

## Gate-4 Acceptance

End-to-end demo on real daemon (no mocks):

1. `rtk pnpm exec alaya install` — daemon config initialized.
2. `rtk pnpm exec alaya attach codex` — diff printed, `[y/N]` asked, on
   `y` writes Codex MCP config atomically and registers the
   `/alaya-inspect` slash alias.
3. From inside Codex, `tools/list` returns the complete first-party
   memory tool set from P4-mcp-memory-tools.
4. Codex calls `soul.recall`, opens at least one returned pointer with
   `soul.open_pointer`, and then records `soul.report_context_usage`
   against the recall delivery id.
5. Codex emits a candidate through `soul.emit_candidate_signal`, then
   submits a durable-memory update through `soul.propose_memory_update`.
6. Governance can reject the proposal through
   `soul.review_memory_proposal` (HITL flow visible).
7. Garden runs at least one Auditor pass without blocking the
   foreground.
8. `rtk pnpm exec alaya status` reports trust state for attached Codex
   (delivered count, used / skipped / not-applicable count,
   last-seen timestamp).
9. `rtk pnpm exec alaya tools list` and
   `rtk pnpm exec alaya tools call --json` prove CLI fallback parity
   with the MCP tool contract.
10. `rtk pnpm exec alaya doctor` reports green for storage / runtime / MCP
    transport / Garden.
11. `rtk pnpm exec alaya inspect` — Inspector server starts on
    `127.0.0.1:5174` with a per-launch token; the printed URL opens
    successfully in a browser. The Provider/Config page can PATCH the
    `OPENAI_API_KEY` secret-ref and `OPENAI_EMBEDDING_MODEL`, and the
    daemon's `/embedding-status` flips from `provider_unconfigured`
    to `embedding_supplement` after a daemon restart. The Memory
    Graph page renders the P5-graph-contract `soul_graph` payload.
    The Trust/Status page mirrors `alaya status` output. Requests
    without the token return 401.
12. Inserting / updating / deleting a memory in workspace A causes
    `GlobalMemoryRecallService` cache entries in workspace B that
    reference that memory id to invalidate within one notifier
    delivery (closes #BL-011).
13. `rtk pnpm exec alaya detach codex` — preview shows the entries
    that will be removed (MCP server + `/alaya-inspect` slash); on
    `y` writes atomically and Codex no longer sees Alaya tools.

All must pass on a real daemon. Code-map and runtime-status updated.

## Parallelism Notes

Inside Phase 4:

```
4A.1: P4-daemon-skeleton (sequential first)
4A.2: P4-daemon-startup-ordering, P4-sse-strip (parallel after 4A.1)
4B + 4C + 4D: parallel after 4A.2 closes where write sets allow
4E: after P4-mcp-tooling, P4-daemon-services, P4-daemon-glue, P4-cli-bridge, P4-trust-state, P3-conversation, and P3-core-barrel
4F + 4G: after 4E closes
4H.server (P4-inspector-server): after 4B routes (config / soul) and P4-cli-inspect close
4H.frontend (P4-inspector-frontend): after P4-inspector-server closes; Gemini-CLI authoring runs against the closed server contract
4I: sequential last (after all 4B routes and 4H close)
```

Maximum concurrency in 4B+4C+4D+4G: ~10 codex. 4H.frontend is offloaded
to Gemini CLI so it does not consume a codex slot.

## Risks

This is the highest-risk phase because:

- It integrates everything for the first time.
- Several cards are `requires-redesign` (Alaya-original or
  Alaya-divergent) — no direct port reference, design must be reviewed
  against invariants.
- SSE-strip touches files that other cards in 4B / 4C also touch;
  P4-sse-strip MUST land before any 4B / 4C card that touches the
  same files.

Allocate time for a fix-loop pass after 4A and before opening 4B/4C/4D.
