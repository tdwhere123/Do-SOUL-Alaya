# P0-4 Task-Card Extraction Report

## Scope Compliance

This pass completed the active Phase 1-5 task-card extraction required for Gate-0 readiness. It treated the existing Phase 1 and early Phase 2 files as drafts, rewrote them into the maintained task-card template, and added the missing Phase 2, Phase 3, Phase 4, and Phase 5 cards.

## Port Discipline

- Phase 1 keeps 9 cards.
- Phase 2 originally landed with 31 extracted cards. A later Phase 2
  boundary repair added `P2-svc-task-surface-builder-prelude`, so current
  Phase 2 truth is 32 cards.
- Phase 3 has 5 cards.
- Phase 4 has 24 cards.
- Phase 5 has 4 cards.
- Every generated card uses one legal port mode: `trivial-copy`, `adapt-and-port`, or `requires-redesign`.

## Corrections Made

- Corrected P1-engine-gateway-mcp from the nonexistent `src/provider-registry.ts` path to `src/provider/provider-registry.ts`.
- Normalized Phase 1 task-card verification commands to `rtk ...` and added `rtk pnpm build`.
- Changed P2-svc-event-publisher to `requires-redesign` because Alaya forbids SSE transport.
- Rebuilt the Phase 2 repo batch list against the 42 actual vendor repo files.
- Removed active-doc references to stale `P4-daemon-core`, `P3-mcp-tooling`, `#BL-09`, and the nonexistent daemon `event-publisher` path.
- Fixed the reviewer-found RTK wrapper drift in active Phase 1/4 docs, root agent docs, RTK examples, and handbook command examples.
- Updated the root Vitest/build shell so Gate-0 can verify an empty package tree before Phase 1 package skeletons land.

## Verification Performed

Run these after any follow-up edit:

1. `rtk rg -n "P4-daemon-core|P3-mcp-tooling|#BL-09|apps/core-daemon/src/event-publisher" README.md package.json vitest.config.mjs vitest.workspace.mjs docs/v0.1/INDEX.md docs/v0.1/phase-*-briefs/README.md docs/handbook`
2. `rtk node` structural card sweep: original extraction evidence was 73 cards
   total; current active-doc truth after the Phase 2 boundary repair is 74 cards
   total with Phase 1=9, Phase 2=32, Phase 3=5, Phase 4=24, Phase 5=4; legal
   port modes; required sections; source paths exist.
3. `rtk node` active-doc command-wrapper sweep over README, phase READMEs, INDEX, and handbook.
4. `rtk pnpm build`
5. `rtk pnpm test`
6. `rtk git diff --check`

## Deferred

No task-card extraction work is intentionally deferred. Runtime implementation remains gated on Gate-0 review and then per-card dispatch.
