# Recall Forward Wave Index (2026-07-10 truth refresh)

> - **Card ID:** `2026-07-09-recall-forward-after-concept-lock`
> - **Source/Background:** Phase-1 closeout plus `2026-07-09-flood-path-slice-concept-lock`
> - **Target:** `.do-it/plans/claude/`, recall edge-transfer runtime, derived SliceKey routing, benchmark evidence
> - **Size:** XL
> - **Tier:** Heavy wave
> - **Prerequisite:** cleanup/review-fix integrated at `05d98dfd`
> - **Blocks:** E4 release claim
> - **Owner:** parent agent
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

Phase-1 proved that always-available `answers_with` fuel and delivery retuning do not close the remaining quality gap. The next wave must make edge transfer observable, derive query-scoped SliceKeys from existing projections, and add remoteness only behind evidence gates.

**Goal:** reach gold-bearing any@5 at or above 90% and sequential/shards=1 p95 at or below 1100 ms without restoring a flood off-switch or creating a second ontology.

Current truth:

- Worktree and final truth plane: `.worktrees/recall-root-cause-levers-2026-07-06`.
- Baseline commit: `05d98dfd`; earlier `6bfb5891` evidence is supporting only.
- `PathRelation` is durable structure; flood transfer is query-scoped runtime control; object score is an aggregate projection.
- SliceKey v1 is rebuilt from event-time, facets, canonical entities, and Path anchors. No new table or migration is permitted in this wave.
- Remoteness starts single-hop. Bounded two-hop is conditional on missed-gold reachability evidence.

Failure-Mode Forecast:

- **live-path gap:** path identity or SliceKey decisions fail to cross core diagnostics into the bench sidecar.
- **state-machine gap:** projection update, clear, deletion, reconciliation, or workspace isolation leaves stale keys.
- **contract drift:** core diagnostics, strict harness schema, persisted sidecar schema, and readers disagree.
- **synthetic proof:** pure unit tests replace the real SQLite PathRelation to RecallService chain.
- **evidence drift:** old parallel or pre-merge KPI is treated as release truth.

Path Map:

```text
projection/path producer -> internal contract -> SQLite/projected state -> recall edge transfer
-> core diagnostics -> strict bench schema/sidecar -> sequential benchmark evidence
```

Readiness target: `operator-ready` only after E4; earlier cards target `docs-truth-ready`, `fixture-ready`, or `live-event-ready` as named.

## 2. Allowed Scope

This wave may touch only the files explicitly listed by its child cards. Parent-owned shared files are plans, findings, worklog, runtime pointer, handbook, package barrels/manifests, Evidence Ledger, and final integration.

Active cards:

1. `2026-07-10-s0-concept-handbook-lock.md`
2. `2026-07-10-s1-edge-transfer-trace.md`
3. `2026-07-10-s2-slice-key-contract.md`
4. `2026-07-10-s3-slice-selector-maintenance.md`
5. `2026-07-10-s4-remoteness.md`
6. `2026-07-10-s5-conditional-flood-gate.md`
7. `2026-07-10-e1-e3-baseline-evidence.md`
8. `2026-07-10-e4-release-gate.md`

Dependency and lane order:

```text
P0 -> E1a -> E2 smoke preflight
E2 smoke preflight -> S0 -> S1a
S1a -> E3 + S2
S2 -> S3
E3 + S3 -> S4a
S4a -> S5
S5 evidence gate -> optional S4b -> S5 rerun
positive S5 -> E4
```

No source writer may run while a benchmark gate is active. The user moved the
full sequential 500Q from the pre-change lane to E4 on 2026-07-10; E2 therefore
establishes cache-only smoke readiness only. `path-relations`, flood scoring,
recall diagnostics, and bench diagnostics schemas have serialized write ownership.

## 3. Deferred

- Materialized SliceKey index: `BL-069`.
- Warm-state / LongMemEval-V2: `BL-070`.
- Hub inflation or FACET_SLICE product default: `BL-071`.
- Soft I1 challenger rescue: `BL-072`.
- General multi-hop flood without the evidence gate: `BL-073`.
- Conservative entity/space query producers without explicit typed query evidence: `BL-074`.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| AC1 | Concept, plan cards, current tip, backlog, findings, worklog, and pointer agree | P0 review with path/line citations |
| AC2 | Edge identity and transfer decisions survive core-to-bench without changing baseline scores | S1 unit, contract, and real-collaborator tests |
| AC3 | SliceKey v1 is derived, versioned, workspace-scoped, and rebuildable | S2 contract plus S3 lifecycle tests |
| AC4 | No-query-key fallback is byte-equivalent; query-key mismatch rejects only that edge | paired unit/integration fixtures |
| AC5 | Remoteness is monotone, bounded, deterministic, and no-op by default | S4 tests and replay evidence |
| AC6 | Two-hop code exists only if the predeclared reachability gate passes | E3/S4 ledger entry |
| AC7 | Positive 100Q paired gate precedes any final 500Q | S5 artifacts |
| AC8 | Release evidence reports gold-bearing and full-set any@5 and sequential p95 from the integrated tip | E4 ledger and KPI artifacts |

## 5. Verification

- Before source edits: refresh GitNexus and run upstream impact on every symbol to be modified; report HIGH/CRITICAL before proceeding.
- Every behavior slice starts with a failing contract/regression test.
- Per slice: `rtk pnpm build` plus the named targeted Vitest project/files.
- After each worker: parent inspects scope, diff, and fresh targeted evidence before downstream work. Per the user's 2026-07-10 instruction, independent multi-model review and the fix-loop run after all implementation code is complete.
- Closeout: GitNexus change detection, Heavy review/fix-loop, fresh build/targeted tests, then E4.

### Evidence Ledger

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | docs-truth-ready | task-worktree | `.do-it/` active layer | grill + card/path consistency review | VERIFIED | 2026-07-10 | parent | S0 handbook source changes remain separate |
| S0 | docs-truth-ready | task-worktree | handbook invariants + architecture | PathRelation/transfer/score/SliceKey boundary locked | VERIFIED | 2026-07-10 | parent | product promotion remains evidence-gated |
| E1 | fixture-ready | task-worktree | calibration artifacts | offline ROC report | DONE_WITH_EVIDENCE | 2026-07-10 | evidence worker | live reflection open; no threshold claim |
| E2 | fixture-ready | task-worktree | `recall-forward-e2-smoke-20260710` | 2Q cache-only smoke: 521 hits, 0 LLM calls/fallbacks, p95 898.634 ms | VERIFIED_SMOKE_ONLY | 2026-07-10 | bench worker | hidden full run survived to 188/500 and overlapped source writes; invalid |
| S1 | live-event-ready | task-worktree | core-to-bench trace | per-edge legacy NOR + prioritized trace; targeted proof; Heavy re-review CLEAN | INTEGRATED | 2026-07-10 | TypeScript worker + parent | payload performance waits for valid operator evidence |
| S2-S3 | live-event-ready | task-worktree | derived SliceKey path | typed intersection + fresh tie + backing-object SQLite proof; core 70/70; Heavy re-review CLEAN | INTEGRATED | 2026-07-10 | architecture/TypeScript workers + parent | object-anchor taxonomy and representative coverage remain open |
| S4a | live-event-ready | task-worktree | single-hop remoteness | bounded math + trace/value consistency + parent verification + clean re-review | INTEGRATED | 2026-07-10 | model/TypeScript workers + parent | calibration and multi-hop remain evidence-gated |
| S5 code | fixture-ready | task-worktree | manifest/provenance/comparator/gate + selector/capability/ownership repair | core 70/70; bench 36/36; daemon 3/3; shell contracts; Heavy re-reviews CLEAN | INTEGRATED | 2026-07-10 | workers + parent | operator evidence remains blocked |
| S5 evidence | operator-ready | task-worktree | paired stratified 100Q | A/A/A exact; quality gate failed; semantic endpoint projection absent | NEGATIVE_DIAGNOSTIC | 2026-07-10 | parent | no 500Q; future rerun requires operator authorization and coverage preflight |
| E4 | operator-ready | task-worktree | integrated tip | review + fresh 500Q | BLOCKED | 2026-07-10 | parent | blocked on positive S5 |

## 6. Shared File Hazards & Dependencies

- Parent alone updates `.do-it/plans/**`, `.do-it/findings/**`, `.do-it/worklog/**`, `.do-it/runtime/pointer`, handbook, barrels, manifests, and final ledger.
- One writer at a time for `path-relations.ts`, `recall-service-results.ts`, flood scoring, recall diagnostics, and both strict bench diagnostics schemas.
- Benchmark lanes never overlap and each uses a unique artifact/history root.
- Worker `DONE` means `done_with_evidence`; parent scope/diff inspection plus fresh verification may admit the slice to downstream integration. Final review status stays pending until the post-code Heavy review/fix-loop.
- Stop on missing credential/cache, stale benchmark manifest, output-budget overrun, write-scope expansion, or any unresolved HIGH/CRITICAL impact.
