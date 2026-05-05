# Implementation Brief: Task P6-bench-resume — One-shot run + resume + retry + progress

> - **Phase**: 6
> - **Wave**: 6
> - **Card ID**: P6-bench-resume
> - **Port mode**: requires-redesign
> - **Source**: `n/a` (Alaya-original)
> - **Target**: `apps/core-daemon/src/benchmark/run/`, `apps/core-daemon/scripts/bench-run.mjs`, `apps/core-daemon/scripts/bench-resume.mjs`, `apps/core-daemon/src/__tests__/benchmark/resume.test.ts`, `docs/v0.1/phase-6-briefs/reports/task-p6-bench-resume.md`
> - **Size**: M
> - **Prerequisite**: P6-bench-harness
> - **Blocks**: P6-bench-readme
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-6-briefs/README.md` row "P6-bench-resume" and the
charter line "user supplies the model + API key + URL and runs the
harness on their own time"; `docs/handbook/port-protocol.md §3
requires-redesign`.

## 1. Background & Goal

**Background**: The user runs the harness unattended on a free-tier
OpenRouter model. Free tiers have rate limits (often 10-30 req/min)
and unstable network. Without crash-resume the user cannot complete
the run, defeating the marketing-bench purpose.

**Goal**: Make the harness genuinely user-runnable for hours-to-days
of wall clock:
- One-shot run script that respects rate limits and shows progress.
- Crash-resume from per-question jsonl progress file.
- Retry with exponential backoff on rate-limit / network errors.
- Friendly progress logging (completed / total / ETA / current
  question id / current runner).

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/benchmark/run/progress-store.ts` | Reads/writes the per-question jsonl progress file; provides `markStarted(qid, runner)` / `markCompleted(qid, runner, record)` / `loadCompleted(suite, runner) -> Set<qid>`. |
| `n/a` | `apps/core-daemon/src/benchmark/run/retry-policy.ts` | Exponential-backoff retry (configurable `max_attempts`, `initial_ms`, `cap_ms`) for adapter calls; recognizes 429 + 5xx + network errors as retryable. |
| `n/a` | `apps/core-daemon/src/benchmark/run/progress-logger.ts` | Friendly stderr logger: `[12/100 alaya@longmem] qid=lme_0042 ok 2.4s` style; ETA from rolling latency average. |
| `n/a` | `apps/core-daemon/src/benchmark/run/orchestrator.ts` | Glues progress-store + retry + logger into the harness loop; the harness CLI delegates here. |
| `n/a` | `apps/core-daemon/scripts/bench-run.mjs` | One-shot CLI: `pnpm bench:run --suite=longmem --runner=alaya` (or `--suite=all --runner=all`). |
| `n/a` | `apps/core-daemon/scripts/bench-resume.mjs` | Resume CLI: `pnpm bench:resume` reads the existing progress file, computes the remaining work set, and continues. |
| `n/a` | `apps/core-daemon/src/__tests__/benchmark/resume.test.ts` | Unit tests for progress-store atomicity, retry policy classification, resume idempotency, ETA calculation. |
| `n/a` | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-resume.md` | Completion report. |

`package.json` of `apps/core-daemon` MUST add `bench:run` and
`bench:resume` script entries pointing at the two `.mjs` scripts (this
card owns those two script entries; see §6).

### 2.2 Port Rules

- Port mode is `requires-redesign`.
- Progress writes MUST be atomic per question (write to temp file +
  rename) so a crash mid-write never corrupts prior records.
- Retry policy MUST cap total attempts; runaway retry on a permanent
  failure (401 / 403 / 404 / 422) is a bug.
- Logger output MUST go to stderr; jsonl progress goes to a separate
  file under `var/benchmark/<suite>-<runner>.jsonl`.

### 2.3 Required Behavior

- `progress-store`:
  - File path: `var/benchmark/<suite>-<runner>.jsonl`.
  - One line per question; latest line for a `qid` wins (resume reads
    the last-write-wins set).
  - `loadCompleted` returns the set of `qid` values that already have a
    `score` field (started but not completed records do not count as
    done).
- `retry-policy`:
  - Default: 5 attempts, 2s initial backoff, 60s cap, full-jitter.
  - Retryable: 429, 500-599, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`.
  - Non-retryable: 400, 401, 403, 404, 422 (record the question with
    `score=0, error=<message>` and continue).
- `progress-logger`:
  - One line per question completion (success or failure) plus a
    rolling summary line every 10 questions.
  - ETA = `(total - completed) * rolling_mean_latency_ms`.
- `bench-run.mjs` accepts:
  - `--suite=<longmem|swe-lite|all>`
  - `--runner=<alaya|mem0|no-memory|all>`
  - `--limit=<n>` (optional; for testing partial runs)
- `bench-resume.mjs` accepts no required arguments; it scans the
  progress directory and resumes whatever is unfinished.

## 3. Deferred

- Distributed / multi-machine resume — single-process only.
- Live web dashboard — stderr log is the only progress UX.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2.3 are implemented | `apps/core-daemon/src/__tests__/benchmark/resume.test.ts` covers each behavior |
| AC2 | Crash-resume integration test passes | The test runs the harness on a tiny fixture set, kills the process mid-run, restarts via `bench-resume`, and asserts no question is skipped or double-counted |
| AC3 | Retry policy correctly classifies retryable vs non-retryable status codes | Unit test feeds mock adapter responses for each status code |
| AC4 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC5 | Resume unit tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon benchmark/resume` |
| AC6 | `pnpm bench:run` and `pnpm bench:resume` script entries exist in `apps/core-daemon/package.json` | `cat apps/core-daemon/package.json` shows both entries |
| AC7 | Progress file format is documented in the completion report | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-resume.md` includes the jsonl schema |
| AC8 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` updated |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm build`
3. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
4. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon benchmark/resume`

## 6. Shared File Hazards & Dependencies

`apps/core-daemon/package.json` — this card adds `bench:run` and
`bench:resume` script entries. P6-bench-baselines also touches
`package.json` (for the Mem0 dependency). The two cards MUST serialize
via the standard sequential dispatch rule; whichever lands second
rebases its `package.json` change onto the other.

`var/benchmark/` is added to `.gitignore` (this card owns the
`.gitignore` line for that path; if `.gitignore` already excludes
`var/`, no change needed — record in the completion report).

**Prerequisite**: P6-bench-harness.
**Blocks**: P6-bench-readme.
