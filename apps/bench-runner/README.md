# @do-soul/alaya-bench-runner

Daemon-attached benchmark runner for Do-SOUL Alaya.

## Role

`apps/bench-runner` owns executable benchmark harnesses for LongMemEval-S
and LoCoMo. It attaches to the daemon/runtime surface and keeps
`@do-soul/alaya-eval` schema-focused.

## Dependency Direction

The bench runner may depend on daemon, core, soul, storage, protocol, and
eval packages because it is an application-level harness. Production
packages must not depend on the bench runner.

## Key Entry Points

- `src/longmemeval/` owns LongMemEval-S harness and campaign machinery.
- `src/locomo/` owns the LoCoMo10 runner.
- `src/longmemeval/provider/` is the model-neutral extraction catalog.
- `bin/alaya-bench-runner.mjs` is the package CLI entrypoint.

## Commands

For asynchronous Gemini extraction, see [the Batch runbook](docs/gemini-batch.md).

```bash
pnpm --filter @do-soul/alaya-bench-runner run typecheck
pnpm --filter @do-soul/alaya-bench-runner run test
pnpm --filter @do-soul/alaya-bench-runner run build
```

## Original source snapshots

`source-snapshot prepare` imports every original message in a pinned
LongMemEval-S window through mandatory audited Core source admission. It does
not extract, create memories or capsules, call providers, or score answers.
Use an isolated import directory and an output under `.do-it/bench-runs/`:

```bash
node apps/bench-runner/bin/alaya-bench-runner.mjs source-snapshot prepare \
  --snapshot .do-it/bench-runs/source-records/source.db \
  --data-dir-root .do-it/bench-runs/source-records/import \
  --data-dir /absolute/path/to/dataset --pinned-meta-root /absolute/path/to/pins \
  --offset 0 --limit 100 --recorded-at 2026-09-13T00:00:00.000Z

node apps/bench-runner/bin/alaya-bench-runner.mjs source-snapshot inspect \
  --snapshot .do-it/bench-runs/source-records/source.db \
  --question-id QUESTION_ID --query 'Original question text' \
  --max-results 20 --max-pages 100
```

The version-2 source artifact has an explicit `source_records` manifest and a
`.sources.json` index of ordered, content-addressed `.sources.SHA256.json`
message shards. Each shard is limited to 8 MiB; the index is limited to 16 MiB.
Preparation and inspection retain one shard at a time rather than serializing
all source spans into a single string. The index binds every shard's digest,
byte length and message count, and inspection still validates every native
record and span identity. Copy the DB, manifest, index and all referenced shards
together. Version-1 source artifacts must be prepared again in a fresh isolated
directory; the earlier post-extraction artifact format is unchanged.
Message roles, identities and UTF-8 bodies
remain original, including empty messages. Session observation dates and each
question's interpretation clock are retained separately from import
`recorded_at`; raw event times and validity remain unknown. Inspect passes the
frozen question clock through the existing MCP `source_observed_at` input,
restores a private copy, and returns actual `source_only` worker pages. A partial
interpretation is usable: an unguarded epsilon program enumerates authorized
sources, while its interpretation hole remains open. This is not evidence that
those sources semantically answer the question.

Inspect follows continuations up to `--max-pages`. `continuation_state` reports
exhaustion or the inspection page limit; returned tokens belong to that closed
inspection session and cannot be resumed afterward. Native index completeness
is returned without upgrading unknown, unavailable or partial states.

Preparation uses deferred projection admission and one final owned checkpoint.
Record/span admission is atomic; audit or checkpoint failure prevents a ready
manifest but may leave committed records and unsealed shards. Retry with the same dataset window,
output path and `recorded_at` to recover those identities. Retired sources cannot
be revived. A validated existing artifact is reused only when those inputs
match, and keeps its original producer commit. Unreferenced shards from an
interrupted attempt are retained but do not belong to the sealed artifact.
The CLI resolves that commit
from its source checkout; an installed build outside a checkout requires the
explicit `--producer-commit FULL_SHA` provenance declaration.

Source artifacts cannot enter the existing post-extraction snapshot reader.
That domain still requires complete current cache authority and `answers_with`
formation; source preparation does not satisfy those enhancement prerequisites.
