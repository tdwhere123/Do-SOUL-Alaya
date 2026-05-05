# Implementation Brief: Task P6-bench-harness — Three-dimension benchmark harness

> - **Phase**: 6
> - **Wave**: 6
> - **Card ID**: P6-bench-harness
> - **Port mode**: requires-redesign
> - **Source**: `n/a` (Alaya-original; consumes public benchmark datasets at fixture-load time)
> - **Target**: `apps/core-daemon/src/benchmark/harness/`, `apps/core-daemon/src/benchmark/fixtures/`, `apps/core-daemon/src/__tests__/benchmark/harness.test.ts`, `docs/v0.1/phase-6-briefs/reports/task-p6-bench-harness.md`
> - **Size**: M
> - **Prerequisite**: P6-bench-adapter
> - **Blocks**: P6-bench-baselines, P6-bench-resume, P6-bench-readme
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-6-briefs/README.md` row "P6-bench-harness" and the
"Three measurement dimensions" charter line; `docs/handbook/port-protocol.md
§3 requires-redesign`.

## 1. Background & Goal

**Background**: Marketing benchmark must produce three numbers that
together tell the Alaya story:
1. Long-conversation factual recall — measures whether memory survives
   many turns.
2. Cross-session engineering-task continuation — measures whether the
   memory layer helps real coding workflows.
3. Token efficiency — measures input-token cost per correct answer
   (Alaya's `recall + open_pointer` should be more economical than
   flat-KV stores that dump full notes).

**Goal**: Build a single harness that loads two open public datasets
in subset form, drives the adapter against a runner, scores outputs,
and emits a uniform per-question jsonl record + a final aggregate
table. The runner is pluggable (P6-bench-baselines wires alaya / mem0
/ no-memory; this card only owns the harness contract and a default
`alaya` runner).

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/benchmark/harness/runner-contract.ts` | Defines `BenchmarkRunner` interface (`prepareSession`, `recordTurn`, `answerQuery`, `cleanup`) consumed by both the harness and baseline runners. |
| `n/a` | `apps/core-daemon/src/benchmark/harness/long-mem-eval-runner.ts` | LongMemEval-style suite: load 100-question subset, drive multi-session conversation, measure recall accuracy + token efficiency. |
| `n/a` | `apps/core-daemon/src/benchmark/harness/swe-bench-lite-runner.ts` | SWE-bench-lite-style suite: load 30-task subset, drive cross-session engineering continuation, measure task pass rate. |
| `n/a` | `apps/core-daemon/src/benchmark/harness/scoring.ts` | Per-suite scoring functions; outputs `{ score, n_correct, n_total, tokens_total, tokens_per_correct }` per runner per suite. |
| `n/a` | `apps/core-daemon/src/benchmark/harness/index.ts` | Entry point invoked by the run scripts: parses `--suite=<longmem\|swe-lite\|all>` and `--runner=<id>` and orchestrates. |
| `n/a` | `apps/core-daemon/src/benchmark/fixtures/long-mem-eval-100.jsonl` | 100-question fixture subset (English; standardized question/conversation format). |
| `n/a` | `apps/core-daemon/src/benchmark/fixtures/swe-bench-lite-30.jsonl` | 30-task fixture subset (English; standardized task/diff format). |
| `n/a` | `apps/core-daemon/src/benchmark/fixtures/README.md` | Documents the upstream provenance (license, attribution, subset construction) for each fixture file. |
| `n/a` | `apps/core-daemon/src/benchmark/runners/alaya-runner.ts` | Default runner implementation: drives Alaya via in-process MCP-equivalent calls (`recall`, `open_pointer`, `report_context_usage`, `propose`) under `BenchmarkOnlyAutoAcceptMode`. |
| `n/a` | `apps/core-daemon/src/__tests__/benchmark/harness.test.ts` | Unit tests covering fixture load, runner contract enforcement, scoring math, and per-question jsonl output schema. |
| `n/a` | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-harness.md` | Completion report. |

### 2.2 Port Rules

- Port mode is `requires-redesign`.
- Fixture files MUST cite their upstream license + the subset
  construction rule in `fixtures/README.md` (e.g. "first 100 questions
  by id from LongMemEval public release v1.x"); no proprietary
  redistribution.
- Token counts in scoring rely on the adapter's normalized record from
  P6-bench-adapter (do not re-tokenize at this layer).
- All harness entrypoints MUST call
  `BenchmarkOnlyAutoAcceptMode.enable()` before any Alaya orchestration.

### 2.3 Required Behavior

- `BenchmarkRunner` interface includes (at minimum):
  - `prepareSession(sessionId)` — runner clears or initializes its
    memory state for a fresh question.
  - `recordTurn({ role, content, ts })` — feeds a turn into the runner;
    runner is free to write/recall internally.
  - `answerQuery({ query }) -> { text, tokens_prompt, tokens_completion }`
    — runner returns its final answer (LLM-generated using its own
    memory layer; uses the P6-bench-adapter under the hood).
  - `cleanup(sessionId)` — runner releases per-session state.
- LongMemEval runner: per question, replays the conversation turns
  through `recordTurn`, then asks the question via `answerQuery`, scores
  with an exact-match-or-equivalent comparator (handles multiple-choice
  + free-form short-answer formats present in LongMemEval).
- SWE-bench-lite runner: per task, replays prior session context, then
  asks the model to produce a unified diff via `answerQuery`; scores
  with `git apply` + provided test command (or fallback comparator if
  the lite subset omits a runnable test).
- Per-question jsonl record schema (one line per question, written
  incrementally as questions complete):
  ```json
  {
    "suite": "longmem",
    "runner": "alaya",
    "question_id": "lme_0001",
    "score": 1,
    "tokens_prompt": 1234,
    "tokens_completion": 56,
    "latency_ms": 4200,
    "answer_text": "...",
    "ts": "2026-05-15T10:23:45Z"
  }
  ```
- Aggregate output (a single markdown table written at end of run):
  rows = runners, columns = suites + token-efficiency derived column.
- Harness MUST be invokable in two modes:
  - `--suite=<name>` runs one suite end-to-end.
  - `--suite=all` runs everything sequentially, sharing a progress file.
- Harness MUST NOT silently skip questions on error; on any per-question
  failure it writes a jsonl record with `score=0, error=<message>` and
  continues. The aggregate table reports the error count separately.

## 3. Deferred

- Multi-run averaging — single-run only. (Tracked: README disclosure
  rule documents single-run.)
- Custom user-authored fixtures — the two suite subsets are the only
  shipped fixtures.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2.3 are implemented | `apps/core-daemon/src/__tests__/benchmark/harness.test.ts` covers each behavior |
| AC2 | All files in §2.1 exist and contain the required surfaces | Reviewer reads files |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Harness unit tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon benchmark/harness` |
| AC5 | Default `alaya` runner produces a valid jsonl record for at least one fixture question end-to-end (smoke) | The test runs one fixture question through the alaya runner with `BenchmarkOnlyAutoAcceptMode` enabled and asserts the jsonl record schema |
| AC6 | Fixtures README cites upstream license + subset rule for each suite | Reviewer reads `fixtures/README.md` |
| AC7 | Completion report exists | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-harness.md` |
| AC8 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` updated |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm build`
3. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
4. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon benchmark/harness`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P6-bench-adapter.
**Blocks**: P6-bench-baselines, P6-bench-resume, P6-bench-readme.
