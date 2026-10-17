# Pinned benchmark datasets

This directory contains maintained dataset identities and a fixed sampling
manifest. Raw datasets and generated model caches remain local and ignored.

| Tracked definition | Purpose |
| --- | --- |
| [longmemeval_oracle.meta.json](longmemeval_oracle.meta.json) | LongMemEval Oracle identity |
| [longmemeval_s.meta.json](longmemeval_s.meta.json) | LongMemEval-S identity |
| [locomo10.meta.json](locomo10.meta.json) | LoCoMo10 identity |
| [longmemeval_s.stratified-100.v1.json](longmemeval_s.stratified-100.v1.json) | Ordered 100-question LongMemEval-S cohort |

The metadata files pin the source and SHA-256; preserve their exact contents
unless intentionally changing the dataset version. LongMemEval admission checks
`sha256`, `size_bytes`, and `question_count` against the committed pin. Other
metadata fields retain provenance. LoCoMo has its own metadata shape; do not
replace it with LongMemEval's field assumptions.

The sampling manifest binds its question IDs and order to `dataset_sha256`,
`algorithm_version`, and `target_count`. Reusing a limit of 100 or drawing another
100-question sample does not reproduce this cohort. Preserve the manifest's
version and bytes independently of generated run results.

## Local data and cache preparation

Raw dataset defaults stay under `apps/bench-runner/data/`. The fetch and scoring
commands accept `--data-dir`; use the same explicit location in both. For example:

    node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-longmemeval --variant s --data-dir <local-longmemeval-data>
    node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-locomo --data-dir <local-locomo-data>

Fetch writes local bytes and scratch metadata. Scratch metadata does not replace
a committed pin. Scoring/preflight must reject missing or mismatched required
inputs; an intentional refresh uses the fetch command's `--force` option and
still must match the committed identity. Dataset downloading does not perform
model extraction.

Extraction caches default to
`.bench-artifacts/cache/longmemeval-extraction-cache/`. Historical reconciliation
cache bytes moved to `.bench-artifacts/cache/reconciliation-decisions/`; the live
daemon's existing `DATA_DIR/cache/reconciliation-decisions` location is unchanged.
An explicit extraction-cache argument takes precedence over its environment
override and default. Relative explicit/environment paths resolve from the
process working directory; the default is anchored to the Bench installation's
repository root. Preserve
cache manifests, request/profile identities, receipts, and shard contents as one
cache population; a directory's existence alone does not establish readiness.

A fresh checkout has no guaranteed model cache. An explicitly requested missing
or invalid cache must fail clearly, without switching to another cache, inventing
a degraded result, or automatically calling a model. Fill/rebuild remains a
separate explicit, authorized workflow. Do not commit generated caches or results.

## Explicit task-persona inputs

Source-message import and query preparation default to unknown attribution. The
Bench-only opt-in `longmemeval-question-local-persona-v1` represents the task's
question-local presented user across its actual history sessions and current query.
It does not authenticate common human authorship, establish truth, or connect
users across questions. Assistant authors remain unknown, including quoted user
text. Empty source messages remain present with unknown attribution and no invented
utterance spans; empty queries remain invalid. The policy requires the pinned dataset identity and matching original inputs;
custom metadata cannot enable it.

For an existing sealed source-records snapshot, `source-snapshot prepare` accepts
`--attribution-policy longmemeval-question-local-persona-v1` together with
`--parent-snapshot <sealed-parent-db>` and the ordinary preparation flags. Use a
fresh output directory and a strictly later recorded time. The importer preserves
complete parent membership and seals old/new record mappings; it does not rebind
metadata under an old version or seal a selected subset as the full population.
Historical source/question clocks remain distinct from the new capture time.

`source-snapshot query-input --data-dir <local-longmemeval-data> --offset <original-row>
--question-id <original-id> --attribution-policy longmemeval-question-local-persona-v1`
emits an original-query workset item with the same scoped attribution and an explicit
approved-context explanation. Omitting the policy keeps attribution unknown.
Subsequent C production still needs source-grounded correspondence justification;
this input policy is not a semantic admission, model-call grant or recall result.

See the [reproduction and local-history guide](../README.md) for runtime settings,
metric definitions, archive integrity, and comparison requirements.
