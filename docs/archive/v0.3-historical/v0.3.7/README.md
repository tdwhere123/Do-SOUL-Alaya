# v0.3.7 — Benchmark + Inspector Repair Slice

## Status

Honest-baseline rewrite on 2026-05-15 after a multi-lens review. The
dynamic recall infrastructure and benchmark-diagnostic surfaces are
implemented. The earlier R@5 = 70.0% disabled-100 result was produced
by a build that included LongMemEval-question-shape heuristics inside
`packages/core`; those heuristics have been removed and the
post-removal disabled-100 archive is the new honest baseline.

`docs/bench-history/live/` and `docs/bench-history/public-multiturn/`
are **not yet populated**. The earlier README/closeout language that
described them as landed has been retracted. The harness code for
`alaya inspect`, `longmemeval-multiturn`, and `live` import is in
place; producing the first archives is follow-up work, not v0.3.7
closeout work.

Disabled-500 and env-embedding floor evidence remain explicitly out
of scope for this checkpoint.

## Scope

v0.3.7 is a patch-internal repair and test-surface consolidation after
the v0.3.6 full benchmark run.

- Move the older `.do-it/checks/alaya-live` strict-real main-check
  summary into the tracked benchmark archive as `live/strict-real`.
- Keep raw `.do-it` run artifacts, provider transcripts, sample JSONL,
  and secrets outside git.
- Fix Inspector memory graph actions that returned generic
  `API Error: 403 Forbidden` because `alaya inspect` did not pass the
  daemon request token to the spawned Inspector process.
- Make Inspector Overview read `self`, `public`, and `live` bench
  summaries.
- Refresh the v0.3.7 backlog direction around recall quality,
  confidence labels, and recall-utilization follow-through.

## Delivered in this slice

- `@do-soul/alaya-eval` schema accepts `bench_name="live"`,
  `split="strict-real"`, `harness_mode="live_strict_real"`, and the
  `public-multiturn` bench name.
- `@do-soul/alaya-bench-runner live` imports
  `.do-it/checks/alaya-live/main-check.json` into
  `docs/bench-history/live/<slug>/`. **No live archive has been
  produced yet against the current v0.3.7 code.** The earlier number
  `provider R@1 = 91.4%, R@5 = 94.6%` came from a v0.3.6-era live
  check and was retracted because no v0.3.7 live re-run exists on
  disk.
- `alaya-bench-runner longmemeval-multiturn` is wired to produce
  `docs/bench-history/public-multiturn/<slug>/` entries with
  round-by-round R@5. **No multi-turn archive has been produced
  yet.**
- `alaya inspect` now injects the managed daemon's
  `ALAYA_REQUEST_TOKEN` into the Inspector child environment. External
  daemons do not inherit a parent `ALAYA_REQUEST_TOKEN`; use
  `ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN` when intentionally pointing
  the Inspector at a protected external daemon.
- Inspector frontend error handling now surfaces backend error strings
  and structured error messages instead of collapsing them to generic
  HTTP status text.

## Non-goals

- No MCP tool name, request schema, or response schema changes.
- No protocol zod schema, EventLog payload schema, runtime config schema,
  or SQLite migration changes.
- No durable ontology or migration change. Recall expansion is read-side
  only and uses existing `MemoryEntry`, memory graph, and `PathRelation`
  structures.

## Dynamic recall implementation

- [No-Embedding Dynamic Recall Design Notes](./no-embedding-dynamic-recall.md)
  records the v0.3.7 plan and implementation notes for deterministic
  recall without an embedding model. The implemented spine is:
  diagnose → probe → multi-plane candidate union → score after expansion
  → final delivery budget → benchmark sidecar.
  - Core recall now emits internal diagnostics (`query_probes`,
    candidate admission planes, pre-budget rank, final rank, drop reason,
    lexical rank, structural score, and provider status) without changing
    MCP response schemas.
  - No-embedding recall now admits candidates from activation,
    protected/winner governance, object probes, evidence anchors, domain
    tag clusters, temporal/session cohorts, memory graph one-hop
    expansion, PathRelation expansion, and lexical evidence. Keyword/FTS
    remains one weak channel rather than the definition of recall quality.
  - The daemon derives a wider internal candidate window from
    `max_results` and keeps `max_results` as delivery budget only.
  - `LongMemEval` archives now include a secret-free
    `longmemeval-diagnostics.json` sidecar. Env-embedding runs get
    provider-state rates and dual KPI fields.
  - **Slice C-multi** — multi-turn LongMemEval-S harness variant
    (single workspace, N=3 rounds with `report_context_usage`) is
    **code-ready** in `apps/bench-runner/src/longmemeval/multiturn.ts`
    and the `alaya-bench-runner longmemeval-multiturn` CLI. The first
    archive under `docs/bench-history/public-multiturn/` is follow-up
    work (Phase B of the v0.3.7 follow-up plan). This is the only
    bench-time verification surface for PathRelation / RECALLS-edge /
    plasticity development, since the single-turn per-question
    workspace has zero usage history.
  - **Slice G** — env-embedding engineering stability. Adds three
    provider-state rates to the Slice A sidecar
    (`provider_returned_rate` / `provider_pending_rate` /
    `provider_failed_rate`), dual KPI tracks in `kpi.json`
    (`r_at_5_overall` vs `r_at_5_with_embedding_returned`), a vitest
    case enforcing the shard-runner single-daemon contract, and Yunwu
    as the named v0.3.7 ship provider (key file at
    `~/.config/alaya/secrets/official-garden`).
  Slice E's verification is split across three tracks: single-turn
  LongMemEval (no-regression bar; structural value carried by Slice C
  content-derived planes), multi-turn (round-curve must show
  improvement), and live/strict-real (advisory Inspector trend only).

## Verification

```bash
rtk pnpm build
rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner -- live-runner
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-inspect routes
rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web -- api Overview
rtk pnpm exec vitest run --project @do-soul/alaya-eval
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs live --source .do-it/checks/alaya-live/main-check.json --history-root docs/bench-history
```

Implementation summary and current command evidence are tracked in
[`reports/v0.3.7-closeout.md`](reports/v0.3.7-closeout.md).
