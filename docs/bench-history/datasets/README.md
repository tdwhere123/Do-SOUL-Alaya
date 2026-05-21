# Bench Dataset Checksums

Each `<dataset>.meta.json` here pins the exact bytes a public benchmark
was scored against. The bench-runner's `fetch-longmemeval` verb warms or
refreshes the local JSON cache and writes a scratch meta file; the pinned
checksum is enforced by `loadDataset` and by the sharded full-bench
preflight before scoring. That split keeps cache warmup cheap while still
making `alaya-bench-runner longmemeval` reproducible on another machine.

## Format

```jsonc
{
  "name": "longmemeval_oracle",
  "source_url": "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json",
  "sha256": "<filled by fetch>",
  "fetched_at": "<ISO>",
  "size_bytes": 0
}
```

## Files

- `longmemeval_oracle.meta.json` — populated on the first `alaya-bench-runner
  fetch-longmemeval --variant oracle` run; commit alongside the kpi entry
  whose numbers were computed against it.
- `longmemeval_s.meta.json` — same shape, `--variant s`.
- `longmemeval_m.meta.json` — same shape, `--variant m`.

## Why pin checksum

A bench number against an unpinned remote dataset is not reproducible
across upstream edits. The contract is:

1. The bench-runner fetches the dataset, computes sha256, and writes a
   scratch meta-json next to the local cache bytes. The committed meta-json
   in this directory is the source of truth and is updated only as an
   intentional dataset pin change.
2. Later runs read the pinned sha256 first; if the local file doesn't
   match, the run aborts with `dataset checksum mismatch`. Heavy sharded
   runs should pass the same explicit `--data-dir <shared-cache>/longmemeval`
   used by the warmup fetch; missing local bytes or scratch meta fail in
   preflight with the exact warmup command. Checksum mismatch prints a
   `fetch-longmemeval ... --force` refresh command so stale bytes do not
   loop through the normal cache-hit path. LoCoMo uses the same split with
   `fetch-locomo --data-dir <shared-cache>/locomo` and
   `run-full-locomo-bench.sh --data-dir <shared-cache>/locomo`.
3. Bench-history entries cite the dataset checksum in their `kpi.json`
   `dataset.source` field.

## Extraction cache fixture

`longmemeval-extraction-cache/` holds the on-disk cache of the LongMemEval
bench seed path's production garden extraction. Each haystack turn is run
through `OfficialApiGardenProvider.compile()` (one LLM call → N typed
candidate signals); the raw LLM response is cached here keyed by a SHA-256
of the load-bearing extraction inputs only (model + system prompt + turn
content) — never the volatile routing context (run_id / workspace_id) —
sharded by the first two hex
chars.

This directory is **EMPTY on a fresh checkout** — it is not pre-populated.
The first credentialled bench run extracts via the garden LLM and writes the
fixture; that fixture must then be committed. Only after it is committed
does a later run (CI, other contributors) reuse it with zero LLM calls and
become one-click repeatable. Until the fixture is committed:

- a fresh checkout **with** garden credentials re-extracts live, and
- a fresh checkout **without** credentials takes the degraded no-LLM
  single-fact fallback (the full turn becomes one candidate fact).

Those two paths produce different ingestion granularity; the bench report
discloses which path ran. See
`apps/bench-runner/src/longmemeval/compile-seed.ts`.
