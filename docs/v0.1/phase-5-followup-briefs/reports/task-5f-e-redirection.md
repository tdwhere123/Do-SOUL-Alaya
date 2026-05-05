# 5F-E Redirection Report

Status: review-clean

## Evidence

- Added per-anchor usage proof data (`per_anchor_usage`) to the trust
  usage contract and persisted it through the SQL-backed trust-state
  repository.
- Added the durable `PATH_RELATION_REDIRECTED` runtime-governance event
  contract and wired `PathPlasticityService` to update
  `PathRelation.plasticity_state.direction_bias`.
- Recall now respects the persisted direction bias when ranking related
  memories.
- The live proof exercises:
  `soul.recall -> soul.report_context_usage -> Garden pass ->
  PathRelation mutation -> later soul.recall`.
- Fix-loop closure: trust-state validation now rejects forged
  `used_object_ids` and `per_anchor_usage` before EventLog append or
  persistence when they do not match the linked delivery.

## Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-protocol -- runtime-governance path-relation
rtk pnpm exec vitest run --project @do-soul/alaya-core -- path-plasticity recall
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- mcp-memory-tool-handler trust-state path-plasticity-integration
rtk pnpm exec vitest run --project @do-soul/alaya-storage -- trust-state-repo
rtk pnpm exec tsc -p apps/core-daemon/tsconfig.json --noEmit --pretty false
rtk git diff --check
```

Controller rerun results:

- protocol: 63 files / 534 tests passed
- core: 70 files / 633 tests passed
- core-daemon: 52 files / 283 tests passed
- storage: 46 files / 339 tests passed
- core-daemon TypeScript check passed
- diff check passed

## Review

- Correctness re-review: CLEAR; prior B1 spoofing finding closed.
- Red-team re-review: CLEAR; prior same-workspace per-anchor spoofing
  path closed.
- Spec/docs lens: CLEAR for the delivered 5F-E behavior. Aggregate
  Gate-5F closeout review and full verification have passed.
