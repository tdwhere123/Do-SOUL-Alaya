# Implementation Brief: Task P6-bench-baselines — Wire mem0 + no-memory baseline runners

> - **Phase**: 6
> - **Wave**: 6
> - **Card ID**: P6-bench-baselines
> - **Port mode**: requires-redesign
> - **Source**: `n/a` (Alaya-original; consumes the public Mem0 SDK at a pinned version)
> - **Target**: `apps/core-daemon/src/benchmark/runners/mem0-runner.ts`, `apps/core-daemon/src/benchmark/runners/no-memory-runner.ts`, `apps/core-daemon/src/__tests__/benchmark/baselines.test.ts`, `docs/v0.1/phase-6-briefs/reports/task-p6-bench-baselines.md`
> - **Size**: S
> - **Prerequisite**: P6-bench-harness
> - **Blocks**: P6-bench-readme
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-6-briefs/README.md` row "P6-bench-baselines";
`docs/handbook/port-protocol.md §3 requires-redesign`.

## 1. Background & Goal

**Background**: The harness defines a runner contract; this card wires
two baseline runners so the leaderboard has a meaningful comparison set
beyond just Alaya itself.

**Goal**: Implement two `BenchmarkRunner` instances:
1. `mem0-runner` — uses the open-source Mem0 SDK as the memory layer.
2. `no-memory-runner` — uses no memory at all (each `answerQuery` only
   sees the current question, not prior conversation turns); serves as
   the lower-bound baseline.

Both runners use the same P6-bench-adapter for LLM calls so the LLM
variable is held constant across baselines.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/benchmark/runners/mem0-runner.ts` | Implements `BenchmarkRunner`; uses Mem0 SDK at the pinned version (see §2.3). |
| `n/a` | `apps/core-daemon/src/benchmark/runners/no-memory-runner.ts` | Implements `BenchmarkRunner`; no-op `recordTurn`; `answerQuery` calls the adapter with only the current question text. |
| `n/a` | `apps/core-daemon/src/benchmark/runners/index.ts` | Barrel re-export of the three known runners (`alaya`, `mem0`, `no-memory`) keyed by id for the harness CLI lookup. |
| `n/a` | `apps/core-daemon/src/__tests__/benchmark/baselines.test.ts` | Per-runner contract test + smoke call. |
| `n/a` | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-baselines.md` | Completion report. |

### 2.2 Port Rules

- Port mode is `requires-redesign`.
- Mem0 SDK MUST be pinned in `apps/core-daemon/package.json` to a
  specific version (record the version in the completion report).
- No runner may bypass the P6-bench-adapter; all LLM calls go through
  the adapter so token counts and base URL are uniform.

### 2.3 Required Behavior

- `mem0-runner` configuration:
  - Use Mem0's local-storage backend (no Mem0 cloud) so the benchmark
    is reproducible without a Mem0 account.
  - Reset Mem0 store between sessions via `cleanup(sessionId)`.
  - Use the same model id from `OPENAI_*` env via the adapter; do not
    let Mem0 spawn its own LLM client.
- `no-memory-runner` is intentionally minimal: `recordTurn` discards
  the input; `answerQuery` invokes
  `OpenAICompatibleClient.chatCompletion([{role: 'user', content:
  query}])`.
- `runners/index.ts` exports a `getRunner(id, deps)` factory used by
  the harness CLI; unknown id returns a typed error listing the known
  ids.
- Mem0 SDK version MUST be recorded in the completion report (e.g.
  `mem0ai@1.x.y`).

## 3. Deferred

- Cognee / Letta / LangMem runners — out of scope for v0.1.1.
- Cross-vendor LLM comparison — single LLM enforced by the adapter.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2.3 are implemented | `apps/core-daemon/src/__tests__/benchmark/baselines.test.ts` covers each behavior |
| AC2 | Mem0 SDK version is pinned in `apps/core-daemon/package.json` | `package.json` shows an exact `mem0ai` version (no `^` range) |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Baselines unit tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon benchmark/baselines` |
| AC5 | Each runner produces a valid jsonl record schema for at least one fixture question end-to-end (smoke) | The test runs one fixture question through `mem0-runner` and `no-memory-runner` and asserts the jsonl record schema |
| AC6 | Mem0 SDK pinned version is recorded in the completion report | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-baselines.md` cites the version |
| AC7 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` updated |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm build`
3. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
4. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon benchmark/baselines`

## 6. Shared File Hazards & Dependencies

`apps/core-daemon/package.json` — this card adds the Mem0 dependency.
No other card in Phase 6 modifies `package.json`, so no serialization
required, but the change is part of the lockfile and must be reviewed.

**Prerequisite**: P6-bench-harness.
**Blocks**: P6-bench-readme.
