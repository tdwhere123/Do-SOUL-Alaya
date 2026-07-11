# E4 — Integrated Release Evidence

> - **Card ID:** `2026-07-10-e4-release-gate`
> - **Source/Background:** positive S5 and all integrated lanes
> - **Target:** final review, verification, 500Q release truth, and current-layer promotion
> - **Size:** M
> - **Tier:** Heavy closeout; HITL
> - **Prerequisite:** positive S5; all required lanes integrated
> - **Blocks:** completion claim
> - **Owner:** parent
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

**Goal:** produce fresh integrated evidence for the product quality and latency gates and close every active lane honestly.

Failure-Mode Forecast: worker evidence mistaken for final proof, stale GitNexus graph, benchmark contamination, review findings left open.
Path Map: integrated diff -> GitNexus/review/fix-loop -> build/tests -> sequential 500Q -> findings/worklog/ledger closeout. Readiness: `operator-ready`; Truth Plane: `task-worktree`.

## 2. Allowed Scope

- All files changed by integrated S0-S5 slices, for review/fix only.
- `.do-it/review/`, `.do-it/findings/`, `.do-it/worklog/`, `.do-it/plans/`, `.do-it/runtime/pointer`.
- `.do-it/bench-runs/` unique final root.

No push or PR. No unrelated cleanup.

## 3. Deferred

Nothing deferred beyond the explicit backlog.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| E4-AC1 | All required lanes are `integrated`; none remain assigned/running/blocking | wave ledger |
| E4-AC2 | GitNexus change detection matches expected symbols/flows | detect-changes report |
| E4-AC3 | Heavy review/fix-loop has no open Blocking, Important, or Opportunity finding unless proved stale/overclaimed | review artifact |
| E4-AC4 | Fresh build and targeted tests pass on final worktree | command evidence |
| E4-AC5 | Gold-bearing any@5 >=90%; full-set any@5 reported; sequential/shards=1 p95 <=1100 ms | final 500Q KPI |
| E4-AC6 | Current findings/worklog/plan pointer describe the final truth and residual risk | closeout review |

## 5. Verification

- `rtk pnpm build`
- targeted Vitest for all touched packages and contracts
- GitNexus detect changes
- independent Heavy review, atomic fixes, same-scope re-review
- unique full 500Q with target checkout, HEAD, gate SHA, cache/model/prompt manifest recorded

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E4 | operator-ready | task-worktree | integrated tip | review + build/tests + 500Q | BLOCKED | 2026-07-10 | parent | blocked on S5 |

## 6. Shared File Hazards & Dependencies

Parent has exclusive write ownership during closeout. No benchmark, worker, reviewer, commit, or cleanup runs concurrently with final evidence.
