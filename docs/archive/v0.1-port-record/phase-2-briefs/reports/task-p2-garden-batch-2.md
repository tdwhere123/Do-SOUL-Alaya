# Task P2-garden-batch-2 Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-2-briefs/task-p2-garden-batch-2.md`
- Sources:
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/janitor.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/librarian.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/janitor.test.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/janitor-gc.test.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/__tests__/librarian.test.ts`
- Targets:
  - `packages/soul/src/garden/janitor.ts`
  - `packages/soul/src/garden/librarian.ts`
  - `packages/soul/src/__tests__/janitor.test.ts`
  - `packages/soul/src/__tests__/janitor-gc.test.ts`
  - `packages/soul/src/__tests__/librarian.test.ts`

No soul barrel was edited by this card; P2-barrel-soul owns the barrel update.

## Port Mode

Port mode: `trivial-copy`.

The target implementation and tests were copied from the cited vendor paths.
Mechanical changes:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`

## Parity Evidence

Source existence check passed for all source paths in the task card.

Normalized vendor parity passed for the implementation and tests after the
package alias rewrite.

## Verification

- Source existence check for all remaining Phase 2 closeout source paths - passed.
- Normalized vendor parity check for copied source/test files - passed.
- `rtk pnpm install` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/soul` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-soul janitor janitor-gc librarian` - passed; 3 files / 26 tests passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-soul` - passed; 20 files / 172 tests passed.

## Architecture Compliance

- Janitor and Librarian remain in `packages/soul` and do not import from
  `packages/core`.
- Garden work remains implementation-ready only; daemon scheduling and live
  wiring remain later phase work.

## Intentional Deviations

None.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label is `implementation-ready`. This card ports Garden roles
and tests, but does not claim daemon or live-event wiring.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P2-garden-batch-2):` commit per Anti-Tail Rule R4.
