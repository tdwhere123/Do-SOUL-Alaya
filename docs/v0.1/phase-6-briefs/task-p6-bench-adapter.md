# Implementation Brief: Task P6-bench-adapter — OpenAI-compatible adapter for benchmark harness

> - **Phase**: 6
> - **Wave**: 6
> - **Card ID**: P6-bench-adapter
> - **Port mode**: requires-redesign
> - **Source**: `n/a` (Alaya-original; reuses existing `OPENAI_*` config rename from Round 3)
> - **Target**: `apps/core-daemon/src/benchmark/adapter/`, `apps/core-daemon/src/benchmark/auto-accept-mode.ts`, `apps/core-daemon/src/__tests__/benchmark/adapter.test.ts`, `docs/v0.1/phase-6-briefs/reports/task-p6-bench-adapter.md`
> - **Size**: M
> - **Prerequisite**: Gate-5 passed (v0.1.0 released)
> - **Blocks**: P6-bench-harness, P6-bench-baselines, P6-bench-resume, P6-bench-readme
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-6-briefs/README.md` row "P6-bench-adapter" and
"Invariant Exception" section; `docs/handbook/port-protocol.md §3
requires-redesign`; `docs/handbook/invariants.md` (the
`BenchmarkOnlyAutoAcceptMode` exception is the only sanctioned
deviation from the "Alaya decides durable truth" invariant and is
strictly scoped to this card's targets).

## 1. Background & Goal

**Background**: Marketing benchmark harness needs to call an external
LLM (user-supplied OpenRouter model). Existing `OPENAI_*` env names
were renamed in Round 3 and already understood by the daemon; this
card builds a thin adapter on top of those names so the harness reuses
the same configuration surface rather than introducing parallel env
vars.

**Goal**:

1. Provide an OpenAI-compatible HTTP client adapter that reads
   `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL_ID` from
   `.env` and exposes a single `chat.completions.create({...})`
   surface used by the harness and all baseline runners.
2. Implement `BenchmarkOnlyAutoAcceptMode`: a process-local flag that
   makes the in-harness orchestration auto-accept proposals so that
   mainstream memory benchmarks (which assume LLM-direct-write) are
   runnable. The flag is NOT reachable from MCP / CLI / config-service.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `apps/core-daemon/src/benchmark/adapter/openai-compatible-client.ts` | Alaya-original; thin wrapper around `fetch` to the configured `OPENAI_BASE_URL`. |
| `n/a` | `apps/core-daemon/src/benchmark/adapter/index.ts` | Barrel re-export of the adapter surface used by harness + baselines. |
| `n/a` | `apps/core-daemon/src/benchmark/auto-accept-mode.ts` | Process-local flag + `assertNotInProductionContext()` guard called at the top of every benchmark entrypoint. |
| `n/a` | `apps/core-daemon/src/__tests__/benchmark/adapter.test.ts` | Unit tests covering env-var precedence, missing-config error, and the import-firewall test (see §2.3). |
| `n/a` | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-adapter.md` | Completion report. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow
  `docs/handbook/port-protocol.md` §3.
- The adapter MUST reuse the `OPENAI_*` env names introduced in Round 3
  (do not rename, do not add `BENCH_*` parallels).
- `auto-accept-mode.ts` MUST live under `apps/core-daemon/src/benchmark/`
  and MUST NOT be re-exported from any package barrel.
- If a cited path is missing or a dependency forces files outside §2,
  return `BLOCKED`.

### 2.3 Required Behavior

- `OpenAICompatibleClient` reads `OPENAI_BASE_URL`, `OPENAI_API_KEY`,
  `OPENAI_MODEL_ID` from `process.env` and exposes
  `chatCompletion(messages, options)`. Missing env returns a typed error
  identifying the missing key (no silent fallback to a hardcoded URL).
- `chatCompletion()` returns the raw provider JSON body plus a
  normalized `{ text, tokens_prompt, tokens_completion, latency_ms }`
  record. Token counts are populated from the provider response when
  available; if the provider omits them, the adapter computes a
  conservative estimate (whitespace token count + 30%) and tags the
  record `{ tokens_estimated: true }`.
- `BenchmarkOnlyAutoAcceptMode.enable()` flips a module-local boolean.
  `BenchmarkOnlyAutoAcceptMode.isEnabled()` is the only read API.
- Daemon startup MUST log a banner `BENCHMARK_AUTO_ACCEPT=on` if the
  flag is enabled before request handling begins (the flag should be
  unreachable in normal startup; the banner is a defense-in-depth
  signal in case import-firewall regresses).
- An import-firewall test asserts that requiring
  `apps/core-daemon/src/benchmark/auto-accept-mode.ts` from any of:
  `apps/core-daemon/src/index.ts`, `apps/core-daemon/src/cli/`,
  `apps/core-daemon/src/mcp-memory-tool-handler.ts`,
  `apps/core-daemon/src/routes/` produces a build-time or
  static-analysis failure. The test is allowed to use a path-string
  scan as a pragmatic substitute if a true module-graph check is
  infeasible.

## 3. Deferred

- Streaming `chat.completions` responses — non-streaming only is
  sufficient for the benchmark workload. (Backlog: open `#BL-NNN
  benchmark adapter streaming` only if a future suite needs it.)
- Per-provider quirk handling beyond the OpenAI-compatible surface —
  out of scope; OpenRouter handles provider routing.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2.3 are implemented | `apps/core-daemon/src/__tests__/benchmark/adapter.test.ts` covers each behavior |
| AC2 | All files in §2.1 exist and contain the required surfaces | Reviewer reads files |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Adapter unit tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon benchmark/adapter` |
| AC5 | Import-firewall test passes | The test exists and asserts violation when the path-string scan finds a forbidden import |
| AC6 | A live smoke call succeeds against a real OpenRouter free-tier model | The completion report records the model id, base URL, latency, and token counts of one real call |
| AC7 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-6-briefs/reports/task-p6-bench-adapter.md` exists |
| AC8 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` updated |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm build`
3. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
4. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon benchmark/adapter`
5. Manual one-shot smoke: `OPENAI_BASE_URL=https://openrouter.ai/api/v1 OPENAI_API_KEY=<user-key> OPENAI_MODEL_ID=<user-model> rtk pnpm exec tsx apps/core-daemon/src/benchmark/adapter/__smoke__.ts`

## 6. Shared File Hazards & Dependencies

No shared-file hazards (no barrel writes, no protocol writes).

**Prerequisite**: Gate-5 passed.
**Blocks**: P6-bench-harness, P6-bench-baselines, P6-bench-resume, P6-bench-readme.
