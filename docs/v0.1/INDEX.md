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
       → Phase 2 (Wave 2, 20-25 parallel cards) → Gate-2
           → Phase 3 (Wave 3, 3-5 parallel cards) → Gate-3
               → Phase 4 (Wave 4, 3-5 parallel cards) → Gate-4
                   → Phase 5 (Wave 5, 1 sequential card) → Gate-5
                       → v0.1 release
```

## Phase Summary

| Phase | Title | Cards | Status | Gate |
|---|---|---|---|---|
| Phase 0 | Reset & Source Mirror | 6 cards (P0-0..P0-5) + P0-3.5 review + P0-3.6 fix + P0-4 extraction | **done** | Gate-0 passed |
| Phase 1 | Wave 1: Leaves | 9 cards | **done** | Gate-1 passed |
| Phase 2 | Wave 2: Services + Garden + Repos + Security | 31 cards (target) | in-progress | Gate-2 |
| Phase 3 | Wave 3: ConversationService + Run Lifecycle | 5 cards (target) | not-started | Gate-3 |
| Phase 4 | Wave 4: Daemon + Routes + MCP Server + Alaya-Original CLI | 24 cards (target) | not-started | Gate-4 |
| Phase 5 | Wave 5: E2E + Benchmark + Graph Contract + Final Review | 4 cards (target) | not-started | Gate-5 |

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
| `packages/protocol/src/events/*.ts` | every service that emits events | high | Owned by P1-protocol (recursive copy); Phase 2+ services never modify event payload schemas in place — schema changes require a P1-protocol-followup card |
| `packages/storage/src/index.ts` | every repo | high | barrel-update card P2-barrel-storage after all P2 repo batches land |
| `packages/core/src/index.ts` | every core service | high | barrel-update card P3-core-barrel at end of Phase 3 |
| `packages/soul/src/index.ts` | every Garden role | high | barrel-update card P2-barrel-soul at end of Phase 2C |
| `apps/core-daemon/src/app.ts` | every route | high | route-registration owner card P4-daemon-routes-register sequentially after all 4B routes close |
| `bin/alaya.mjs` | every CLI subcommand | high | Owned by P4-cli-bridge; subcommand cards (P4-cli-doctor, P4-attach-codex, etc.) register through a subcommand registration API exposed by P4-cli-bridge |
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
