# Benchmark reproduction and local history

This directory keeps benchmark definitions and navigation in source control.
Dataset identities and the fixed sampling manifest remain in [datasets/](datasets/README.md).
Generated results, extraction caches, and reconciliation caches are local,
ignored artifacts. A fresh checkout may have none of them.

Current recall behavior is defined by the [recall handbook](../handbook/recall.md).
Historical reports describe the candidate and configuration that produced them.

## Storage

| Content | Location |
| --- | --- |
| Dataset pins and sampling manifest | `docs/bench-history/datasets/` |
| Archives, reports, findings, and latest pointers | `.bench-artifacts/history/` |
| Extraction cache | `.bench-artifacts/cache/longmemeval-extraction-cache/` |
| Preserved historical reconciliation cache | `.bench-artifacts/cache/reconciliation-decisions/` |
| Raw downloaded datasets | `apps/bench-runner/data/` |
| Full diagnostics | `.bench-artifacts/`, or `ALAYA_BENCH_ARTIFACT_ROOT` |

Keep generated results and model caches out of Git, including full-dataset
baselines. Share an explicitly selected artifact when a review needs evidence.
Do not commit a cache to make a new checkout appear ready.

The reconciliation cache listed above preserves historical bytes. The live
daemon continues to use its existing `DATA_DIR/cache/reconciliation-decisions`
location (or `data/cache/reconciliation-decisions` when DATA_DIR is unset).

Explicit paths and supported environment overrides take precedence over defaults.
Extraction cache selection uses the explicit argument, then
`ALAYA_BENCH_EXTRACTION_CACHE_ROOT`, then the default above. `--data-dir` continues
to select raw dataset storage; this cleanup does not relocate its default.

The Bench/Eval CLIs and Inspector resolve their default history root from the
process working directory. Full/daily shell wrappers first enter the repository;
the root orchestrator and report-regeneration script also anchor their default
history to that repository. Relative explicit history paths follow the invoking
process working directory (the repository for those shell wrappers). Extraction
cache explicit/environment paths resolve from the process working directory,
while its default is anchored to the Bench installation's repository root.

An archive is a complete directory: retain `kpi.json`, `report.md`, any
`findings.md`, diagnostics sidecars, and referenced artifacts together. Preserve
latest pointers and their relative targets when moving history. Never remove a
failure finding or rewrite a historical result to make an archive pass.

## Reproduce a run

Build the checked-out candidate with `pnpm build` and inspect available options:

    node apps/bench-runner/bin/alaya-bench-runner.mjs --help

Record the candidate commit, dataset variant and checksum, exact question
selection, cache identities, and effective runtime settings. For LongMemEval,
keep `--offset`, `--limit`, question order, and any selected manifest fixed.
The retained `longmemeval_s.stratified-100.v1.json` identifies a specific ordered
100-question cohort; `--limit 100` alone does not reproduce that cohort.

Record `--concurrency`, `--embedding`, `--embedding-provider`, `--policy-shape`,
`--simulate-report`, ingestion mode, model/request profile, QA/judge settings,
and any time, token, or recall-weight overrides used by the selected workflow.

QA archives retain every attempted judgment. Empty or malformed evaluator text
has `correct: null` and an explicit validity reason; any invalid judgment leaves
the cohort's `qa_accuracy` unavailable without retrying or reducing `qa_total`.
Diagnostic shard merges may reconstruct cohort counts while leaving quality
facets `bench-quality-metrics.unavailable.v1`; unavailable facets cannot satisfy
numeric gates. The merge writes history-shaped `public/<slug>` files as
diagnostic evidence (`gate_eligible=false`, no latest-pointer update), not a
promotable history entry. The static `shard_merged` sample-size label is a
report facet, not that classification. Historical merge reporting denominators
do not establish current answerable-cohort or release authority. Mixed-treatment
stage pairing is the same diagnostic surface; it is not a production release
bypass.

Use the same explicit `--data-dir` for dataset warmup and scoring. Use
`--history-root` to choose a different output root. Dataset warmup downloads
dataset bytes; it does not authorize extraction or other model calls.

Prepare required local caches or snapshots before scoring. An explicitly
selected missing or invalid input must fail clearly: do not substitute another
dataset, baseline, or cache, and do not start model calls to repair it.
Extraction/fill is a separate explicit workflow with its existing authority and
budget requirements. Credentials alone do not make missing cache data valid.

`node scripts/run-full-bench-v0311.mjs --resume` reuses a completed step only
when its `<log-root>/<id>.done` checkpoint records the same requested run
identity (dataset, archive/history root, extraction cache, limit, policy shape,
and code revision) and the archive still contains `kpi.json`. A missing, legacy,
mismatched, or unverifiable checkpoint blocks the run with exit status 1 and
starts no replacement bench; remove it or rerun without `--resume` to run the
step explicitly.

## Structured round-source publication

The benchmark round producer is the product's host-session capture owner.
[`census.ts`](../../apps/bench-runner/src/runs/snapshot/source-records/census.ts) forms
each question's round roots with the Protocol owner (one container
`{ scope: "longmemeval_s", id: "<question>:s<session>" }` per haystack session,
`pairHostSessionRounds`, `hostSessionRoundSource`) and the capture requests of
[`host-session-import.ts`](../../apps/bench-runner/src/datasets/longmemeval/ingestion/host-session-import.ts);
[`publish.ts`](../../apps/bench-runner/src/runs/snapshot/source-records/publish.ts) admits
every session through the daemon's `captureHostSession` (64-message windows, the last
closing the tail) and seals fresh SQLite, never enriching an old receipt or reusing an
old index.

Round roots are `host-session:<container key>:r<round>` with version `host-session-v1`;
occurrences are `<question>:s<session>:m<message>` with the container, position and the
session date as host time; `event_time` is the session date and `recorded_at` the
publication's declared receipt time. A message over 16 KB is admitted as an honest
16 KB excerpt. Under the verified dataset pin the issuer is
`longmemeval-structured-source` / `pinned_dataset`; an unverified copy is captured as an
ordinary host session (`host_session` basis), never with dataset authority. Statement
sessions, SourceIndex rows and answer-span gold read the same containers, so the bench
and an MCP host that sends the same messages produce the same roots (only the issuer
differs). Snapshots published before this owner (`longmemeval_s:<q>-s<si>-r<ri>`,
`bench-round-host-v1:<sha>`) need their original commit to evaluate; rebuild instead.
Retained native readers and the separate per-message/persona source families keep their
existing contracts.

Publication accepts explicit `sourceLimits: { maxSources, maxContentBytes }`, checked
against the complete census before daemon startup/source writes. These are allocation
limits, not model allowances. `importEffects` shares message import's strict owner:
isolated configuration root, disabled SQLite write queue, omitted embedding startup
probe and disabled Garden compute. Embedding remains disabled. Native publication
owns admission, checkpoint, copy and shutdown; callers separately supervise deadlines
and retain failure/cleanup evidence. Timeout is not a successful seal or refundable
attempt. The strict source-import guard can persist per-thread state and observe
actual worker exit, because `Worker.terminate()` need not run a JS exit callback.

`round-source-publication.test.ts` exercises real publisher→Core→sealed SQLite,
independent UTF-8 intervals, preserved legacy facts, read-only publication binding,
custom-pin unknown state and pre-start count/byte refusal. It uses authored data,
not natural questions, inference, provider traffic or scores.

## Metrics and comparisons

The offline `scripts/compute-bench-quality-metrics.mjs` projection accepts KPI
quality contracts or diagnostics with `questions[]` (schema version 1, or an
unversioned historical sidecar). Each diagnostic question needs an explicit
`delivered_results[]` and either `gold[]` or a gold identity list
(`gold_object_ids`, `gold_memory_ids`, `gold_evidence_ids`). Nonempty delivery and
gold rows carry `object_id`; identity lists contain nonempty strings. Explicit
empty lists are observed empty measurements; omitted lists are not. Historical
identity-only gold remains readable, but each facet requires its own consumed
fields across the declared population: budget drop reasons; lexical and final
ranks; source planes and (for nonempty planes) final ranks; and each delivery's
first/winning admission plane, using its gold fallback only when absent on the
delivery. Explicit nullable ranks/drop reasons/planes retain their producer
meaning; they are not missing fields. Missing gold identities suppress gold-hit
accounting without discarding independently measured delivery attribution.
Unavailable facets and their counters are omitted and explained in
`metadata.unavailable_metrics`, not filled with zeros or measured on a smaller
subset. Missing delivery scores leave order rate unavailable over the unchanged
question population. Active constraint totals require an archive declaration or
complete per-question observations; null counts and incomplete receipts remain
unavailable. Existing array-over-count precedence and counting stay unchanged.
Unknown versions and malformed supplied measurements fail.

- `sample_size` identifies the dataset population; `evaluated_count` records the
  evaluated selection. Keep answerable, abstention, and invalid cohorts distinct.
- LongMemEval `r_at_1`, `r_at_5`, and `r_at_10` are hit proportions over the
  answerable cohort. Overall, embedding-returned, gold-coverage, and QA metrics
  have their own denominators and are not interchangeable. The archive owner is
  [runner-archive-payload.ts](../../apps/bench-runner/src/datasets/longmemeval/runner/archive/runner-archive-payload.ts).
- Latency records its measurement source. `worst_shard_bound` is an upper bound,
  not a measured run-wide percentile. Sample labels are defined in
  [wilson-ci.ts](../../packages/eval/src/metrics/wilson-ci.ts); a label alone does
  not establish release eligibility.
- Token savings compare measured recall context with the applicable full-history
  baseline. Preserve unknown/null measurements instead of manufacturing zero.
  See [token-economy.ts](../../packages/eval/src/metrics/token-economy.ts) and the
  [KPI contract](../../packages/eval/src/contracts/kpi-schema.ts).

Compare matching dataset/selection and runtime cohorts. Regression bands live in
[thresholds.ts](../../packages/eval/src/gates/thresholds.ts); passing eligibility
uses the executable release gates and archive contracts, not the storage path.
`alaya-eval diff` selects the newest earlier entry that matches the current
split, policy shape, simulate-report mode, and embedding provider; when other
entries exist but none matches, it exits 2 instead of diffing an incompatible
baseline.

`latest-run*.json` identifies the newest archived run, including failures.
`latest-passing*.json` advances only for eligible passing evidence with no
findings. The public LongMemEval Oracle and M splits (`longmemeval-oracle`,
`longmemeval-m`) keep archives and `latest-run*.json` pointers but cannot advance
a shared `latest-passing*.json` chain because they have no applicable release
gate; maintained-content CI enforces that refusal. `latest-baseline*.json` is a
legacy passing alias. Keep embedding cohorts and distinct benchmark surfaces in
their own pointer chains. Historical retired surfaces remain readable without
reintroducing their runners.

CI verifies archive, pointer, checksum, and failure behavior with deterministic
temporary fixtures. It does not require a contributor's local history or model
cache. Empty local history is a valid fresh-checkout state; an explicitly
requested missing baseline is an error.
