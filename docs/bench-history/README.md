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

v0.3.11's Tier 1 release archive surfaces are `public/`,
`public-multiturn/`, `public-crossquestion/`, `public-locomo/`, and
`live/`. `public-crossquestion` and `public-locomo` are current archive
roots, not future placeholders: their runners write compact diagnostics
sidecars into this tree and write full diagnostics outside the tracked
archive root.

The premise: a single one-off benchmark number is theatre. A feedback
loop — same harness, same data, diffed against previous baselines, with
regression thresholds and an Inspector trend line — is engineering.

## Storage policy & retention (READ FIRST)

Benchmark output has exactly two homes. Putting a run in the wrong one is
the mess this policy exists to stop (e.g. the retired
`v0311-lever-ab-2026-06-17/` ad-hoc dir — a limit-100 A/B that never
belonged in the tracked tree).

- **Tracked — `docs/bench-history/` = confirmed full-dataset baselines ONLY.**
  A run lands here only if it is release-grade (full split: LongMemEval-S
  = 500, LoCoMo = 1982) and written through the archive+pointer mechanism
  (`<root>/<slug>/kpi.json` + `latest-*.json`). Commit **compact diagnostics
  sidecars only**; full per-question diagnostics live outside this tree
  (gitignored, see below). Never commit limit-N runs, A/B sweeps, oracle /
  QA / temporal probes, or hand-named dated dirs here.
- **Gitignored scratch — everything else.** Two sinks, both ignored:
  - `.do-it/bench-runs/` — manual experiments, A/B sweeps, probes, drivers,
    `scripts/` (reusable analysis tools), run logs. This is where
    experimental work goes.
  - `.bench-artifacts/` — the harness's auto-emitted full diagnostics
    (regenerable; `full_diagnostics_artifact_path` points here).

**Retention.**

- Tracked: keep only the archives referenced by the current `latest-run*`
  / `latest-passing*` / `latest-baseline*` pointers, plus anything ≤ 7 days
  old. Prune the rest (delete the archive; never leave a pointer dangling —
  repoint or delete it too).
- Gitignored scratch: prune to ≤ 7 days. Always keep
  `.do-it/bench-runs/scripts/` (tools, age-independent), writeups under
  `.do-it/findings/`, and the most recent full run.
- The canonical baseline writeup (`baseline-<date>.md`) is **replaced** on
  each new full baseline, not accumulated — one current baseline doc, not a
  pile of dated ones.

## Bench run config (current)

The standing QA + seeding config for baseline runs, so it is not re-litigated:

- **QA answer + judge model = `gpt-5.4-nano` (both).** nano is the stronger
  5.4-generation model; baseline QA does **not** match the older gpt-4o
  "official" judge. Set via `OFFICIAL_API_GARDEN_QA_MODEL` and
  `OFFICIAL_API_GARDEN_QA_JUDGE_MODEL`; QA routed through the Clash proxy shim
  (`.do-it/bench-runs/scripts/proxy-preload.mjs`, `NODE_OPTIONS=--import …`).
- **Seeding = distilled extraction cache** (`--extraction-cache-root
  docs/bench-history/datasets/longmemeval-extraction-cache`, model
  `gpt-5.4-nano`, `coverage=1` → cache hits, zero live extraction calls);
  daemon reconciliation `ALAYA_GARDEN_PROVIDER_KIND=local_heuristics`.
- **Embedding** local ONNX `paraphrase-multilingual-MiniLM-L12-v2`
  (`--embedding env --embedding-provider local_onnx`,
  `ALAYA_LOCAL_EMBEDDING_CACHE_DIR`); the off arm uses `--embedding disabled`.

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
  `packages/eval/src/gates/thresholds.ts`. A `✗` finding flips the CLI exit
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
│   ├── latest-run.json                    # newest write, passing or failing
│   ├── latest-passing.json                # newest release-gate passing write
│   └── latest-baseline.json               # legacy alias of latest-passing
├── public/
│   ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│   │   ├── kpi.json
│   │   ├── longmemeval-diagnostics.json (optional compact summary)
│   │   ├── report.md
│   │   └── findings.md (optional)
│   ├── latest-run.json                    # newest write across providers
│   ├── latest-passing.json                # newest passing write
│   ├── latest-run-embedding-off.json      # newest embedding=none write
│   ├── latest-passing-embedding-off.json  # newest passing embedding=none write
│   ├── latest-run-embedding-on.json       # newest embedding-on write
│   ├── latest-passing-embedding-on.json   # newest passing embedding-on write
│   ├── latest-baseline.json               # legacy alias of latest-passing
│   └── latest-baseline-embedding-on.json  # legacy alias of latest-passing-embedding-on
├── public-multiturn/
│   ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│   │   ├── kpi.json
│   │   ├── longmemeval-diagnostics.json   # compact summary
│   │   ├── report.md
│   │   └── findings.md (optional)
│   ├── latest-run.json
│   ├── latest-passing.json
│   └── latest-baseline.json               # legacy alias
├── public-crossquestion/
│   ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│   │   ├── kpi.json
│   │   ├── longmemeval-diagnostics.json   # compact summary
│   │   ├── report.md
│   │   └── findings.md (optional)
│   ├── latest-run.json
│   ├── latest-passing.json
│   └── latest-baseline.json               # legacy alias
├── controlled-replay/
│   └── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│       └── controlled-replay.json          # diagnostic archive; no KPI pointer
├── public-locomo/
│   ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
│   │   ├── kpi.json
│   │   ├── locomo-diagnostics.json        # compact summary
│   │   ├── report.md
│   │   └── findings.md (optional)
│   ├── latest-run.json
│   ├── latest-passing.json
│   └── latest-baseline.json               # legacy alias
└── live/
    ├── <YYYY-MM-DDTHHMMSSZ>-<sha7>/
    │   ├── kpi.json                       # normalized strict-real KPIs
    │   ├── report.md                      # gate table + live mode comparison
    │   ├── live-gates.json                # sanitized source gate summary
    │   └── findings.md (optional)
    ├── latest-run.json
    ├── latest-passing.json
    └── latest-baseline.json               # legacy alias
```

### Latest pointers

- `latest-run*.json` — newest archived write, even when findings or
  release hard gates failed. Operational dashboards use this to show
  the freshest run truth without implying it is releasable.
- `latest-passing*.json` — newest archive whose report has no findings
  and whose executable release hard gates pass. For v0.3.11 Tier 1 roots,
  the run must also be release-grade: LongMemEval-S roots require
  `sample_size >= 500` with `evaluated_count >= sample_size`, LoCoMo
  requires `sample_size >= 1982` with `evaluated_count >= sample_size`,
  and `live/strict-real` requires `live-gates.json` with source status
  `pass` and at least one passing source gate. Release closeout and
  baseline comparisons use this pointer.
- Provider-specific suffixes split embedding-off (`embedding_provider:
  "none"`) and embedding-on (`local_onnx`, `env`, or another provider)
  so an embedding-on failure cannot pollute the embedding-off release
  chain, and vice versa.
- `latest-baseline*.json` remains only as a legacy alias written from
  `latest-passing*.json` for old tooling. New code should read
  `latest-run*` or `latest-passing*` explicitly.
- v0.3.11 Tier 1 release surfaces use these archive roots and stable KPI
  labels:
  - `public/`: `bench_name = "public"`, `split = "longmemeval-s"` for
    LongMemEval-S single-turn release runs.
  - `public-multiturn/`: `bench_name = "public-multiturn"`,
    `split = "longmemeval-s"` for repeated recall plus
    `soul.report_context_usage` rounds.
  - `public-crossquestion/`: `bench_name = "public-crossquestion"`,
    `split = "longmemeval-s"` for cross-question LongMemEval-S runs.
  - `public-locomo/`: `bench_name = "public-locomo"`,
    `split = "locomo10"` for LoCoMo release runs.
  - `live/`: `bench_name = "live"`, `split = "strict-real"` for sanitized
    strict-real live-check imports.

### Sample-size label cascade

`packages/eval/src/metrics/wilson-ci.ts` derives the sample-size label from
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
- Latest pointer files are JSON pointers (`{ "slug": ..., "kpi_path": ... }`).
  `writeEntry` rewrites `latest-run*` for every archive write and rewrites
  `latest-passing*` only when findings are absent, release hard gates pass,
  and the archive is eligible as release-grade Tier 1 evidence where the
  root is one of the v0.3.11 Tier 1 surfaces above.
  `readLatest` defaults to `latest-run*`; pass `pointerKind: "passing"` when a
  release/baseline decision needs the newest passing entry.
- Full LongMemEval/LoCoMo question diagnostics are not tracked under
  `docs/bench-history/**` for new writes. The tracked diagnostics sidecar is a
  compact summary that contains `full_diagnostics_artifact_path`. Set
  `ALAYA_BENCH_ARTIFACT_ROOT` to choose the external artifact root; otherwise
  the runner writes full diagnostics under repo-local `.bench-artifacts/`.
  `.npmignore` excludes both paths for npm-pack bloat proof only; GitHub
  Release source tarballs are verified by the release tarball + `SHA256SUMS`
  path, not by npm-pack dry-run output.
- `findings.md` is emitted by the diff engine when any KPI hits the `✗`
  threshold; it lists the regression, the suspected root cause, and a
  candidate `#BL-XXX` backlog entry. The release relay turn must lift
  these into `docs/handbook/backlog.md`.

## KPI schema (`kpi.json`)

Version-scoped planning labels such as `K1.3-off` belong in the
release initiative docs only. Machine-readable hard gates, reports, and
archives use stable semantic identifiers from
`packages/eval/src/gates/release-gates.ts` so future releases can reuse the
same gates without inheriting v0.3.10 phase names.

```jsonc
{
  "bench_name": "self" | "public" | "public-multiturn" | "public-crossquestion" | "public-locomo" | "live",
  "split": "golden" | "synthetic" | "longmemeval-s" | "longmemeval-oracle" | "longmemeval-m" | "locomo10" | "strict-real",
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

Defined in `packages/eval/src/gates/thresholds.ts`. Reference values:

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

`public-multiturn` uses a separate archive root and separate latest
pointers from single-turn `public`. Its threshold decision uses the same
drop bands above, but the primary quality field is final-round `r_at_5` /
`r_at_5_round_n`; round-curve fields are evidence for plasticity behavior,
not a shared trend line with single-turn runs.

`public-crossquestion` uses a separate archive root and latest pointers
from both `public` and `public-multiturn`. Its v0.3.11 full embedding-off
ship gate is LongMemEval-S cross-question `R@5 >= 90%` at `evaluated_count
>= sample_size` with `sample_size >= 500`.

`public-locomo` uses a separate archive root and latest pointers. Its
v0.3.11 full ship gate is LoCoMo `R@5 >= 55%` with embedding off and
`R@5 >= 90%` with embedding on (`local_onnx` in the release run; any
non-`none` provider is treated as embedding-on by the executable gate),
at `evaluated_count >= sample_size` with `sample_size >= 1982`.

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
- A `live/strict-real` entry without `live-gates.json`, source status
  `pass`, and at least one passing source gate can still archive as
  `latest-run`, but it is not eligible for `latest-passing`.
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

LongMemEval entries may include a compact
`longmemeval-diagnostics.json` sidecar. This file is additive bench
evidence, not an MCP/protocol schema. New writes keep only summary
counts/rates, scored recall evidence, cache summaries, and
`full_diagnostics_artifact_path` in the tracked archive. The full
question-level diagnostics live outside `docs/bench-history/**` under
`ALAYA_BENCH_ARTIFACT_ROOT` or the default `.bench-artifacts/` root.

LoCoMo entries use the same compact pattern in `locomo-diagnostics.json`.
Gold references in the external full artifact are still memory object ids
plus source `dia_id` values; raw conversation text remains outside both
the tracked sidecar and the external diagnostics artifact.

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

`public-crossquestion` is also a separate archive root. It reuses
LongMemEval-S material but scores cross-question recall sequences under
`bench_name = "public-crossquestion"` so single-turn, multi-turn, and
cross-question evidence cannot overwrite each other's latest pointers.

## How to add a new entry (operator handbook)

```bash
# from the alaya repo root (or any worktree on a branch you want to bench)
rtk pnpm install
rtk pnpm build

# 1. (LongMemEval only) Fetch the public dataset before the first run.
#    Verifies sha256 against datasets/<name>.meta.json and caches the JSON
#    under <data-dir>/longmemeval/.
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-longmemeval --variant oracle --data-dir <shared-cache>/longmemeval
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-longmemeval --variant s --data-dir <shared-cache>/longmemeval
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-locomo --data-dir <shared-cache>/locomo
# If a checksum mismatch proves the cache bytes are stale/corrupt:
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-longmemeval --variant s --data-dir <shared-cache>/longmemeval --force

# 2. Run the benches. Each writes <split>/<date>T<HHMMSS>Z-<sha7>/,
#    rewrites latest-run*.json, and rewrites latest-passing*.json only
#    when findings are absent, release hard gates pass, and the Tier 1
#    archive is release-grade rather than smoke/staged diagnostics.
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs self
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant oracle --data-dir <shared-cache>/longmemeval
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval-multiturn --variant s --rounds 3 --data-dir <shared-cache>/longmemeval
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval-crossquestion --variant s --data-dir <shared-cache>/longmemeval
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs locomo --data-dir <shared-cache>/locomo
# Add --limit only for local smoke/diagnostic runs. Limited Tier 1
# runs rewrite latest-run*.json but are not release baselines and do
# not advance latest-passing*.json.
# Optional: opt into the daemon's real embedding env for a cost-bearing
# semantic-supplement run. Keep local credentials outside git, for example
# in `.do-it/bench-env/alaya-api.env`, then source them before the run.
set -a; . .do-it/bench-env/alaya-api.env; set +a
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant s --embedding env --data-dir <shared-cache>/longmemeval
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs locomo --embedding env --embedding-provider local_onnx --data-dir <shared-cache>/locomo

# 3. (Live only, operator with a newly generated local source) Archive a
#    strict-real live check into the tracked bench-history/live/ tree.
#    Pass either an aggregate main-check.json or a per-run main-check-run.json.
#    This imports only sanitized aggregate output; it does not commit raw
#    run artifacts.
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs live --source <local-main-check.json>
```

Then commit the new `<date>T<HHMMSS>Z-<sha7>/` directory plus the matching
latest pointer updates. If `findings.md` exists, open the corresponding
backlog entry in the same PR and expect only `latest-run*` to move.
