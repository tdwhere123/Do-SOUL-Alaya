# Task P1-config Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-1-briefs/task-p1-config.md`
- Source: `vendor/do-what-new-snapshot/packages/core/src/dynamics-constants-runtime.ts`
- Source test: `vendor/do-what-new-snapshot/packages/core/src/__tests__/dynamics-constants-runtime.test.ts`
- Target: `packages/core/src/dynamics-constants-runtime.ts`
- Target test: `packages/core/src/__tests__/dynamics-constants-runtime.test.ts`
- Owned paths changed:
  - `packages/core/src/dynamics-constants-runtime.ts`
  - `packages/core/src/__tests__/dynamics-constants-runtime.test.ts`
  - `docs/v0.1/phase-1-briefs/reports/task-p1-config.md`

No shared barrels, status docs, root config, or unrelated package files were edited.

## Port Mode

Port mode: `trivial-copy`.

The target file was copied from the cited vendor source. The only content
adaptation is the required package alias rewrite:

- `@do-what/protocol` -> `@do-soul/alaya-protocol`

No function bodies, signatures, constants, or helper structure were rewritten.
The source `__tests__/` file was ported with package-local relative imports
unchanged. Its suite title was mechanically normalized from
`dynamics-constants-runtime` to `dynamics constants runtime` so the task card's
required AC4 filter executes the ported tests instead of skipping them.

## Parity Evidence

Source existence check passed for:

- `vendor/do-what-new-snapshot/packages/core/src/dynamics-constants-runtime.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/dynamics-constants-runtime.test.ts`

Parity check compared the target file to the source after applying only the
allowed package alias rewrite. The only remaining difference is final newline
normalization in the target file.
The target test matches the vendor test except for the suite-title
normalization required by AC4.

## Verification

- `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/dynamics-constants-runtime.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` - passed
- `rtk pnpm install` - passed
- `rtk pnpm build` - passed
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "dynamics constants"` - passed; 1 file / 7 tests passed

## Architecture Compliance

- `@do-soul/alaya-protocol` remains the source of protocol/domain types.
- `packages/core` imports only the protocol package and local `CoreError`.
- No daemon, storage, soul, or engine-gateway dependencies were introduced.
- No EventLog, durable state, MCP, CLI, GUI, TUI, or runtime wiring path was changed.

## Deviations

- Final newline normalized in the target implementation file.
- Test suite title normalized from hyphenated source text to the task card's
  space-separated AC4 filter text; test bodies and imports are unchanged.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

Closing readiness label remains `schema-ready`. This card ports constants only
and does not claim `implementation-ready`, `live-event-ready`,
`mcp-consumable`, or `cli-consumable`.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P1-config):` commit per Anti-Tail Rule R4.
