# Phase 6 — Wave 6: Marketing Benchmark Wave (post-v0.1.0)

Phase 6 closes **v0.1.1** by adding a single-run marketing leaderboard
to the v0.1 README. It runs **after** Gate-5 / `v0.1.0` releases and
Gate-5F has closed the current Open backlog.

The wave delivers a benchmark **harness** plus an **OpenAI-compatible
adapter** so the user can run the comparison themselves against any
OpenRouter (or other OpenAI-compatible) model. The wave does **not**
own the production of the numbers themselves — the user supplies the
model + API key + URL and runs the harness on their own time. Phase 6
is complete when the harness runs end-to-end and the README template is
in place with placeholders the user fills in after their run.

## Charter

- Phase 6 is **post-release**. v0.1.0 is a complete shipped product
  before Phase 6 starts. Phase 6 produces v0.1.1 (still inside the v0.1
  series).
- Phase 6 cards do **not** block any v0.1.0 work.
- Marketing benchmark numbers are **single-run**, **disclosure-tagged**,
  and **user-runnable**. Quality bar is "honest about its limits", not
  "academic-grade rigor".
- Three measurement dimensions are produced by a single harness run:
  1. Long-conversation factual recall (LongMemEval-style)
  2. Cross-session engineering-task continuation (SWE-bench-lite-style)
  3. Token efficiency (input-token cost per correct answer; computed
     from the same runs)

## Cards

| Card ID | Subject | Port mode | Closing label |
|---|---|---|---|
| P6-bench-adapter | Build an OpenAI-compatible adapter that lets the harness call any external LLM via `OPENAI_BASE_URL` / `API_KEY` / `MODEL_ID` (`.env`). Includes `BenchmarkOnlyAutoAcceptMode` for in-harness use only. | requires-redesign | implementation-ready |
| P6-bench-harness | Build the three-dimension benchmark harness (LongMemEval subset + SWE-bench-lite subset + token-efficiency derivation) on top of the adapter. | requires-redesign | implementation-ready |
| P6-bench-baselines | Wire 3 comparable runners: `alaya` (this repo), `mem0` (open-source SDK pinned), `no-memory` (vanilla LLM only). Each runner consumes the harness fixtures via the same adapter. | requires-redesign | implementation-ready |
| P6-bench-resume | Add one-shot run + crash-resume + rate-limit retry + progress logging so the user can leave the harness running unattended. | requires-redesign | implementation-ready |
| P6-bench-readme | Add a README leaderboard template (markdown table + disclosure line + reproducibility link). Numbers are placeholders until the user runs the harness; the card is complete when the template is in place and the user's fill-in flow is documented. | requires-redesign | mcp-consumable |

## Dependency Graph

```
Gate-5 (v0.1.0 ships)
  │
  └─> Gate-5F (Open backlog `#BL-025`..`#BL-036` closes)
        │
        └─> P6-bench-adapter
              │
              ├─> P6-bench-harness
              │     │
              │     └─> P6-bench-baselines
              │           │
              │           └─> P6-bench-resume
              │                 │
              │                 └─> P6-bench-readme
              │
              (alternatively: harness, baselines, resume can be split
               into a 2-stage parallel block once adapter lands; the
               README card always sequences last)
```

## Prerequisites

- **Gate-5 passed** (v0.1.0 released; this is non-negotiable — the
  marketing wave is for an already-shipped product).
- **Gate-5F passed**: backlog Open count for `#BL-025` through
  `#BL-036` is zero, final review has zero Blocking / Important
  findings, and the full verification gate passes.
- Existing `OPENAI_*` config rename from Round 3 must be intact (the
  adapter reuses these names rather than introducing new env vars).

## Gate-6 (v0.1.1 release)

- Gate-5 holds (v0.1.0 still works; benchmark wave introduced no
  regression).
- P6-bench-adapter: adapter passes its unit tests; can drive a real
  OpenRouter free-tier model end-to-end (a single smoke call).
- P6-bench-harness: harness can execute the three-dimension fixture
  set against `alaya` runner under `BenchmarkOnlyAutoAcceptMode`.
- P6-bench-baselines: `mem0` and `no-memory` runners produce results in
  the same output schema as `alaya`.
- P6-bench-resume: harness can be killed mid-run (Ctrl+C / network
  outage simulation) and resumed from the per-question jsonl progress
  file without losing or double-counting work.
- P6-bench-readme: README contains the leaderboard template; the
  reproducibility section explains how the user fills in numbers from
  their own run; disclosure line format is fixed.
- `docs/handbook/runtime-status.md` reflects v0.1.1 ready.

Gate-6 does **not** require the user to have actually completed a run
or filled in the numbers. The user's run is post-Gate-6 and may take
days/weeks of wall-clock waiting on free-tier rate limits.

## Invariant Exception (must be cited by P6-bench-adapter)

`docs/handbook/invariants.md` rule "Alaya decides durable truth; LLMs
and connected agents propose candidates" is a hard rule for the daemon
+ MCP + CLI surfaces. Phase 6 introduces **one** scoped exception:

- **`BenchmarkOnlyAutoAcceptMode`**: a flag readable only inside the
  harness process (`apps/core-daemon/src/benchmark/`).
- It is **not** exposed via MCP, CLI, config-service, or any HTTP route.
- It is **not** importable from the daemon, MCP server, or CLI bridge
  packages (enforced by lint rule + integration test that imports the
  benchmark module from those paths and asserts a build error / test
  failure).
- When the harness sets this flag, the in-process orchestration
  auto-accepts proposals so that mainstream memory benchmarks (which
  assume LLM-direct-write semantics) become runnable for fair
  comparison against `mem0` / `no-memory` baselines.
- Daemon startup logs a banner `BENCHMARK_AUTO_ACCEPT=on` whenever the
  flag is active, so an accidental production run is loud.

## Disclosure Standard (Marketing-Bench Honesty Bar)

Every leaderboard table that ships in the README MUST be accompanied
by a disclosure line of this exact shape:

```
> Single run, N=<n> subset of <suite-name>, OpenRouter model
> <model-id>, run on <YYYY-MM-DD>. Reproduce with
> `rtk pnpm bench:run --suite=<suite>`.
```

If any of the four fields cannot be filled (e.g. mid-run partial
results), the table is removed from the README, not partially shipped.

## Out of Scope

- Multi-run statistical significance — single-run only is acceptable
  for v0.1.1; multi-run aggregation is a v0.2 concern.
- Cognee / Letta / LangMem baselines — `mem0` + `no-memory` is the v0.1.1
  baseline set. Adding more baselines is a follow-up wave.
- A second LLM (e.g. Anthropic Haiku for cross-vendor comparison) — single
  LLM only.
- A web leaderboard / GitHub Pages site — the README markdown table is
  the only delivery surface.
- Xiaohongshu / blog post / non-GitHub copy — user-handled, not in this
  wave.
- A v0.2 plan — out of scope.

## Parallelism Notes

- P6-bench-harness, P6-bench-baselines, and P6-bench-resume can be
  executed in two waves once P6-bench-adapter lands:
  Wave-A: `harness` → Wave-B: `baselines` + `resume` in parallel →
  P6-bench-readme last.
- All Phase 6 cards are sequential with respect to Gate-5F; none of them
  may start until Gate-5F has passed.
