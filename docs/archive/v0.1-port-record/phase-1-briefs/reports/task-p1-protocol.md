# Task P1-protocol Report

## Status

DONE. The protocol package was copied under the P1-protocol ownership boundary,
and the copied frozen red engine-binding update test is now green through the
adapt-and-port protocol-schema adapter points described below.

## Scope Compliance

- Wrote `packages/protocol/**`.
- Wrote this report at `docs/v0.1/phase-1-briefs/reports/task-p1-protocol.md`.
- `pnpm-lock.yaml` changed only as the mechanical result of `rtk pnpm install`
  after adding `packages/protocol/package.json`; it was not hand-edited.
- Did not edit root `package.json`, `tsconfig.base.json`, Vitest config files,
  shared status docs, or any non-protocol package.

## Port Mode

Port mode: `adapt-and-port`.

Copied sources:

- `vendor/do-what-new-snapshot/packages/protocol/package.json`
- `vendor/do-what-new-snapshot/packages/protocol/tsconfig.json`
- `vendor/do-what-new-snapshot/packages/protocol/src/`

Targets:

- `packages/protocol/package.json`
- `packages/protocol/tsconfig.json`
- `packages/protocol/src/`

Mechanical rewrites:

- Rewrote package name `@do-what/protocol` to
  `@do-soul/alaya-protocol`.
- Rewrote copied self-imports from `@do-what/protocol` to
  `@do-soul/alaya-protocol`.
- Removed UTF-8 BOMs from target files copied from BOM-bearing source files:
  `packages/protocol/tsconfig.json`,
  `packages/protocol/src/__tests__/evidence-capsule.test.ts`, and
  `packages/protocol/src/__tests__/phase-2a-events.test.ts`.

Adapter points:

- Added `RunUpdateEngineBindingInputSchema` to
  `packages/protocol/src/run.ts`.
- Added `RunEngineBindingUpdatedPayloadSchema` to
  `packages/protocol/src/events/phase-0.ts`.
- Added the corresponding `Phase0EventType.RUN_ENGINE_BINDING_UPDATED`
  / `run.engine_binding.updated` event type and phase-0 payload / union map
  entry.
- Updated existing Phase0 enum coverage in
  `packages/protocol/src/__tests__/schemas.test.ts` to include the new event
  type, phase-0 payload parser coverage, and full `Phase0EventSchema` union
  branch coverage.

No service behavior, runtime wiring, or non-protocol package code was invented.

## Verification Evidence

- Source path check: PASS.
  `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/protocol/package.json\",\"vendor/do-what-new-snapshot/packages/protocol/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/protocol/src/\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
- Install: PASS.
  `rtk pnpm install`
- Build: PASS.
  `rtk pnpm build`
- Typecheck: PASS.
  `rtk pnpm exec tsc --noEmit -p packages/protocol`
- Targeted tests: PASS.
  `rtk pnpm exec vitest run --project @do-soul/alaya-protocol`
  passed 59 protocol test files and 507 tests, including
  `packages/protocol/src/__tests__/run-engine-binding-update.test.ts`.
- Review-fix I1: PASS.
  `rtk pnpm exec vitest run --project @do-soul/alaya-protocol run-engine-binding-update schemas`
  covers the copied engine-binding RED test and the Phase0 parser / union
  branch assertions for `RUN_ENGINE_BINDING_UPDATED`.
- Parity check: PASS.
  A normalized source/target check reported `pairs: 178`, `missing: []`, and
  `extra: []` after applying the package-alias rewrite and BOM normalization,
  excluding generated build outputs. The only mismatches are the authorized
  schema/event-contract additions in `packages/protocol/src/run.ts`,
  `packages/protocol/src/event-log.ts`,
  `packages/protocol/src/events/phase-0.ts`, and
  `packages/protocol/src/__tests__/schemas.test.ts`.

## Architecture Compliance

- `packages/protocol` remains the zod-only leaf package.
- No package imports from `apps/*`.
- No non-protocol package code was changed.
- No root config was edited by this worker.

## Intentional Deviations

The only intentional adapt-and-port surface is the engine-binding update
protocol contract required by the copied frozen red test. It is limited to
protocol schemas / event contract and does not add runtime behavior.

## Deferred Issues

None. This is a blocker, not a deferral.

## Readiness Impact

P1-protocol can be treated as `schema-ready`: type / schema files are in place
and unit tests pass, with no live consumer claimed.

## Post-Landing Note

Any later edit to this card or report should land as a separate
`docs(P1-protocol):` commit per R4.
