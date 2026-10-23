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
- `src/runs/recall-measurement/` owns native snapshot preparation, replay,
  first-exposure readmission, and ordinary public-capture inspection.
- `src/runs/semantic-cache/` owns read-only retained Q/C request identity and
  cache readmission; it has no fill, execution authority, or provider dispatch.
- `bin/alaya-bench-runner.mjs` is the package CLI entrypoint.

## Commands

For asynchronous Gemini source extraction, see [the Batch runbook](docs/gemini-batch.md).

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

Message roles, identities and UTF-8 bodies remain original, including empty
messages. Session observation dates and each question's interpretation clock
are retained separately from import `recorded_at`; raw event times and validity
remain unknown. Inspect passes the frozen question clock through the existing
MCP `source_observed_at` input, restores a private copy, and returns actual
`source_only` worker pages. A partial interpretation is usable: an unguarded
epsilon program enumerates authorized sources, while its interpretation hole
remains open. This is not evidence that those sources semantically answer the
question.

Inspect follows continuations up to `--max-pages`. `continuation_state` reports
exhaustion or the inspection page limit; returned tokens belong to that closed
inspection session and cannot be resumed afterward. Native index completeness
is returned without upgrading unknown, unavailable or partial states.

Preparation uses deferred projection admission and one final owned checkpoint.
Record/span admission is atomic; audit or checkpoint failure prevents a ready
manifest but may leave committed records and unsealed shards. Retry with the
same dataset window, output path and `recorded_at` to recover those identities.
Retired sources cannot be revived. A validated existing artifact is reused only
when those inputs match, and keeps its original producer commit. Unreferenced
shards from an interrupted attempt are retained but do not belong to the sealed
artifact. The CLI resolves that commit from its source checkout; an installed
build outside a checkout requires the explicit `--producer-commit FULL_SHA`
provenance declaration.

Source artifacts cannot enter the existing post-extraction snapshot reader.
That domain still requires complete current cache authority and `answers_with`
formation; source preparation does not satisfy those enhancement prerequisites.

## Offline recall measurement

After `pnpm build`, the native measurement entry accepts a retained snapshot and
an exact [measurement configuration](src/runs/recall-measurement/contract.ts):

```bash
node apps/bench-runner/dist/runs/recall-measurement/launch.js prepare --root ROOT --config CONFIG
node apps/bench-runner/dist/runs/recall-measurement/launch.js replay --root ROOT --arm retained
node apps/bench-runner/dist/runs/recall-measurement/launch.js measure --root ROOT --replay REPLAY_PATH --gold GOLD_PATH --evaluator-root EVALUATOR_ROOT
```

The configuration binds the snapshot path/digest, current implementation revision,
fixed interpretation clock, workspace/run, original query workset, Q/C cache roots,
output cap, discovery page cap, correspondence pair cap, native budget, authorized
scopes, and output byte limit. Preparation retains every question and exact
optional cached-workset identity. Absent Q/C does not block original-query native
source discovery and delivery. Missing or rejected interpretations remain distinct
from valid-empty results. Gold is unavailable to preparation and replay.

These commands make no provider calls and do not fill or modify retained Q/C
caches. Private proposal generation, lazy qualification, paid task consumers,
recovery windows and research control launchers have been removed. Their local
historical artifacts remain evidence, not executable authority. Native/public
Q/H/C contracts are unchanged; retained states do not authorize generation.

Stages bind snapshot, implementation, interpretation and fixed context. Changed
inputs require a new preparation root or replay identity. Replay records native
first exposure. An interrupted exposure reservation without a result fails closed
and retains its working database for diagnosis; it is not automatically replayable.
Measurement uses fresh archive/source readmission, independently retained
publication records, and a separate evaluator root. Its `evaluator_usage` reports
fresh proof verification and logical allocation separately from native retrieval.
Historical measurements without evaluator cost retain that absence.

Gold is an array of `{ "query_key": "...", "source_units": [...] }` with exactly
one row for every prepared question, including blocked questions. Missing gold is
not an empty gold set. Unvisited or unfinished native work keeps a negative primary
outcome unknown; observed valid hits remain hits. The delivered-slot union is a
diagnostic. `--arm without_semantic_correspondences` is a separate native control
with the same snapshot, Q, clock, budget and scopes, not a compiled-leaf intervention.

## Private frozen-nomination delivery

The existing `src/runs/source-access-diagnostic/conditional-navigation-launch.ts`
entry accepts an explicit `frozen_nominations` option in its
[run configuration](src/runs/source-access-diagnostic/conditional-navigation-input.ts):

```json
{
  "family": "conditional-navigation-pilot.v1",
  "receipt": { "path": "/absolute/origin/receipt.json", "sha256": "64 lowercase hex digits" },
  "byte_budget": 8192
}
```

All other row fields must equal the receipt-bound sibling `input.json`, including
full membership, original conditions, snapshots, raw/paired profile identities,
clock and scopes. `source_revision` identifies the current execution; the output
separately retains the historical origin. This named compatibility reader accepts
only the pre-arm pilot envelope with canonical full nomination witnesses, not
`occurrence_prefix` reconstruction or unchecked solved order. Its removal boundary
is termination/replacement of this delivery-only comparison.

Frozen mode produces `window-prefix` and `window-native-anchor` arms with the
same field order, selected membership, ten-slot ceiling and declared byte budget.
Both read current authorized native source bytes on a disposable SQLite copy;
stored preview text is not a delivery input. Missing native locations make that
arm unavailable without prefix substitution. Empty, partial and unknown nomination
states remain distinct. Inherited preparation/acquisition evidence is retained
separately from fresh admission/delivery costs. No model client is constructed,
query prepared, nomination acquired or index built. Formation/model/channel
changes, condition-cover selection and structural/temporal interventions are
rejected, not ignored. Omission preserves existing live-acquisition defaults.

After building, use the existing entry's `--config CONFIG --out NEW_ROOT` and
separate `--evaluate ROOT --labels MANIFEST --out NEW_FILE` forms. Evaluation
admits every selected output before opening labels and retains the full input
denominator, unavailable/null pairs and independently scorable UNKNOWN results.
This measures delivery applicability/bytes/visibility only, not generation value,
model quality, answerability or whole-system effectiveness. A historical artifact's
hash is not native schema/currentness admission or permission to execute it.

The authored-only executable proof is the `frozen-nomination.test.ts` Vitest
wrapper. Run it once (not additionally as a standalone script), under network
isolation and the ordered verification/measurement locks:

```bash
flock /tmp/alaya-recall-native-bridge.verify.lock \
  flock /home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/source-delivery/representation/recall-measurement.lock \
  unshare -Urn pnpm exec vitest run --project @do-soul/alaya-bench-runner \
  apps/bench-runner/src/__tests__/longmemeval/measurement/frozen-nomination.test.ts
```

Its pre-import guards forbid credentials, transport, model construction and fresh
query/acquisition/index paths. It disposes authored databases and can retain gzip
proof evidence at `ALAYA_AUTHORED_FROZEN_EVIDENCE`. Do not set
`ALAYA_LOCAL_SOURCE_EMBEDDING_OFFLINE=1` as a substitute for these guards.
Natural inputs and closed generation allocations require separate authorization.

## LongMemEval native measurement

The maintained [configuration](src/runs/longmemeval-semantic/contract.ts) binds the
original dataset directory, pinned metadata, SHA-256 and question count, selected
question IDs, model/profile, query cache root, recorded timestamp, producer commit,
native budget and output limits. It never rewrites a dataset or dispatches a
provider. `freeze` retains `query-workset.json` as exact request identity only.
Original question text is unchanged; its date supplies approved fixed context
and the interpretation clock.

```bash
node apps/bench-runner/dist/runs/longmemeval-semantic/launch.js freeze --root ROOT --config CONFIG
node apps/bench-runner/dist/runs/longmemeval-semantic/launch.js prepare --root ROOT
node apps/bench-runner/dist/runs/longmemeval-semantic/launch.js replay --root ROOT --prepared PREPARED_PATH
node apps/bench-runner/dist/runs/longmemeval-semantic/launch.js measure --root ROOT --replay REPLAY_PATH --evaluator-root EVALUATOR_ROOT
```

The source-only development arm accepts 1–50 question IDs. Each question gets its
complete original haystack in an isolated source snapshot, with original
session/round identities and dataset revision. H is absent and C is not attempted;
results use native canonical source-root order. Gold is read only by `measure`,
which joins answer sessions to published source rounds. Abstention uses the dataset
cohort owner even when gold sessions exist, stays uncalibrated, and is excluded from
the primary denominator. Reports retain every inventory row, including unselected
questions, and distinguish development bounds from an unrun formal target.
Completed publication reports recover a missing orchestration receipt; incomplete
publication or exposure fails closed.

The existing `arm: "native_semantic"` config freezes
`longmemeval-native-semantic-v3`. It additionally requires `workspace_prefix`,
`source_cache_roots`, `source_publication_associations`, `correspondence_cache_root`,
`discovery_page_cap`, `correspondence_pair_cap` and `authorized_scopes`. Source
cache manifests/shards are frozen by content, including invalid artifacts.
Preparation uses native publication and retains sources with absent or rejected
interpretations. Changed source-cache inputs require a new freeze. Its combined
correspondence workset records exact bounded request opportunities only; no
producer or spending authority is available here. Replay uses `soul.interpretation`
`recall` in a fresh daemon over the sealed snapshot and the first-exposure recorder.

Use `stage: "formal"` only with every original question ID and an explicit
`previously_exposed_question_ids` list. Partial formal selection is rejected,
including omission of abstention rows. Formal reports decide the strict target
from confirmed-hit/unknown bounds and do not label reused development questions
a holdout. Development is the default and cannot issue a formal target decision.
Per-row diagnostics retain Q/H/C availability, discovery, native work/memory,
payload coverage and measured native call latency when available. Authored fixtures
do not establish model fidelity, semantic benefit, ordinary `soul.recall` parity,
or formal dataset success.
