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

## Offline semantic chain

After `pnpm build`, `node apps/bench-runner/dist/runs/semantic-chain/launch.js`
provides `associate`, `prepare`, `bind-lazy`, `qualify-window`, `qualify-final`,
`qualify-replay`, `replay`, `intervene`, and `measure`. These operations make
no provider calls. Query-semantics and semantic-correspondence extraction still uses the existing
`semantic-proposal-fill` preparation, authority, attempt ledger, and interactive
SSE execution; the chain does not dispatch Batch or authorize extraction.
Preparation accepts `--max-attempts-per-key 1` for a single-attempt window; the
default remains two. The [preflight and authority contracts](src/runs/semantic-proposal/authority.ts) bind that per-key limit, total
attempts and price. Fill and recovery consume the same authority, so a failed
first key cannot borrow another key's single opportunity. This does not change
generation/cache identity or authorize reopening a stopped window.
The same authority binds the executable revision and physical execution root.
Preparation only inspects the root; authorization initializes an absent or empty
root and pins its canonical path, device, inode and marker through the existing
extraction root owner. Fill and recovery reject a changed revision or root before
attempt reservation. Reissuing a receipt preserves the attempt lineage and unknown
reservations. Historical caches without this binding remain read-only evidence.

```bash
node apps/bench-runner/dist/runs/semantic-chain/launch.js associate \
  --config population.json --out associations.json
node apps/bench-runner/dist/runs/semantic-chain/launch.js prepare \
  --config chain-config.json --root .do-it/bench-runs/semantic-chain
node apps/bench-runner/dist/runs/semantic-chain/launch.js bind-lazy \
  --root .do-it/bench-runs/semantic-chain --config chain-config.json \
  --population source-container.json --source-preflight complete-source-preflight.json \
  --source-cache-root SOURCE_CACHE_ROOT --recorded-at RECORDED_AT \
  --producer-commit PRODUCER_COMMIT --out lazy-config.json
node apps/bench-runner/dist/runs/semantic-chain/launch.js qualify-window \
  --config lazy-config.json --root .do-it/bench-runs/semantic-lazy
node apps/bench-runner/dist/runs/semantic-chain/launch.js replay \
  --root .do-it/bench-runs/semantic-chain --arm retained
node apps/bench-runner/dist/runs/semantic-chain/launch.js measure \
  --root .do-it/bench-runs/semantic-chain --replay REPLAY_PATH --gold query-gold.json
node apps/bench-runner/dist/runs/semantic-chain/launch.js intervene \
  --root .do-it/bench-runs/semantic-chain --replay REPLAY_PATH --leaf-trials 32
```

The direct lazy binder requires a retained one-query `prepare.json` matching the
exact chain config. `source-container.json` names the complete published source
container with `name`, `dataDir`, `pinnedMetaRoot`, and a one-question
`questionWindow` (`offset`, `limit: 1`). Its question supplies source records;
the prepared chain supplies the query. The binder verifies the sealed snapshot,
complete census, current source preflight and owning cache, and settled query
state. It writes both native query and preflight identities into the lazy config.
The lazy stage rechecks this binding before a window or resumed stage; no provider
authority or call is issued by binding.

Population configuration contains `name`, `dataDir`, `pinnedMetaRoot`,
`model`, `requestProfile`, an optional original `questionWindow`, and a
`cacheOwners` roster of `{ "cacheRoot": "...", "retainedPreparationPath": "..." }` records.
Prepare one original question/window at a time, using the disjoint owning roots
and their original retained Batch or Step source prefill preparations. The v3 preparation report retains
ambiguous, invalid, and unbound artifacts; its `.associations.json` companion
keeps the v2 publication association wrapper and is directly usable by source publication. Use the original retained preparation covering
each root's selected request set, including an earlier complete preparation when
the last fill contains only remaining requests. Associations are new host
publication decisions, not historical source-origin or completion witnesses.
Historical templates incompatible with the current request owner fail closed.

`intervene` verifies the frozen snapshot and retained native proof identities, then
runs a new offline Core compilation. Its bounded source-interpretation and semantic-correspondence withdrawal arms all start
from that execution's same observed state and reuse the normal projection/delivery
owners. It retains the original derivation graph, leaf origins, before/after proof
results and answer differences. This is not the original MCP process's in-memory
state or another first exposure. Missing native proofs remain `not_exercised`;
baseline mismatch and resource failure do not establish a causal effect. The
existing `without_semantic_correspondences` replay remains a separate recompilation control.

For a retained native snapshot and exact chain configuration, the measurement-only
entry preserves the existing prepare/replay/measure arguments and artifact contracts:

```bash
node apps/bench-runner/dist/runs/recall-measurement/launch.js prepare --root ROOT --config CONFIG
node apps/bench-runner/dist/runs/recall-measurement/launch.js replay --root ROOT --arm retained
node apps/bench-runner/dist/runs/recall-measurement/launch.js measure --root ROOT --replay REPLAY_PATH --gold GOLD_PATH --evaluator-root EVALUATOR_ROOT
```

This entry does not import the private semantic-chain/proposal pipelines. Exact
retained request/cache identities are shared read-only owners; no provider fill or
recovery window runs here. With absent Q/C caches, the original question still
uses native source discovery and delivery. Existing lazy/population research
operations have a separate temporary `semantic-chain/longmemeval-launch.js` entry.

For a bounded LongMemEval-S source-only development baseline, use the maintained
entry below. Its [configuration](src/runs/longmemeval-semantic/contract.ts) requires
the original dataset directory, pinned metadata directory, SHA-256 and question
count, 1–50 development question IDs, model/profile, query-semantics cache root, recorded timestamp,
producer commit, native budget and output limits. It never rewrites a dataset or
dispatches a provider. `freeze` emits `query-workset.json` for the separately
authorized existing semantic-proposal fill lane. Original question text is retained;
only its question date supplies approved fixed context and the interpretation clock.

```bash
node apps/bench-runner/dist/runs/longmemeval-semantic/launch.js freeze --root ROOT --config CONFIG
node apps/bench-runner/dist/runs/longmemeval-semantic/launch.js prepare --root ROOT
node apps/bench-runner/dist/runs/longmemeval-semantic/launch.js replay --root ROOT --prepared PREPARED_PATH
node apps/bench-runner/dist/runs/longmemeval-semantic/launch.js measure --root ROOT --replay REPLAY_PATH --evaluator-root EVALUATOR_ROOT
```

Each selected question gets its complete original haystack in an isolated source
snapshot, with original session/round identities and dataset revision. Source interpretation is absent
and semantic correspondence is not attempted; results use native canonical source-root order. Query-semantics failures
remain unknown in the selected answerable denominator. Gold is read only by
`measure`, which maps that question's answer session IDs to published source rounds
and invokes the existing immutable first-exposure measurement. Abstention uses the
dataset cohort owner even when gold sessions exist, stays uncalibrated, and is
excluded from the primary denominator. Reports retain every original inventory row,
including unselected questions, and distinguish development bounds from the unrun
formal target. This source-only baseline does not establish semantic mechanism
benefit or formal 500-question success. Completed publication reports recover a
missing orchestration receipt; incomplete publication or exposure fails closed.

The same launcher also accepts an explicit `arm: "native_semantic"` config,
freezing `longmemeval-native-semantic-v3`. In addition to the source-only config,
it requires `workspace_prefix`, `source_cache_roots`,
`source_publication_associations` (source ID/version, generation key and request
digest), `correspondence_cache_root`, `discovery_page_cap`,
`correspondence_pair_cap` and `authorized_scopes`. Source cache manifests and
shards are frozen by content, including invalid artifacts. Preparation uses the
existing native publication owner and retains every source even when its
interpretation is absent or rejected. Changed source-cache inputs require a new
freeze. The source-only development-v3 arm still rejects published interpretations
and nonempty proof delivery.

Native preparation emits one combined `semantic_correspondence-workset-<identity>.json`
for the existing proposal prepare/authority/fill commands. Each query receives
its declared candidate opportunity independently; the existing durable proposal
authority and attempt ledger own global spending. Generating this workset grants
no provider authority. Replay uses `soul.interpretation` operation `recall`, a
fresh daemon over the closed snapshot, and the existing first-exposure recorder.
The new arm reports the source-bearing union, independently checked proof exercise,
candidate decisions, cache outcomes and evaluator cost. Authored fixture success
does not establish model fidelity, useful query-conditioned ordering, ordinary
`soul.recall` parity or formal dataset success.

Use `stage: "formal"` only with every original dataset question ID and an explicit
`previously_exposed_question_ids` list. A partial formal selection is rejected,
including omission of abstention rows. Formal reports record prior exposure per
question and decide the strict target from confirmed-hit/unknown bounds; they do
not label reused development questions as a holdout. Development remains the
default and cannot issue a formal target decision. Per-row diagnostics retain
query failures, source, source-interpretation, and semantic-correspondence discovery, native work/memory, payload coverage and
measured native call latency when available.

The [chain configuration schema](src/runs/semantic-chain/contract.ts) requires
the frozen snapshot path/digest, current extraction-authority implementation
revision, fixed ISO interpretation clock, workspace/run, exact query workset,
query-semantics and semantic-correspondence cache roots, output cap, discovery page cap, correspondence pair cap, native
request budget, authorized scopes, and output byte limit. The plan treats the pair
cap as a per-query opportunity, retaining selected, zero-budget, missing-interpretation
and unselected decisions separately from global spend. Preparation preserves
every question, blocks non-executable query semantics, and writes a semantic-correspondence workset only
from actual paged native discovery. Unvisited source-interpretation count remains unknown; visited
but unselected source interpretation remains unattempted. Gold is unavailable to preparation.

Stages are immutable and bind snapshot, implementation, query semantics, source interpretation, semantic correspondence, and fixed
context. Resume rebuilds a missing identical semantic-correspondence workset; run the existing
proposal preparation command to inspect current cache state before any paid
fill. A changed input requires a new preparation root or replay identity.
Replay records native first exposure through the existing measurement owner.
Measurement derives mixed, proof-conditioned and source-bearing union metrics from
one admission. Its `evaluator_usage` records fresh proof-verification work and logical
allocation charges separately from native retrieval diagnostics. External stored
measurements require fresh readmission with independent publication records;
historical records without evaluator cost retain that absence.
Current measurements retain native discovery and coverage. Unvisited or unfinished
native work keeps a negative primary outcome unknown, while observed valid hits
remain hits. The pure delivered-slot union remains a diagnostic. Frozen later pages
alone do not prevent an initial-page miss when the candidate pool is complete.
An interrupted exposure reservation without a result fails closed and retains
its working database for diagnosis; it is not automatically replayable.

Gold input is an array of `{ "query_key": "...", "source_units": [...] }`,
with exactly one row for every prepared question, including blocked questions.
Missing gold is not an empty gold set. `--arm without_semantic_correspondences` executes a
separate native control with the same snapshot, query semantics, clock, budget, and scopes;
it is not a fixed compiled-context leaf intervention. Successful authored
fixtures do not establish actual-model extraction quality or full campaign
closure, stale-lease, erasure, or all control-arm coverage.
