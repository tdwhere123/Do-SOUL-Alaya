# Card 0 — Current Truth Re-Verification

Date: 2026-07-05  
Lane: `integrated`  
Agent: codex review-fix-loop

## Must-Verify Results

| Claim | Status | Evidence |
| --- | --- | --- |
| Fused scoring has additive evidence/temporal/control terms | **live** | `packages/core/src/recall/delivery/fusion-delivery-scoring.ts:229-236` |
| Evidence beta default active before true support fuel | **fixed** | `integrated-flood-scoring.ts` requires path + evidence fuel; regression in `integrated-flood-scoring.test.ts` |
| Daemon vs bench embedding fusion weight divergence | **fixed** | Core, daemon, and bench default embedding fusion weight align at 12 |
| MCP vs bench recall path divergence | **fixed** | `recall-bound-service.ts` and bench invocation use shared `invokeBoundRecall` with explicit side-effect mode |
| Proposal review karma half-commit | **fixed** | Proposal resolution passes karma mutation through the storage transaction hook |
| Karma lost-update | **fixed** | `karma-transition-engine.ts:75-104`, atomic test |
| Temporal interval normalize | **fixed** | `temporal-fusion-scoring.ts:174-182` |
| Fused-rank ordering | **fixed** | `fusion-delivery-scoring.ts:243-311` |
| Full-gold delivery core rank labels | **fixed** | `diagnostics-delivery-bridge.ts` resolves core rank from pre-delivery fusion rank only |
| Extraction cache drift preflight | **fixed** | Manifest requirement defaults on; model/prompt drift checks run whenever manifest exists |
| Retention scanner wired + recall consumes decay | **fixed** | Janitor retention decay scan is wired; recall consumes updated activation/retention state |
| `superseded_by` self-write | **fixed** | Supersede context carries `supersedingObjectId`; regression covered in lifecycle tests |

## Card 1+ Watch Items

- Keep benchmark-only diagnostic helpers out of the core root API.
- Preserve explicit side-effect mode in future MCP/benchmark recall wrappers.
- Treat cache manifest drift as a hard preflight failure for full recall baselines.
