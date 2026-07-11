# S5 — Conditional Flood Experiment Gate

> - **Card ID:** `2026-07-10-s5-conditional-flood-gate`
> - **Source/Background:** integrated S4 behavior
> - **Target:** sequential paired 100Q experiment and promotion decision
> - **Size:** M
> - **Tier:** Heavy evidence slice; HITL
> - **Prerequisite:** S4a integrated; S4b only when opened
> - **Blocks:** E4
> - **Owner:** bench worker; parent decides promotion
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

**Goal:** determine on a deterministic question-type-stratified 100Q manifest
whether SliceKey-conditioned remoteness improves gold-bearing recall without
per-type, full-sample, or sequential-latency regression, before any product-default change.

Re-audit finding: fresh independent seeds are not paired evidence because random
UUIDs change Path topology, and truncated question IDs violate workspace
isolation. The implementation hold is closed: collision-free identity,
fixed-snapshot lifecycle, strict attribution, and the A/A replay path are
integrated and review-clean. The completed paired 100Q proved rank-identical
A/A/A, but the treatment failed the multi-session non-regression gate and its
frozen snapshot had zero semantic endpoint projections. It is diagnostic-only
and cannot qualify semantic Slice routing. The selector and seed-capability
contracts are repaired; another run requires explicit operator authorization.
Abstention remains separate until its margin and threshold are calibrated.

Failure-Mode Forecast: evidence drift, benchmark contamination, cache/model/prompt mismatch, false p95 from parallelism.
Path Map: integrated implementation -> unique gate root -> paired diagnostics -> KPI comparison -> promotion/negative finding. Readiness: `operator-ready` only as a gate decision; Truth Plane: `task-worktree`.

## 2. Allowed Scope

- `packages/core/src/config/recall-env-access.ts` — one default-off internal experiment switch if required.
- `packages/core/src/config/recall-runtime-config.ts` — parse the same experiment switch.
- `apps/bench-runner/src/harness/recall-weight-overrides.ts` — propagate the experiment setting only.
- `apps/bench-runner/src/__tests__/harness/recall-weight-overrides.test.ts`
- `apps/bench-runner/src/longmemeval/selection/question-manifest.ts`
- LongMemEval runner/CLI/concurrency files needed to validate and propagate `--question-manifest`
- targeted CLI/manifest/concurrency tests
- `docs/bench-history/datasets/longmemeval_s.stratified-100.v1.json`
- `apps/bench-runner/src/longmemeval/comparison/question-type-comparison.ts`
- `apps/bench-runner/src/longmemeval/{snapshot,provenance,lifecycle,kpi}/`
- `apps/bench-runner/scripts/compare-longmemeval-question-types.mjs`
- targeted question-type comparison tests
- `.do-it/bench-runs/` — unique ignored artifacts and report.
- `.do-it/findings/` — parent promotes the result.

The experiment switch must not become a documented product control or a flood channel off-switch.

## 3. Deferred

- Product default promotion is E4 and requires the full gate.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| S5-AC1 | Control and treatment share commit, versioned question manifest, cache manifest, model, prompt hash, and sequential protocol | preflight manifest |
| S5-AC2 | Treatment gains at least one gold-bearing question, gold-bearing any@5 does not fall, no answerable question type regresses, and p95 is no worse than 105% of control; uncalibrated abstention is reported separately | paired per-type 100Q report |
| S5-AC3 | Failed gate records a negative finding and stops before 500Q | finding + ledger |
| S5-AC4 | Positive gate records exact config and unblocks E4; it does not itself change the product default | parent decision record |
| S5-AC5 | Gate holds a cross-turn filesystem lease and fails before work on unresolved lease or manifest concurrency | lease metadata + negative preflight checks |

## 5. Verification

- `rtk pnpm build`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/recall/integrated-flood-scoring.test.ts`
- `rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner apps/bench-runner/src/__tests__/harness/recall-weight-overrides.test.ts`
- Run control and treatment with `LME_RECALL_PARALLEL=0`, `LME_RECALL_SHARDS=1`, unique roots, and explicit target checkout.
- Use the tracked stratified manifest with quotas `27/26/16/14/11/6` for
  multi-session/temporal/knowledge/user/assistant/preference and six abstentions;
  report per-type `hits/N` plus question-ID paired gained/lost/net.

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S5 implementation | fixture-ready | task-worktree | fixed-snapshot runner + selector/capability/ownership repairs | comparator 36/36; core 70/70; daemon 3/3; shell contracts; Heavy re-reviews CLEAN | INTEGRATED | 2026-07-10 | workers + parent | only operator evidence remains blocked |
| S5 evidence | operator-ready | task-worktree | `s5-fixed-100q-20260710T140035Z` | A/A/A exact; 76→78 overall; 74/94→75/94 gold; multi-session regression; zero facet projection | NEGATIVE_DIAGNOSTIC | 2026-07-10 | parent | non-qualifying configuration; no rerun authorized |

## 6. Shared File Hazards & Dependencies

No source writer or other benchmark lane runs during S5. Parent owns the
manifest evidence, per-type comparison, finding promotion, and E4 unblock. The
only full 500Q runs after all code plus review/fix-loop are complete.
The gate is a main script plus lifecycle helper. Their current individual
content hashes for the next run are
gate `067ed93e6164bf4d3ade41bba088709143afbf53c131c5a7b0c5e6a4703984c2`
and lifecycle `126c16909c46baa04dee12bbd3c63da0b32d5b2a72684e51b8e678b9229dbace`.
The lifecycle `set -u` regression and the analogous `run_fixed_snapshot_eval`
local declaration are split and verified. Fresh run
`s5-fixed-100q-20260710T133511Z` then exposed a distinct compile-seed payload
overflow and was stopped before snapshot/A/B. The full 500Q remains blocked on
a positive S5 result. The payload repair is now integrated after a CLEAN
re-review and parent verification; no interrupted root may be reused.

The later completed run exposed two additional root causes. The comparator
misclassified official abstention rows and mishandled the `unpinned` dataset
sentinel; both contracts are repaired. More importantly, semantic endpoint
projection was absent from the frozen snapshot. Missing projections are now
neutral in the selector, seed capability is bound through frozen provenance,
and the gate requires nonzero populated facet projection before A/A/B. The
durable disposition is
`findings/s5-slice-projection-capability-2026-07-10.md`. E4 remains blocked.

On 2026-07-11 the operator authorized one fresh paired stratified 100Q after
the first-principles audit. The gate now explicitly fixes the legacy
`ALAYA_RECALL_FACET_SLICE=off` for seed, A/A/A, and B, so the only recall
behavior difference is `ALAYA_RECALL_CONF_SLICE_COMPATIBILITY`. The shell
contract failed before this isolation repair and passes afterward. The current
gate hash is `16f4bc7cebca0028c535cff78a75139cf343debb8f52dc3c82fe1c65f4100c51`;
the lifecycle helper remains
`0cda93a589f1698077ed45433a55c5e34a840825b649107f2f21fd2e58f234df`.
