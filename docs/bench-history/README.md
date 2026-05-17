# Bench History — Cross-version baseline archive

This directory accumulates **reproducible recall benchmark KPIs** and
sanitized live-check snapshots across every Alaya release that touches
recall, embedding, tier, or governance behavior. It is the durable
contract that v0.3.6 establishes for v0.3.7+ and beyond.

v0.3.7 introduces the `live/strict-real` and `public-multiturn` archive
**contracts and import commands**. The first archive entries under
`docs/bench-history/live/` and `docs/bench-history/public-multiturn/`
are follow-up work; if those directories are empty you are looking at
a pre-Phase-B v0.3.7 checkout.

The premise: a single one-off benchmark number is theatre. A feedback
loop — same harness, same data, diffed against previous baselines, with
regression thresholds and an Inspector trend line — is engineering.

## Why this exists

- An external reader can re-run
  `rtk node apps/bench-runner/bin/alaya-bench-runner.mjs self`,
  and `rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval`
  to reproduce the tracked archive shape after `rtk pnpm build`.
  `alaya-bench-runner longmemeval-multiturn` repeats LongMemEval recall
  with `soul.report_context_usage`; `alaya-bench-runner live` is
  operator-only re-archive plumbing for a newly generated local
  live-check summary. The older `.do-it` live
  histories have already been imported here and the raw run directories
  are no longer kept in the repo checkout.
- Any PR that changes recall / embedding / tier / proposal behavior
  must attach a fresh entry here and link the diff vs. the previous
  baseline in the PR description.
- Inspector reads the last N entries and renders trend lines on
  `/overview` and `/recall`, including the separate
  `public-multiturn` archive.
- The diff engine encodes regression thresholds in
  `packages/eval/src/thresholds.ts`. A `✗` finding flips the CLI exit
  code, so this archive can be wired into CI later without changing
  contract.

## Layout

```
docs/bench-history/
├── README.md                              # this file
├── self/
│   ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│   │   ├── kpi.json                       # machine-readable KPIs
│   │   ├── report.md                      # human report + diff vs prev
│   │   └── findings.md (optional)         # only present when ✗ fired
│   └── latest-baseline.json               # JSON pointer → newest dir
├── public/
│   ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│   │   ├── kpi.json
│   │   ├── longmemeval-diagnostics.json (optional)
│   │   ├── report.md
│   │   └── findings.md (optional)
│   ├── latest-baseline.json               # embedding=none canonical pointer
│   └── latest-baseline-embedding-on.json  # embedding-on sibling pointer
├── public-pre-v0.3.9/                     # frozen pre-v0.3.9 Pass A archives
│   └── <YYYY-MM-DDTHHMMSSZ>-<sha7>/       # historical record, not diffed
├── public-multiturn/
│   ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│   │   ├── kpi.json
│   │   ├── longmemeval-diagnostics.json
│   │   ├── report.md
│   │   └── findings.md (optional)
│   └── latest-baseline.json
└── live/
    ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
    │   ├── kpi.json                       # normalized strict-real KPIs
    │   ├── report.md                      # gate table + live mode comparison
    │   ├── live-gates.json                # sanitized source gate summary
    │   └── findings.md (optional)
    └── latest-baseline.json
```

### Two parallel pointers under `public/`

- `latest-baseline.json` — embedding=none canonical pointer. Read by
  `readLatest` for the disabled-embedding regression chain (the audit
  surface for "what does Alaya recall by lexical / structural planes
  alone").
- `latest-baseline-embedding-on.json` — embedding-on sibling pointer
  (placeholder). Reserved for callers that opt into the cost-bearing
  semantic supplement chain so an embedding-on FAIL does not pollute
  the embedding-off baseline. No consumer reads this file today; it
  ships with `slug: null` and a note. When the first non-FAIL
  embedding-on rerun lands, this pointer activates and any reader
  that explicitly opens it (`readFileSync` of this exact path) will
  see a populated slug. Until that rerun, treat this pointer as
  reserved-for-future-use.

### Pre-v0.3.9 frozen archives

`public-pre-v0.3.9/` holds the bench archives written before the
v0.3.9 denominator + label-cascade fix. They are kept for historical
reference and are not diffed by the runner. The most recent non-FAIL
disabled-embedding archive was promoted back into `public/` as the
anchor so the v0.3.9 reruns have a valid previous-baseline to diff
against; everything else (including the latency-FAIL archives and the
single mixed embedding-on FAIL archive) lives under
`public-pre-v0.3.9/`.

### Sample-size label cascade

`packages/eval/src/wilson-ci.ts` derives the sample-size label from
`evaluated_count` and `latency_source` via four tiers:

| Label          | Bucket                                          | What the bench claim is good for |
|---             |---                                              |--- |
| `smoke`        | `evaluated_count ≤ 50`                          | Tripwire only — verifies the code path runs; not a quality claim. |
| `staged`       | `51 ≤ evaluated_count ≤ 200`                    | Staged-release confidence — interim sanity check; widening CI bands. |
| `shard_merged` | `201 ≤ evaluated_count ≤ 499` OR `latency_source = worst_shard_bound` | Cross-shard merged dataset; latency reads as upper bound, not exact percentile. |
| `full`         | `evaluated_count ≥ 500`                         | Full dataset, exact percentiles, release-grade evidence. |

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
  "bench_name": "self" | "public" | "public-multiturn" | "live",
  "split": "golden" | "synthetic" | "longmemeval-s" | "longmemeval-oracle" | "longmemeval-m" | "strict-real",
  "run_at": "2026-05-14T12:34:56Z",
  "alaya_commit": "97dbdd9",
  "alaya_version": "0.3.7",
  "embedding_provider": "none" | "openai:text-embedding-3-small" | "yunwu:text-embedding-3-small" | "openai-compatible:<model>" | "...",
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
  //   live_strict_real   — bench imported a strict-real live check summary
  //                        generated from an isolated live-check DB.
  "harness_mode": "mcp_propose_review",
  "kpi": {
    "r_at_1": 0.0,                            // archival only; not threshold-gated
    "r_at_5": 0.0,
    "r_at_10": 0.0,
    "r_at_5_overall": 0.0,                    // env embedding only
    "r_at_5_with_embedding_returned": 0.0,    // env embedding only
    "r_at_5_round_1": 0.0,                    // public-multiturn only
    "r_at_5_round_2": 0.0,                    // public-multiturn only
    "r_at_5_round_n": 0.0,                    // public-multiturn final round
    "multiturn_rounds": 3,
    "provider_returned_rate": 0.0,            // env embedding diagnostics
    "provider_pending_rate": 0.0,
    "provider_failed_rate": 0.0,
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

`public-multiturn` uses a separate archive root and separate
`latest-baseline.json` from single-turn `public`. Its threshold decision
uses the same drop bands above, but the primary quality field is
final-round `r_at_5` / `r_at_5_round_n`; round-curve fields are evidence
for plasticity behavior, not a shared trend line with single-turn runs.

## Entry errata

This archive is append-mostly. Existing entries are immutable for KPI
fields; only metadata labels (split, dataset.name) may be corrected
when a Phase-N wiring bug wrote the wrong label at write time. Each
correction lists the affected slug + the corrected field + the commit
that did it. **Numbers (R@K, latency, tier_distribution,
degradation_reasons, per_scenario rows) are never rewritten** — to
restate a number, write a new entry.

| Slug | Field | Was | Is | Commit | Reason |
|---|---|---|---|---|---|
| `public/2026-05-14T095424Z-01385ce/` | `split` | `longmemeval-s` | `longmemeval-oracle` | dda1f9b | Variant was always Oracle; the v0.3.6 Phase 4 runner hard-coded `split: longmemeval-s`. Phase 5 introduced variant→split mapping. |

## Known bench-harness stderr noise

The `alaya-bench-runner self` and `alaya-bench-runner longmemeval` runs
emit one `MODEL_TOOL candidate signal emitted without source_delivery_ids.`
warning per seed. This is structural and intentional:

- Bench seeds enter through `soul.emit_candidate_signal` over MCP, so
  the daemon stamps them with `source = MODEL_TOOL` per invariants §29
  (the MCP request schema strips the `source` field — MCP callers cannot
  set it themselves).
- `MODEL_TOOL` signals are expected to carry `source_delivery_ids`
  pointing at a prior `soul.recall` delivery. Bench seeds originate
  from dataset fixtures, not from a recall, so no valid anchor exists.
- The daemon's `validateSourceDeliveryAnchors` would reject any synthetic
  id, so threading a fake anchor is not a fix.

The warning is informational; it does not change the propose+review
audit chain captured under `evidence/audit-trail-witness.json`.

## Live strict-real archive

`live/` is a bridge from local live-check summaries into this tracked
bench-history archive. v0.3.7 imported the older `.do-it/checks/alaya-live/`
history and removed the raw local run directories after import.

- Source input: a local aggregate `main-check.json`, or a per-run
  `main-check-run.json` generated by the live-check harness.
- Writer: `rtk node apps/bench-runner/bin/alaya-bench-runner.mjs live`
  (requires the local `.do-it` source summary).
- Output: `docs/bench-history/live/<slug>/{kpi.json,report.md,live-gates.json}`.
- Raw `.do-it` run directories, provider transcripts, sample JSONL, and
  secrets remain outside git and may be deleted after import; `live-gates.json`
  carries only the sanitized gate summary and aggregate metrics.
- `R@1` / `R@5` come from the `embedding-real-provider` mode. The live
  check records top1/top5 only, so the archive mirrors top5 into `R@10`
  and states that caveat in `report.md`.
- `tier_distribution` and `degradation_reasons` are aggregate placeholders
  for the shared KPI schema. Read the `Live mode comparison`, `Garden
  audit`, and gate table before using this entry for direction setting.

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

LongMemEval entries may include a `longmemeval-diagnostics.json`
sidecar. This file is additive bench evidence, not an MCP/protocol
schema. It records sanitized object-id diagnostics: question id, gold
memory ids, delivered object ids/ranks, miss classification, optional
normalized `recallResult.diagnostics` fields when the daemon supplies
them, and embedding provider state counts/rates. It must not include
raw turn text, raw provider transcripts, API keys, or secret refs.

When the daemon does not yet return `recallResult.diagnostics`, the
sidecar records `recall_diagnostics_present=false` and falls back to
final delivered-rank evidence plus `diagnostics_unavailable` for misses.
Env-embedding provider rates should be read as known returned/pending/
failed counts only; unknown provider state remains visible in the
sidecar and must not be quoted as a returned-vector result.

`public-multiturn` is a separate archive root. It reuses LongMemEval
material but runs repeated `soul.recall` -> `soul.report_context_usage`
rounds in one workspace per question. Its final-round `r_at_5` feeds
the overview card, while `r_at_5_round_1`, `r_at_5_round_2`, and
`r_at_5_round_n` preserve the round curve.

## How to add a new entry (operator handbook)

```bash
# from the alaya repo root (or any worktree on a branch you want to bench)
rtk pnpm install
rtk pnpm build

# 1. (LongMemEval only) Fetch the public dataset before the first run.
#    Verifies sha256 against datasets/<name>.meta.json and caches the JSON
#    under <data-dir>/longmemeval/.
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-longmemeval --variant oracle
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-longmemeval --variant s

# 2. Run the benches. Each writes <split>/<date>T<HHMMSS>Z-<sha7>/ and
#    rewrites the corresponding latest-baseline.json pointer.
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs self
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant oracle
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval-multiturn --variant s --rounds 3 --limit 20
# Optional: opt into the daemon's real embedding env for a cost-bearing
# semantic-supplement run. Keep local credentials outside git, for example
# in `.do-it/bench-env/alaya-api.env`, then source them before the run.
set -a; . .do-it/bench-env/alaya-api.env; set +a
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant s --embedding env

# 3. (Live only, operator with a newly generated local source) Archive a
#    strict-real live check into the tracked bench-history/live/ tree.
#    Pass either an aggregate main-check.json or a per-run main-check-run.json.
#    This imports only sanitized aggregate output; it does not commit raw
#    run artifacts.
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs live --source <local-main-check.json>
```

Then commit the new `<date>T<HHMMSS>Z-<sha7>/` directory +
`latest-baseline.json` update. If `findings.md` exists, open the
corresponding backlog entry in the same PR.
