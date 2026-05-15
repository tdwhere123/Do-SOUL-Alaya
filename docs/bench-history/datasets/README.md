# Bench Dataset Checksums

Each `<dataset>.meta.json` here pins the exact bytes a public benchmark
was scored against. The bench-runner's `fetch-longmemeval` verb verifies
the local download matches this checksum before running, so re-running
`alaya-bench-runner longmemeval` on a different machine produces numbers
against the same dataset bytes the published baseline used.

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

1. The bench-runner fetches the dataset, computes sha256, and writes the
   meta-json here (with `git add` left to the operator so accidental
   re-fetches do not silently mutate the pin).
2. Later runs read the pinned sha256 first; if the local file doesn't
   match, the run aborts with `fetch-longmemeval: checksum mismatch`.
3. Bench-history entries cite the dataset checksum in their `kpi.json`
   `dataset.source` field.
