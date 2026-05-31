# Spine Post-Claude Final Fix Loop

Target worktree: `/home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/v0.3.11-completion`
Branch: `v0.3.11-completion`
Source review: `.do-it/codex-review/spine-post-claude-final-review.md`
Benchmark: not run, per user instruction.

## Orchestration Hygiene

The earlier `rtk codex exec`-style worker attempts were not accepted as review evidence. They were closed or ignored because they were not the formal subagent channel and some remained in-progress. The closure evidence below uses only:

- Poincare (`019e7dc2-6f44-7831-b3e0-21cf023212e3`), formal red-team reviewer.
- Dewey (`019e7dc2-a4d4-7893-a3f1-0871b446bfc0`), formal SQL/path-identity reviewer.
- Fresh local verification commands from this worktree.

GitNexus impact/detect-change checks were attempted but blocked by MCP transport failure (`Transport closed`). No GitNexus result is claimed.

## Blocking

### B1 Closed: signal-ref transient failures no longer create duplicate durable proposals

Root cause from review: a memory create with `enrich_pending` could both create an inline fallback proposal for a transient signal-ref materialization failure and later replay the same signal ref through `BULK_ENRICH`, producing duplicate proposal-side effects instead of a single retry handoff.

Fix:

- `packages/soul/src/garden/materialization-router.ts:240` introduces the explicit `SignalRefTransientFailureMode` split: `durable_proposal` vs `throw_for_retry`.
- `packages/soul/src/garden/materialization-router.ts:478` adds `replaySignalRefs`, used by claim retry, and routes replay through `throw_for_retry`.
- `packages/soul/src/garden/materialization-router.ts:651`, `:841`, and `:950` still preflight signal-ref fallback before create flows, but `packages/soul/src/garden/materialization-router.ts:1082` treats a created memory with `enrich_pending` as retry-capable.
- `packages/soul/src/garden/materialization-router.ts:1334` throws transient `failed` outcomes in retry mode before fallback proposal creation.
- `packages/soul/src/garden/materialization-router.ts:1346` keeps the best-effort inline path, but selects `throw_for_retry` when the durable retry lane exists and `durable_proposal` only when it does not.

Garden side:

- `apps/core-daemon/src/garden-runtime.ts:1172` replays persisted source-signal refs before `markProcessed`.
- `apps/core-daemon/src/garden-runtime.ts:1219` marks processed only after all intended writes settle.
- `apps/core-daemon/src/garden-runtime.ts:1227` releases the claim on replay/enrichment failure so the row remains retryable.
- `apps/core-daemon/src/index.ts:1369` and `apps/core-daemon/src/index.ts:1373` wire source-signal lookup and replay to the daemon runtime.

Regression coverage:

- `packages/soul/src/__tests__/materialization-router.test.ts:1402` verifies `replaySignalRefs` throws transient failures without creating fallback proposals.
- `apps/core-daemon/src/__tests__/garden-runtime-bulk-enrich.test.ts:697` verifies source-signal replay before `markProcessed`.
- `apps/core-daemon/src/__tests__/garden-runtime-bulk-enrich.test.ts:730` verifies replay failure releases the claim and does not mark processed.
- `apps/core-daemon/src/__tests__/garden-runtime-bulk-enrich.test.ts:760` verifies missing source signal releases the claim and does not mark processed.

Formal rereview:

- Poincare first reported this as Blocking.
- After the fix, Poincare returned `CLEAR`: retry-capable inline materialization does not create fallback proposals; `BULK_ENRICH` replay throws transient failures; the worker releases the claim instead of marking processed.

Status: **correctly closed**.

## Important

### I1 Closed: migration 085 and 087 recall identity is now sign-aware

Root cause from review: the runtime path identity is sign-aware, but migration backfill/repair logic treated same-pair recalls-tier rows as duplicates without checking positive recall semantics. A negative or neutral existing path could suppress a positive legacy `recalls` edge, and migration 087 could dormant the wrong same-pair row.

Fix:

- `packages/storage/src/migrations/085-drop-memory-graph-edges.sql:184` now allows legacy `recalls` dedupe only when the existing recalls-tier path has positive `recall_bias`.
- `packages/storage/src/migrations/087-repair-duplicate-recalls-paths.sql:63` ranks only positive recalls-tier rows for duplicate repair.

Regression coverage:

- `packages/storage/src/__tests__/migration-085-graph-edge-backfill.test.ts:646` verifies positive legacy `recalls` edges are not deduped away by negative or neutral recalls-tier paths.
- `packages/storage/src/__tests__/migration-085-graph-edge-backfill.test.ts:696` and `:697` verify the backfilled legacy rows keep positive `recall_bias`.
- `packages/storage/src/__tests__/migration-087-repair-duplicate-recalls-paths.test.ts:182` verifies negative and neutral same-pair recalls-tier rows are not collapsed into positive duplicate repair.
- `packages/storage/src/__tests__/migration-087-repair-duplicate-recalls-paths.test.ts:232` through `:235` verify only the positive duplicate becomes dormant.

Formal rereview:

- Dewey first reported this as Important.
- After the fix, Dewey returned `CLOSED`: 085 and 087 now match runtime sign-aware recalls identity.

Status: **correctly closed**.

### I2 Closed: path-relation backing-object lookup no longer hard-couples tests and callers to migration 087 expression indexes

Root cause from review: `findByBackingObjectIdSql` used a hard `INDEXED BY` dependency on expression indexes that are created by migration 087. Repos instantiated against fixtures or partial migration states before 087 could fail even though the query semantics did not require that hard index hint.

Fix:

- `packages/storage/src/repos/path-relation-repo.ts:154` keeps the backing-object lookup as a normal semantic query and removes the hard `INDEXED BY` requirement.
- Existing planner coverage for anchor expression indexes remains separate in `packages/storage/src/__tests__/path-relation-repo.test.ts:607`.

Status: **closed**.

## Nice-to-have

### N1 Closed: test naming cleanup is directionally correct

The old milestone/version-shaped names called out by the user are now replaced with behavior-shaped names, for example:

- `packages/core/src/__tests__/recall-regression-suite/recall-current-behavior.test.ts`
- `packages/protocol/src/__tests__/runtime-foundation-contract.test.ts`
- `packages/protocol/src/__tests__/activation-weights.test.ts`
- `packages/soul/src/__tests__/auditor-repair-orphan-detection.test.ts`

This improves reviewability because tests now describe durable contracts instead of historical phase labels. Remaining deleted/added files are expected from the rename sweep and were not reverted.

Status: **closed for the scoped naming issue**.

## Verification

Fresh commands run in `/home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/v0.3.11-completion`:

- `rtk pnpm exec vitest run --project @do-soul/alaya-soul -- materialization-router`
  Result: 30 files / 347 tests passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/garden-runtime-bulk-enrich.test.ts`
  Result: 20 tests passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage packages/storage/src/__tests__/migration-085-graph-edge-backfill.test.ts packages/storage/src/__tests__/migration-087-repair-duplicate-recalls-paths.test.ts`
  Result: 2 files / 11 tests passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-storage packages/storage/src/__tests__/edge-proposal-repo.test.ts packages/storage/src/__tests__/path-relation-repo.test.ts packages/storage/src/__tests__/memory-entry-repo.test.ts packages/storage/src/__tests__/migration-085-graph-edge-backfill.test.ts packages/storage/src/__tests__/migration-087-repair-duplicate-recalls-paths.test.ts`
  Result: 5 files / 82 tests passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/memory-service.test.ts packages/core/src/__tests__/path-relation-proposal-service.test.ts`
  Result: 2 files / 54 tests passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/edge-auto-producer-wiring.test.ts apps/core-daemon/src/__tests__/recall-cross-link.test.ts apps/core-daemon/src/__tests__/signal-ref-seed-parity.test.ts apps/core-daemon/src/__tests__/garden-runtime-bulk-enrich.test.ts`
  Result: 4 files / 32 tests passed.
- `rtk pnpm build`
  Result: passed. Only existing inspector web chunk-size warnings were emitted.
- `rtk git diff --check`
  Result: passed.

## Residual Risk

- Full benchmark evidence is intentionally absent because the user asked not to run benchmark here.
- GitNexus impact and detect-change evidence is absent because the MCP transport failed with `Transport closed`.
- The worktree still contains broader pre-existing branch changes from the spine/naming/benchmark work. This fix loop did not revert unrelated dirty files.

## Current Judgment

The code is materially healthier than the previous post-Claude review state. The important improvement is that the enrichment and signal-ref logic now has a single durable handoff model: either inline fallback proposal is the durability mechanism, or `enrich_pending` retry is the durability mechanism, but not both. That removes the duplicate-side-effect class instead of masking it.

The remaining architectural smell is that this branch still carries a lot of historical cleanup, renamed tests, benchmark plumbing, and spine fixes in one large worktree. The local fixes are scoped and reviewed, but final release confidence still depends on the ongoing benchmark and a clean closeout pass over the full diff.
