# Gate-2 Closeout Report

## Scope

Gate-2 closes Phase 2 Wave 2: storage repositories, core services,
security defense, Garden roles, and Phase 2-owned package barrels.

Phase 2 now has 32 task cards and 32 task completion reports. The added
boundary-prelude card is `P2-svc-task-surface-builder-prelude`, which owns only
`packages/core/src/task-surface-builder.ts` and its test before
`P2-svc-recall`.

## Readiness

Gate-2 status: passed.

Closed readiness label: `implementation-ready`.

This closeout does not claim daemon, MCP, CLI, GUI, TUI, conversation service,
or live transport readiness. `packages/core/src/index.ts` remains Phase 3-owned
and was not updated for the Phase 2 services.

## Fresh Verification

- `rtk pnpm build` - passed.
- `rtk pnpm test` - passed; 156 files / 1272 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core` - passed; 32 files / 266 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-soul` - passed; 20 files / 172 tests.
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage` - passed; 43 files / 304 tests.
- Source existence check for the final closeout source set - passed; 24 vendor paths checked.
- Phase 2 card/report count check - passed; 32 cards, 32 reports, no missing reports.

## Drift Sweeps

- `rtk rg -n "@do-what/" packages --glob '!vendor/**'` - no package matches.
- `rtk rg -n "SseBroadcaster|EventSource|text/event-stream" packages --glob '!vendor/**'` - no package matches.
- `rtk rg -n "task-surface-builder" docs/v0.1/phase-2-briefs docs/v0.1/phase-3-briefs` - Phase 2 owns implementation; Phase 3 references only the prerequisite / non-ownership boundary.
- `rtk ls apps` - reports `No such file or directory`; there is no current app runtime surface to scan.

## Review And Fix Loop

Read-only reviewers found four issues during closeout. All Blocking and
Important findings were fixed before this Gate-2 report:

- `TaskSurfaceBuilder` glossary ownership drift: fixed
  `docs/handbook/glossary.md` to name `P2-svc-task-surface-builder-prelude`
  as owner and Phase 3 as consumer only.
- Stale Phase 0 extraction count: updated
  `docs/v0.1/phase-0-briefs/reports/p0-4-task-card-extraction-report.md` to
  preserve original extraction evidence while recording current Phase 2 truth
  as 32 cards.
- Synthesis/Proposal SSE contract drift: reclassified both cards/reports to
  `adapt-and-port`, renamed service contracts to runtime notifier terms, and
  reran core typecheck plus targeted and full core Vitest.
- Soul barrel graph helper omission: restored upstream graph constants/parser
  re-exports through `@do-soul/alaya-protocol` while still omitting only the
  absent `SoulGraphAggregator` implementation export.

Prevention hooks added:

- Adapter-point tables now document the SSE-to-runtime-notifier changes in the
  synthesis/proposal task cards.
- `P2-barrel-soul` now documents the graph helper re-export and the exact
  `SoulGraphAggregator` omission.
- Gate-2 drift sweeps include package-level upstream import and forbidden SSE
  runtime checks.
- Phase 2 card/report count is verified as 32 / 32 before closeout.

## Deferred

Deferred to later phases:

- Phase 3: ConversationService, run lifecycle services, MCP discovery, and core
  service barrel exports.
- Phase 4: daemon, routes, MCP server transport, CLI bridge, profile mutation,
  secrets, and live operator surfaces.
- Phase 5: final E2E, graph contract, and release review. Superseded by
  Phase 5 preflight: benchmark moved to Phase 6 / Gate-6 / v0.1.1.

No Phase 2 Blocking or Important review finding remains open.
