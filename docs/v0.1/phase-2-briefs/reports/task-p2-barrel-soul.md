# Task P2-barrel-soul Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-barrel-soul.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/soul/src/index.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/index.ts`
- Targets:
  - `packages/soul/src/index.ts`
  - `packages/soul/src/garden/index.ts`

This card only edited the soul package barrels.

## Port Mode

Port mode: `adapt-and-port`.

The garden barrel was copied from the cited vendor path. Mechanical changes:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`

The package root barrel keeps the existing Alaya root exports, preserves the
upstream protocol graph helper re-export block through
`@do-soul/alaya-protocol`, and adds Phase 2 Garden exports from the vendor root
barrel.

## Parity Evidence

Source existence check passed for both source paths in the task card.

Normalized vendor parity passed for `packages/soul/src/garden/index.ts`.

## Verification

- Source existence check for all remaining Phase 2 closeout source paths - passed.
- Normalized vendor parity check for copied source/test files - passed.
- `rtk pnpm install` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/soul` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-soul` - passed; 20 files / 172 tests passed.

## Architecture Compliance

- `packages/soul/src/index.ts` now exports the Phase 2 Garden roles while
  keeping `packages/core` out of `packages/soul`.
- `packages/soul/src/index.ts` preserves upstream graph protocol helper
  re-exports from `@do-soul/alaya-protocol`.
- `packages/soul/src/garden/index.ts` exports Garden-only roles, ports, and
  constants.
- No root config, storage, core barrel, daemon, MCP, CLI, GUI, or TUI files were
  edited.

## Intentional Deviations

- The upstream root barrel also exports `SoulGraphAggregator` from
  `./graph/graph-aggregator.js`. That source file is not present in the Alaya
  Phase 2 source set, so the Alaya root barrel preserves upstream protocol
  graph helper exports but omits only the absent aggregator file export.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. The soul barrel is ready for
package-local and later daemon consumers, but this card does not claim live
daemon scheduling or MCP/CLI exposure.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-barrel-soul):` commit per Anti-Tail Rule R4.
