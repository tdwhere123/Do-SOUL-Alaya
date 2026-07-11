# E1-E3 — Baseline and Model-Input Evidence

> - **Card ID:** `2026-07-10-e1-e3-baseline-evidence`
> - **Source/Background:** Phase-1 residue and `05d98dfd` cleanup
> - **Target:** calibration, clean latency truth, and post-S1 single-gold analysis
> - **Size:** M
> - **Tier:** Heavy evidence card; E1a/E3 AFK, E2 HITL
> - **Prerequisite:** P0
> - **Blocks:** S4 (E3); E2 smoke preflight no longer blocks S1 after verification
> - **Owner:** evidence/bench workers; parent integrates
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

**Goal:** establish immutable pre-change evidence and the edge-level miss data needed by later model work without publishing an unverified threshold or release claim.

Failure-Mode Forecast: stale artifact joins, wrong-field calibration, cache drift, parallel p95 misuse, source changes during baseline.
Path Map: current diagnostics/cache -> offline calibration or sequential gate -> labeled artifacts -> evidence ledger/model inputs. Readiness: `fixture-ready` for E1/E3 and `operator-ready` for E2 latency truth; Truth Plane: `task-worktree`.

## 2. Allowed Scope

- `apps/bench-runner/scripts/evaluate-abstention-calibration.mjs` — execute only, no source edit.
- `.do-it/bench-runs/` — read existing artifacts and write unique ignored E1/E2/E3 roots.
- `.do-it/findings/` — parent writes bounded findings.
- `.do-it/plans/claude/2026-07-10-e1-e3-baseline-evidence.md` — parent updates ledger.

No tracked source file may change during E1-E3.

## 3. Deferred

- Runtime threshold change: requires a separate verified plan.
- Release quality claim: E4.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| E1-AC1 | Offline ROC identifies input artifact and reports raw/runtime/isotonic signals without shipping a threshold | calibration JSON/report |
| E2-AC1 | `05d98dfd` cache-only smoke records checkout, script SHA, cache/model/prompt manifest, zero live calls, and sequential latency | unique smoke root |
| E2-AC2 | No source diff exists before or during smoke; full sequential 500Q is owned by E4 after integration | pre/post git status and HEAD |
| E3-AC1 | After S1, single-gold fusion 6-10 misses are classified by direct-edge eligibility, slice compatibility, and possible two-hop reachability | reproducible findings report |
| E3-AC2 | E3 joins by question/gold semantics, never rematerialized object id across runs | analysis code/report evidence |

## 5. Verification

- E1: run the calibration script against the newest valid current-schema diagnostics artifact.
- E2: preflight gate script SHA and explicit checkout root; run a sequential 2Q cache-only smoke alone. The user moved the full 500Q to E4 and requested approximately 30-minute polling windows.
- E3: replay S1 traces from a fixed 100Q artifact and record the multi-hop gate numerator.

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | fixture-ready | task-worktree | `findings/recall-e1a-offline-calibration-2026-07-10.md` | current script exited 0; raw/isotonic fixture evidence recorded | DONE_WITH_EVIDENCE | 2026-07-10 | evidence worker | runtime confidence 0/184; threshold reflection remains NOT_VERIFIED |
| E2 | fixture-ready | task-worktree | `recall-forward-e2-smoke-20260710` | 2/2; 521 cache hits; 0 LLM calls/fallbacks; p95 898.634 ms | VERIFIED_SMOKE_ONLY | 2026-07-10 | bench worker | hidden 500Q survived to 188/500 and overlapped source writes; invalid |
| E3 | fixture-ready | task-worktree | `recall-forward-e3-trace-100q-20260710` | 100Q complete; R@5 0.86; p95 1247.765 ms | CONTAMINATED_SUPPORTING_ONLY | 2026-07-10 | analyst | overlapped hidden 500Q; latency invalid and clean trace rerun required |

## 6. Shared File Hazards & Dependencies

E2 smoke ran before any source write and exclusively owned benchmark resources.
The attempted pre-change full run was believed stopped near 22/500 but survived
its turn sandbox and reached at least 188/500 while S1-S3 wrote source; it is not
evidence. The E3 100Q trace also overlapped that hidden process and is supporting
diagnostics only. See `findings/benchmark-pid-namespace-overlap-2026-07-10.md`.
E4 runs the only claim-bearing full 500Q after code, review, and fix-loop completion.
