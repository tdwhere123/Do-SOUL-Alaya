# Bench History — Cross-version baseline archive

This directory accumulates **reproducible recall benchmark KPIs** across
every Alaya release that touches recall, embedding, tier, or governance
behavior. It is the durable contract that v0.3.6 establishes for v0.3.7+
and beyond.

The premise: a single one-off benchmark number is theatre. A feedback
loop — same harness, same data, diffed against previous baselines, with
regression thresholds and an Inspector trend line — is engineering.

## Why this exists

- An external reader can re-run `rtk pnpm exec alaya-bench-runner self &&
  rtk pnpm exec alaya-bench-runner longmemeval` and reproduce our
  published numbers.
- Any PR that changes recall / embedding / tier / proposal behavior
  must attach a fresh entry here and link the diff vs. the previous
  baseline in the PR description.
- Inspector reads the last N entries and renders trend lines on
  `/overview` and `/recall`.
- The diff engine encodes regression thresholds in
  `packages/eval/src/thresholds.ts`. A `✗` finding flips the CLI exit
  code, so this archive can be wired into CI later without changing
  contract.

## Layout

```
docs/v0.3/bench-history/
├── README.md                              # this file
├── self/
│   ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│   │   ├── kpi.json                       # machine-readable KPIs
│   │   ├── report.md                      # human report + diff vs prev
│   │   └── findings.md (optional)         # only present when ✗ fired
│   └── latest-baseline.json               # JSON pointer → newest dir
└── public/
    └── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
        ├── kpi.json
        ├── report.md
        └── findings.md (optional)
```

- `<YYYY-MM-DDTHHMMSSZ>-<sha7>` combines the ISO-8601 run timestamp (UTC,
  colon-stripped so the path is filesystem-safe) and the **alaya commit
  sha** the harness was run against. Same-day reruns keep their natural
  chronological order under lex sort.
- `latest-baseline.json` is a JSON pointer (`{ "slug": ..., "kpi_path": ... }`)
  rewritten on every successful `writeEntry`. `readLatest` checks this
  pointer first and only falls back to directory listing when the file is
  absent or malformed.
- `findings.md` is emitted by the diff engine when any KPI hits the `✗`
  threshold; it lists the regression, the suspected root cause, and a
  candidate `#BL-XXX` backlog entry. The release relay turn must lift
  these into `docs/handbook/backlog.md`.

## KPI schema (`kpi.json`)

```jsonc
{
  "bench_name": "self" | "public",
  "split": "golden" | "synthetic" | "longmemeval-s",
  "run_at": "2026-05-14T12:34:56Z",
  "alaya_commit": "97dbdd9",
  "alaya_version": "0.3.6",
  "embedding_provider": "yunwu:text-embedding-3-small" | "local-heuristic" | "...",
  "chat_provider": "yunwu:gpt-5.4-mini" | "n/a",
  "dataset": { "name": "LongMemEval-S", "size": 500, "source": "..." },
  // sample_size = dataset total (LongMemEval Oracle = 500, self synthetic = 8).
  // evaluated_count = how many of those this run actually scored. For a full
  // run, evaluated_count === sample_size. For a smoke run, --limit N caps it.
  // The KPI schema refines evaluated_count <= sample_size.
  "sample_size": 500,
  "evaluated_count": 500,
  // harness_mode names the data-ingestion path so the audit trail is honest:
  //   direct_db_seed     — bench wrote MemoryEntry rows directly via the
  //                        storage repo, bypassing the propose → review →
  //                        accept governance loop. Numbers from this mode
  //                        are NOT a claim about live agent behavior.
  //   mcp_propose_review — bench drove the in-process daemon via the real
  //                        soul.propose_memory_update + soul.review_memory_proposal
  //                        MCP tools (production-equivalent ingestion).
  //   external_replay    — bench replayed a recorded stdio transcript
  //                        against the real daemon (cross-version regression).
  "harness_mode": "mcp_propose_review",
  "kpi": {
    "r_at_1": 0.0,                            // archival only; not threshold-gated
    "r_at_5": 0.0,
    "r_at_10": 0.0,
    "latency_ms_p50": 0,
    "latency_ms_p95": 0,
    "token_saved_ratio_vs_full_prompt": 0.0,
    "tier_distribution": { "hot": 0, "warm": 0, "cold": 0 },
    "degradation_reasons": { "none": 0, "warm_cascade_engaged": 0, "cold_cascade_engaged": 0 },
    "per_scenario": [
      { "id": "syn-001", "version": 1, "hit_at_5": true, "tier": "hot" }
    ]
  },
  "diff_vs_previous": {
    "previous_run": "2026-05-13T120000Z-abcdef0",
    "r_at_5_delta_pp": 0.0,
    "verdict_per_kpi": { "r_at_5": "ok" }
  }
}
```

## Thresholds (regression verdicts)

Defined in `packages/eval/src/thresholds.ts`. Reference values:

Bands are inclusive (`≥`): a drop of exactly 2.0 pp registers as `warn`,
a drop of exactly 5.0 pp registers as `fail`.

| KPI | ⚠ (warn) | ✗ (fail, exit 1) |
|---|---|---|
| `r_at_5` | drop ≥ 2.0 pp | drop ≥ 5.0 pp |
| `r_at_10` | drop ≥ 2.0 pp | drop ≥ 5.0 pp |
| `latency_ms_p95` | ≥ +20% | ≥ +50% |
| `token_saved_ratio_vs_full_prompt` | drop ≥ 2.0 pp | drop ≥ 5.0 pp |
| golden-set hit | any individual fixture flips hit→miss | ✗ same row |
| `tier_distribution.hot` share | drop ≥ 5.0 pp | drop ≥ 10.0 pp |

A `✗` on any of these makes `alaya-bench-runner` exit non-zero. CI hookup is
optional today; the contract is that the exit code is meaningful.

## Synthetic scenario versioning

Each scenario in `packages/eval/fixtures/synthetic-recall/*.json` carries
`scenario_id` (stable) + `version` (incremented on edit). The diff engine
matches by `scenario_id`; if a scenario's `version` changes, the diff
engine reports the scenario in `rebaselined_scenarios` rather than as a
hit→miss delta — so editing one scenario does not silently move the
overall R@5 number.

Adding a brand-new `scenario_id` is reported in `new_scenarios`. Both
categories appear in the `report.md` markdown section and in
`KpiDiffResult` returned by the diff engine, but neither contributes to
the worst verdict (they are advisory, not gating).

## Bench harness — degradation diagnostics

`kpi.degradation_reasons` is read straight off the daemon's recall
response — it is not echoed from seed counts. Each probe contributes
exactly one bucket:

- `none` — hot-tier coarse filter returned enough candidates; no cascade.
- `warm_cascade_engaged` — hot tier was empty / underfilled, warm tier
  was searched and produced the merged candidate set.
- `cold_cascade_engaged` — warm tier still underfilled, cold tier was
  searched too.

Why the split between `self` and `public` looks asymmetric:

- `public` (LongMemEval) seeds dozens of haystack turns per question.
  The hot tier is dense, FTS matches are plentiful, and most probes
  return enough hot candidates without ever firing the cascade.
- `self` seeds only the 1–2 setup utterances plus 3–5 distractors per
  scenario. The hot tier is sparse relative to the recall budget, so
  the cascade fires almost every probe and most `self` runs report
  `cold_cascade_engaged=N`. This is real recall behavior on a small
  workspace, not a harness bug. Larger workspaces (e.g. real attached
  agents over a session) will lean back toward `none`.

`harness_mode = "mcp_propose_review"` in `kpi.json` confirms each seed
went through the full propose+review chain
(`soul.emit_candidate_signal → soul.propose_memory_update →
soul.review_memory_proposal accept`). Any KPI carrying
`harness_mode = "direct_db_seed"` is from a pre-v0.3.6 run that
bypassed governance and should not be used as a v0.3.6 baseline.

## How to add a new entry (operator handbook)

```bash
# from the alaya repo root (or any worktree on a branch you want to bench)
rtk pnpm install
rtk pnpm build

# 1. (LongMemEval only) Fetch the public dataset before the first run.
#    Verifies sha256 against datasets/<name>.meta.json and caches the JSON
#    under <data-dir>/longmemeval/.
rtk pnpm exec alaya-bench-runner fetch-longmemeval --variant oracle

# 2. Run the benches. Each writes <split>/<date>T<HHMMSS>Z-<sha7>/ and
#    rewrites the corresponding latest-baseline.json pointer.
rtk pnpm exec alaya-bench-runner self
rtk pnpm exec alaya-bench-runner longmemeval --variant oracle
```

Then commit the new `<date>T<HHMMSS>Z-<sha7>/` directory +
`latest-baseline.json` update. If `findings.md` exists, open the
corresponding backlog entry in the same PR.
