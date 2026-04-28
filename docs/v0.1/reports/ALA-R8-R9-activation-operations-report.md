# ALA-R8/R9 Activation Operations Report

Status: Closed after fresh review/fix-loop.

## Scope

This report covers the combined ALA-R8 Agent Integration and ALA-R9 Operations/Portability slice.

Delivered contract surface:

- Integration operation descriptors and injected-runtime invocation helpers.
- MCP tool/resource/prompt descriptors without claiming a live MCP transport.
- CLI fallback request normalization, parity shape, and redacted response helpers.
- Attach/Profile preview, explicit confirm/decline, result, rollback, conflict, and session-event metadata contracts.
- Gateway audit/strict envelope and evidence-link helpers.
- Profile precedence, explicit project override audit records, secret refs without raw secret serialization, provider/embedding status derivation.
- Portable bundle validation, import integrity checks, backup metadata, and read-only operations status.

## Non-Goals

This slice does not claim:

- live daemon readiness;
- live MCP transport/server readiness;
- real profile file mutation or installer runner readiness;
- Gateway runner readiness;
- real external provider adapter readiness;
- Inspector, benchmark, or full product loop readiness.

## Source And Boundary Notes

- Runtime storage remains internal and is not exported.
- New adapter and operations helpers are independent `@do-soul/alaya` code.
- Runtime artifacts such as context packs, topology views, graph views, inspector state, benchmark views, and activation candidates are not portable durable truth.
- Secret helpers serialize secret refs and resolution status only, never raw secret values.

## Verification

Initial worker-slice verification passed before parent integration:

- R8 integration/MCP: targeted tests, typecheck, build, full test at worker time.
- R8 CLI fallback/Gateway: targeted tests.
- R8 Attach/Profile: targeted tests and build.
- R9 profile/secret/provider-status: targeted tests and typecheck.
- R9 operations/portability: targeted tests and build.

Parent integration verification before review:

- `rtk pnpm exec tsc -p tsconfig.json --noEmit` - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm test` - passed, 24 files / 104 tests.
- `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-r8r9-smoke` - passed; JSON reported `activation_operations_ready: true` and `product_ready: false`.
- `rtk rg -n "@do-what/|do-what-new/packages" package.json src` - no matches.
- `rtk git diff --check` - passed.

Review/fix-loop changes:

- Portable exports now reject secret-bearing profile setting keys and secret-looking profile setting values.
- Portable import validation checks governance audit targets for ontology and profile-scope targets.
- Operations status can represent a missing provider without a fake provider id, and missing/failed/unresolved secret refs degrade provider/embedding status.
- Attach/Profile confirmation now requires explicit write result and successful write audit ref before producing configured records or installed/configured session events.
- Codex and Claude Code target snippet descriptors are exposed for snapshot-safe Attach/Profile previews.
- Gateway envelopes validate operation, timestamp, target agent, session, context identity, provider result, and proposal validity before generating audit evidence refs.
- Gateway envelopes reject rejected proposal wrappers before generating proposal evidence links.
- CLI fallback command metadata and MCP invocation metadata are redacted before being returned.
- Portable governance audit target validation treats `memory_visibility` and `promotion_candidate` as ontology-backed target ids and rejects non-portable runtime artifact targets.

Post-fix verification:

- `rtk pnpm exec tsc -p tsconfig.json --noEmit` - passed.
- `rtk pnpm exec vitest run src/__tests__/portable-bundle.test.ts src/__tests__/operations-status.test.ts src/__tests__/profile-attach-contract.test.ts src/__tests__/cli-fallback-contract.test.ts src/__tests__/mcp-surface.test.ts src/__tests__/gateway-envelope.test.ts` - passed, 6 files / 25 tests.
- `rtk pnpm exec vitest run src/__tests__/portable-bundle.test.ts src/__tests__/gateway-envelope.test.ts` - passed, 2 files / 8 tests after the second red-team fix.
- `rtk pnpm build` - passed.
- `rtk pnpm test` - passed, 24 files / 110 tests.
- `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-r8r9-fixloop-smoke` - passed; JSON reported `activation_operations_ready: true` and `product_ready: false`.
- `rtk rg -n "@do-what/|do-what-new/packages" package.json src` - no matches.
- `rtk git diff --check` - passed.

Final verification:

- `rtk pnpm build` - passed.
- `rtk pnpm test` - passed, 24 files / 110 tests.
- `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-r8r9-final-smoke` - passed; JSON reported `activation_operations_ready: true` and `product_ready: false`.
- `rtk rg -n "@do-what/|do-what-new/packages" package.json src` - no matches.
- `rtk git diff --check` - passed.

Fresh review closure:

- Spec compliance re-review: no remaining Blocking or Important findings.
- Red-team/security re-review: no remaining Blocking or Important findings after second fix loop.
- Correctness/API re-review: no remaining Blocking or Important findings.
- Install/release re-review: no remaining Blocking or Important findings.

## Review Lens

Fresh review must check:

- no `@do-what/*` or `do-what-new/packages/*` runtime imports;
- no public storage implementation leak;
- no raw secret serialization;
- no false durable-truth or usage-proof claims from projections, context packs, descriptors, Gateway envelopes, or Attach/Profile events;
- docs and doctor status do not claim live daemon, live MCP transport, real profile writes, Gateway runner, or full product readiness.
