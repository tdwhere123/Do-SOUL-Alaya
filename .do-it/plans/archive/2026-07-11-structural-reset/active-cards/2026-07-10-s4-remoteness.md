# S4 — Evidence-Gated Remoteness

> - **Card ID:** `2026-07-10-s4-remoteness`
> - **Source/Background:** S1 edge trace, E3 misses, S3 selector
> - **Target:** single-hop transfer law and conditional bounded two-hop
> - **Size:** M; L only if S4b opens
> - **Tier:** Heavy child slice; S4a AFK, S4b conditional AFK
> - **Prerequisite:** E3 and S3 integrated
> - **Blocks:** S5
> - **Owner:** model/TypeScript worker; parent owns gate
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

**Goal:** make input potential, edge conductance, slice compatibility, caps, and stop reasons explicit while retaining a no-op production default; add max-two-hop propagation only when the evidence gate passes.

Failure-Mode Forecast: score drift, cycle/nontermination, hub amplification, latency growth, threshold overfit.
Path Map: S1 transfer inputs + S3 compatibility -> remoteness calculation -> object fold -> trace/replay -> S5. Readiness: `live-event-ready`; Truth Plane: `task-worktree`.

Interface comparison: extending `collapsePathInflow` inline is rejected because diagnostics, replay, and optional two-hop would duplicate math. A pure `flood/remoteness.ts` module is chosen: one input object, one immutable result, no side effects.

## 2. Allowed Scope

- `packages/core/src/recall/flood/edge-transfer.ts`
- `packages/core/src/recall/flood/remoteness.ts` (new)
- `packages/core/src/recall/flood/slice-key-selector.ts`
- `packages/core/src/recall/scoring/conformant-fusion-scoring.ts`
- `packages/core/src/recall/scoring/integrated-flood-scoring.ts`
- `packages/core/src/recall/runtime/recall-service-diagnostics.ts`
- `packages/core/src/__tests__/recall/flood-remoteness.test.ts` (new)
- `packages/core/src/__tests__/recall/conformant-axis-math.test.ts`
- `.do-it/bench-runs/scripts/replay-longmemeval-diagnostics.mjs`
- `apps/bench-runner/src/harness/recall-diagnostics-schema.ts`
- `apps/bench-runner/src/longmemeval/diagnostics-schema.ts`
- existing edge-trace diagnostics contract tests under `apps/bench-runner/src/__tests__/longmemeval/`

S4b may additionally change only `packages/core/src/recall/flood/bounded-frontier.ts` (new) and `packages/core/src/__tests__/recall/flood-bounded-frontier.test.ts` (new).

## 3. Deferred

- General multi-hop beyond two edges: `BL-073`.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| S4-AC1 | Default single-hop result is byte-equivalent to the pre-S4 formula | paired regression test |
| S4-AC2 | Zero input/conductance/compatibility does not transfer; output is monotone and bounded | unit tests |
| S4-AC3 | S4a distinguishes no input, no edge fuel, no slice match, transfer, and cap application; below-threshold is only present if a zero-default parameter earns its keep, while propagation budget is S4b-only | trace assertions |
| S4-AC4 | Calibration uses a predeclared deterministic split and freezes threshold before holdout | replay report |
| S4-AC5 | S4b opens only when two-hop-reachable misses can close the sample gap to 90% | parent ledger decision |
| S4-AC6 | If opened: max two edges, 256 expansions/query, best potential per object+slice, deterministic potential/path-id ordering, cycle rejection | frontier tests |

## 5. Verification

- `rtk pnpm build`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/recall/flood-remoteness.test.ts packages/core/src/__tests__/recall/conformant-axis-math.test.ts`
- S4b only: `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/recall/flood-bounded-frontier.test.ts`

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S4a | live-event-ready | task-worktree | remoteness module | parent build + core 85/85 + bench 41/41 + Heavy review CLEAN | INTEGRATED | 2026-07-10 | model worker + parent | replay calibration remains S5 evidence |
| S4b | live-event-ready | task-worktree | bounded frontier | reachability gate + tests | BLOCKED | 2026-07-10 | parent/worker | evidence gate not run |

## 6. Shared File Hazards & Dependencies

All scoring/core and strict bench diagnostics files are exclusive to one S4
writer until integration. S5 cannot start from worker evidence alone.
