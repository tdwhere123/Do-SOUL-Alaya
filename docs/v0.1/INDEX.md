# Do-SOUL Alaya v0.1 — Task Card Index

This is the active v0.1 task-card work area. v0.1 is a **port** of the
memory subsystem of `do-what-new` into the Alaya monorepo, with
port-first discipline (see `docs/handbook/port-protocol.md`).

For required read order, follow `docs/handbook/workflow/agent-workflow.md`
Per-Card Pipeline.

## Phase Order

```text
Phase 0 → Gate-0
   → Phase 1 (Wave 1, 9 cards) → Gate-1
       → Phase 2 (Wave 2, 32 cards) → Gate-2
           → Phase 3 (Wave 3, 3-4 parallel workers after foundation) → Gate-3
               → Phase 4 (Wave 4, 3-5 parallel cards) → Gate-4
                   → Phase 5 (Wave 5, 1 sequential card) → Gate-5
                       → v0.1 release
```

## Phase Summary

| Phase | Title | Cards | Status | Gate |
|---|---|---|---|---|
| Phase 0 | Reset & Source Mirror | 6 cards (P0-0..P0-5) + P0-3.5 review + P0-3.6 fix + P0-4 extraction | **done** | Gate-0 passed |
| Phase 1 | Wave 1: Leaves | 9 cards | **done** | Gate-1 passed |
| Phase 2 | Wave 2: Services + Garden + Repos + Security | 32 cards | **done** | Gate-2 passed |
| Phase 3 | Wave 3: Memory orchestration bridge + run lifecycle | 6 cards | **done** | Gate-3 passed |
| Phase 4 | Wave 4: Daemon + Routes + MCP Server + Alaya-Original CLI + Memory Inspector | 30 cards (target) | non-frontend `implementation-ready`; frontend pending | Gate-4 pending |
| Phase 5 | Wave 5: E2E + Benchmark + Graph Contract + Final Review | 4 cards (target) | not-started | Gate-5 |

## Phase 2 — Card Closeout Status

This table tracks the 32 Phase 2 cards closed for Gate-2.

Gate-2 closeout evidence: [report](./phase-2-briefs/reports/gate-2-closeout.md).
Post-Gate-2 aggregate review (read-only sub-agent pass; 0 Blocking, 3 Important, 1 Nice-to-have):
[post-gate-2-review](./phase-2-briefs/reports/post-gate-2-review.md).

| Card | Readiness | Report |
|---|---|---|
| P2-repos-batch-1 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-repos-batch-1.md) |
| P2-repos-batch-2 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-repos-batch-2.md) |
| P2-repos-batch-3 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-repos-batch-3.md) |
| P2-repos-batch-4 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-repos-batch-4.md) |
| P2-repos-batch-5 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-repos-batch-5.md) |
| P2-repos-batch-6 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-repos-batch-6.md) |
| P2-barrel-storage | implementation-ready | [report](./phase-2-briefs/reports/task-p2-barrel-storage.md) |
| P2-svc-output-shaping | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-output-shaping.md) |
| P2-svc-event-publisher | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-event-publisher.md) |
| P2-svc-narrative-budget | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-narrative-budget.md) |
| P2-svc-health-journal | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-health-journal.md) |
| P2-svc-evidence | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-evidence.md) |
| P2-svc-signal | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-signal.md) |
| P2-svc-memory | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-memory.md) |
| P2-svc-global-recall | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-global-recall.md) |
| P2-svc-governance-lease | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-governance-lease.md) |
| P2-svc-session-override | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-session-override.md) |
| P2-svc-green | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-green.md) |
| P2-svc-embedding-recall | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-embedding-recall.md) |
| P2-svc-embedding-pipeline | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-embedding-pipeline.md) |
| P2-security-1 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-security-1.md) |
| P2-security-2 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-security-2.md) |
| P2-garden-batch-1 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-garden-batch-1.md) |
| P2-garden-batch-4 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-garden-batch-4.md) |
| P2-svc-task-surface-builder-prelude | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-task-surface-builder-prelude.md) |
| P2-svc-recall | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-recall.md) |
| P2-svc-manifestation | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-manifestation.md) |
| P2-svc-synthesis | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-synthesis.md) |
| P2-svc-proposal | implementation-ready | [report](./phase-2-briefs/reports/task-p2-svc-proposal.md) |
| P2-garden-batch-3 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-garden-batch-3.md) |
| P2-garden-batch-2 | implementation-ready | [report](./phase-2-briefs/reports/task-p2-garden-batch-2.md) |
| P2-barrel-soul | implementation-ready | [report](./phase-2-briefs/reports/task-p2-barrel-soul.md) |

## Phase 3 — Card Closeout Status

This table tracks the 6 Phase 3 cards closed for Gate-3.

Gate-3 closeout evidence: [report](./phase-3-briefs/reports/gate-3-closeout.md).

| Card | Readiness | Report |
|---|---|---|
| P3-misc-foundation | implementation-ready | [report](./phase-3-briefs/reports/task-p3-misc-foundation.md) |
| P3-mcp-discovery | implementation-ready | [report](./phase-3-briefs/reports/task-p3-mcp-discovery.md) |
| P3-run-lifecycle | implementation-ready | [report](./phase-3-briefs/reports/task-p3-run-lifecycle.md) |
| P3-misc-services | implementation-ready | [report](./phase-3-briefs/reports/task-p3-misc-services.md) |
| P3-conversation | implementation-ready | [report](./phase-3-briefs/reports/task-p3-conversation.md) |
| P3-core-barrel | implementation-ready | [report](./phase-3-briefs/reports/task-p3-core-barrel.md) |

## Phase 4 — Non-Frontend Closeout Status

This table tracks the Phase 4 recovery work after the controller
review reset. `P4-inspector-frontend` remains open and is not claimed
by the non-frontend closeout.

Non-frontend closeout evidence: [report](./phase-4-briefs/reports/gate-4-non-frontend-closeout.md).
Historical failure baseline: [review-p4-controller](./phase-4-briefs/reports/review-p4-controller.md).

| Card | Readiness | Report |
|---|---|---|
| P4-daemon-skeleton | implementation-ready | [report](./phase-4-briefs/reports/task-p4-daemon-skeleton.md) |
| P4-daemon-startup-ordering | implementation-ready | [report](./phase-4-briefs/reports/task-p4-daemon-startup-ordering.md) |
| P4-sse-strip | implementation-ready | [report](./phase-4-briefs/reports/task-p4-sse-strip.md) |
| P4-routes-memory | implementation-ready | [report](./phase-4-briefs/reports/task-p4-routes-memory.md) |
| P4-routes-governance | implementation-ready | [report](./phase-4-briefs/reports/task-p4-routes-governance.md) |
| P4-routes-soul | implementation-ready | [report](./phase-4-briefs/reports/task-p4-routes-soul.md) |
| P4-routes-workspace | implementation-ready | [report](./phase-4-briefs/reports/task-p4-routes-workspace.md) |
| P4-routes-config | implementation-ready | [report](./phase-4-briefs/reports/task-p4-routes-config.md) |
| P4-daemon-services | implementation-ready | [report](./phase-4-briefs/reports/task-p4-daemon-services.md) |
| P4-daemon-glue | implementation-ready | [report](./phase-4-briefs/reports/task-p4-daemon-glue.md) |
| P4-daemon-middleware | implementation-ready | [report](./phase-4-briefs/reports/task-p4-daemon-middleware.md) |
| P4-mcp-tooling | implementation-ready | [report](./phase-4-briefs/reports/task-p4-mcp-tooling.md) |
| P4-svc-global-recall-cache | implementation-ready | [report](./phase-4-briefs/reports/task-p4-svc-global-recall-cache.md) |
| P4-cli-bridge | implementation-ready | [report](./phase-4-briefs/reports/task-p4-cli-bridge.md) |
| P4-trust-state | implementation-ready | [report](./phase-4-briefs/reports/task-p4-trust-state.md) |
| P4-mcp-memory-tools | implementation-ready | [report](./phase-4-briefs/reports/task-p4-mcp-memory-tools.md) |
| P4-mcp-server | implementation-ready | [report](./phase-4-briefs/reports/task-p4-mcp-server.md) |
| P4-cli-doctor | implementation-ready | [report](./phase-4-briefs/reports/task-p4-cli-doctor.md) |
| P4-cli-install | implementation-ready | [report](./phase-4-briefs/reports/task-p4-cli-install.md) |
| P4-cli-status | implementation-ready | [report](./phase-4-briefs/reports/task-p4-cli-status.md) |
| P4-cli-detach | implementation-ready | [report](./phase-4-briefs/reports/task-p4-cli-detach.md) |
| P4-cli-inspect | implementation-ready | [report](./phase-4-briefs/reports/task-p4-cli-inspect.md) |
| P4-attach-codex | implementation-ready | [report](./phase-4-briefs/reports/task-p4-attach-codex.md) |
| P4-attach-claude | implementation-ready | [report](./phase-4-briefs/reports/task-p4-attach-claude.md) |
| P4-profile-mutation | implementation-ready | [report](./phase-4-briefs/reports/task-p4-profile-mutation.md) |
| P4-secrets | implementation-ready | [report](./phase-4-briefs/reports/task-p4-secrets.md) |
| P4-operations | implementation-ready | [report](./phase-4-briefs/reports/task-p4-operations.md) |
| P4-inspector-server | implementation-ready | [report](./phase-4-briefs/reports/task-p4-inspector-server.md) |
| P4-daemon-routes-register | implementation-ready | [report](./phase-4-briefs/reports/task-p4-daemon-routes-register.md) |
| P4-inspector-frontend | not-started | pending Gemini CLI implementation |

## Phase 0 — Reset & Source Mirror

Status: **done**. The reset was executed by the Claude Code
main thread. Phase 0 task cards are tracked here only as a record;
their original detail is in the plan file at
`~/.claude/plans/v0-1-do-what-new-codex-ala-r10-r11-linear-pillow.md`.

| Card | Title | Status |
|---|---|---|
| P0-0 | Create `legacy/codex-r1-r9` safety branch | done |
| P0-1 | Nuclear-clear repo (keep `.git`, `.gitignore`, `RTK.md`, `.codex`, `.claude`) | done |
| P0-2 | Rebuild monorepo tooling shell | done |
| P0-5 | Vendor snapshot of do-what-new (memory subset) | done |
| P0-3 | Rebuild `docs/handbook/*` | done |
| P0-3e | This file + `phase-{0..5}-briefs/README.md` | done |
| P0-4 | Write Phase 1-5 task cards | done |
| Gate-0 | Style-uniformity review + commit Phase 0 closure | passed |

## Phase Pointers

- [Phase 0](./phase-0-briefs/README.md) — reset execution log
- [Phase 1](./phase-1-briefs/README.md) — Wave 1 leaves (protocol,
  migrations, storage shared, config, topology, engine-gateway)
- [Phase 2](./phase-2-briefs/README.md) — Wave 2 services + Garden +
  repos + security defense
- [Phase 3](./phase-3-briefs/README.md) — Wave 3 ConversationService
  + MCP discovery + run lifecycle
- [Phase 4](./phase-4-briefs/README.md) — Wave 4 daemon + routes +
  live MCP transport + real profile mutation + CLI bridge + secrets
  + Memory Inspector + cross-workspace recall cache + detach
- [Phase 5](./phase-5-briefs/README.md) — Wave 5 E2E + benchmark +
  graph contract + final review

## Shared File Conflict Table

Cards in the same wave that touch any of the following files MUST
serialize (one card at a time, dispatched sequentially by the main
thread). When a wave needs to update one of these, schedule a
dedicated barrel-update card after all leaf cards in the wave land.

| File | Owners | Risk | Rule |
|---|---|---|---|
| `packages/storage/src/db.ts` | every repo (DB connection) | high | Owned by P1-storage-skeleton; no Phase 2+ card writes it |
| `packages/storage/src/errors.ts` | every repo | medium | Owned by P1-storage-skeleton |
| `packages/storage/src/repos/shared/event-log-writer.ts` | 15+ repos | high | Owned by P1-storage-shared; no Phase 2+ card writes it |
| `packages/storage/src/repos/shared/validators.ts` | 8+ repos | medium | Same as above |
| `packages/storage/src/repos/shared/deep-freeze.ts` | 3+ repos | low | Same as above |
| `packages/protocol/src/index.ts` | every protocol type | high | Owned by P1-protocol; no Phase 2+ card writes it |
| `packages/protocol/src/soul/mcp-types.ts` | MCP memory tool schema consumers | high | P4-mcp-memory-tools may update this as an explicit protocol-contract follow-up; run protocol schema tests before any daemon or MCP-ready claim |
| `packages/protocol/src/events/*.ts` | every service that emits events | high | Owned by P1-protocol (recursive copy); Phase 2+ services never modify event payload schemas in place — schema changes require a P1-protocol-followup card |
| `packages/storage/src/index.ts` | every repo | high | barrel-update card P2-barrel-storage after all P2 repo batches land |
| `packages/core/src/index.ts` | every core service | high | barrel-update card P3-core-barrel at end of Phase 3 |
| `packages/soul/src/index.ts` | every Garden role | high | barrel-update card P2-barrel-soul at end of Phase 2C |
| `apps/core-daemon/src/app.ts` | every route | high | route-registration owner card P4-daemon-routes-register sequentially after all 4B routes close |
| `apps/core-daemon/src/routes/runs.ts` | P4-sse-strip + P4-routes-workspace | high | P4-sse-strip lands first (deletes the SSE GET endpoint and the TransformStream block); P4-routes-workspace serializes after and may NOT re-introduce any SSE / streaming framing |
| `bin/alaya.mjs` | every CLI subcommand | high | Owned by P4-cli-bridge; subcommand cards (P4-cli-doctor, P4-attach-codex, etc.) register through `AlayaCliBridge.registerSubcommand` per task-p4-cli-bridge §2.3; the §2.3 interface is frozen after P4-cli-bridge lands |
| `packages/protocol/src/soul/mcp-types.ts` (Phase 4 carve-out) | P4-mcp-memory-tools | high | Single explicit Phase 4 carve-out from the P1-protocol ownership rule; allowed to refine `soul.report_context_usage` related schemas only; any other change requires a P1-protocol-followup companion card |
| `packages/protocol/src/index.ts` (Phase 4 carve-out) | P4-trust-state | high | Single explicit Phase 4 carve-out for the P1-protocol barrel; adds the new `TrustStateSchema`, `ContextDeliveryRecordSchema`, `UsageProofRecordSchema`, `TrustSummarySchema` exports |
| `package.json` (workspace root) | rare | high | only Phase 0 cards or explicit follow-up after wave-gate review |
| `tsconfig.base.json` | rare | high | same as above |
| Migration sequence numbers | P1-migrations | medium | All 55 migrations are owned by P1-migrations; no Phase 2+ card may add a new migration without a P1-migrations-followup card |
| `docs/v0.1/INDEX.md` status table | every card on close | medium | Update via small `docs(<card-id>):` commit per R4 |

## Readiness Vocabulary

See `docs/handbook/runtime-status.md` for definitions:
`not-started`, `schema-ready`, `implementation-ready`,
`live-event-ready`, `mcp-consumable`, `cli-consumable`.

## Source Of Truth Reminder

- Port reference: `vendor/do-what-new-snapshot/`
- Source commit: see `vendor/do-what-new-snapshot/SNAPSHOT_REF.md`
- Port discipline: `docs/handbook/port-protocol.md`
- Per-card workflow: `docs/handbook/workflow/agent-workflow.md`
- Reviewer mode: `docs/handbook/workflow/review-protocol.md`
