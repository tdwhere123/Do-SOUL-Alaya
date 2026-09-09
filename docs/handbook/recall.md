# Recall Algorithm

This handbook is the in-repository authority for Recall implementation
(invariant §32). Alaya is a local-first memory plane for CLI agents. Recall
produces a governed information index; delivery does not establish usage or
durable truth.

## Current route and ownership

```text
source / immutable assertions / EventLog
  -> SQLite source and relation projections
  -> native bounded observers, pinned snapshot and mutation generation
  -> RecallService.recall -> executeRecall
     -> runConditionalFieldRecall (direct or conditionalField.recall worker)
     -> compileConditionalFieldQuery -> observeField
     -> projectAcceptingIndex
  -> MCP soul.recall / CLI alaya tools call soul.recall
     -> index plus same-order results encoding
```

`packages/protocol/src/recall/conditional-field/` owns the shared contracts.
`packages/core/src/recall/conditional-field/` owns query interpretation,
observation, derivations, support and index projection. The shared runtime
runner owns request budgets and continuation. Storage owns native persistence
and generation changes; the daemon wires worker snapshots and MCP/CLI.

The conditional field is the single ordinary Recall decision route. Retired
prefix-capture, budget-aware-q, query-proof shadow, Select_Gamma walks,
`runCoarseFilter`, `prepareRecallRequest` selector prepare, family-rank-base
and flood score-as-rank must not be reintroduced as a fallback. Source/history
readers, global-memory lifecycle ports and historical protocol shapes have
independent consumers; retaining those does not authorize running a retired
selector.

Retained mechanisms and their independent consumers:

- `SELECT_GAMMA_OPERATOR_ID` / `packages/protocol/src/recall/field-contract/`:
  historical generation identity and EventLog readers. Its manifest and hash
  remain frozen for those rows. New generation receipts use only the
  conditional source-frontier, governance-frontier and generation operators,
  with `conditional_field_snapshot` as their consumer. The current core
  lifecycle rejects historical manifests before verification or activation.
- `field/retrieval/projection/`: immutable source body validation, deterministic
  source and governance frontiers, generation verification, audit and atomic
  active-pointer changes. The source frontier is versioned separately from the
  retired projection format. New generations contain no SliceKey, L1 posting,
  L2 bundle or attributed-activation artifact. Existing historical rows are not
  rewritten or interpreted as a new ranking execution. Storage validates both
  explicitly known manifests and rejects unknown or tampered rows on reads.
- `EMBEDDING_INJECTION_*` in `embedding-recall/constants.ts`: daemon embedding
  configuration, not ordinary ranking.
- `embedding-recall/evidence/`: source-authorized document backfill, bounded
  document previews and the embedding service's lexical candidate prefix.
- `ObserverReaders.embeddingIds`: an optional bounded measurement extension,
  currently exercised by observer tests. The ordinary daemon reader does not
  bind it, and the field does not turn enumerated vector identities into
  similarity-ranked seeds. A query-conditioned measurement and association
  contract would be required before connecting that retrieval capability.
- `runtime/global-memory/bounded-top-k.ts`: bounded global-memory lifecycle
  source selection. It does not select ordinary conditional-field results.
- `RECALL_FUSION_FAMILY_IDS` / `aggregateFamilyContributions` in the bench
  runner's `diagnostics/stage-attribution/fusion-delivery-families.ts`:
  historical diagnostic reader (`honest-higher-r-obj`), not `executeRecall`.
- `findRecallTierWindow` worker/storage window: snapshot/materialization source
  window, unused by `executeRecall` ranking.
- Historical diagnostic shapes in the bench runner and the protocol
  selection/OSF schemas: bench artifact readers and offline query-cache
  verification. These shapes have no live Recall producer. Keeping an archive
  decoder does not keep its old compiler, scorer or selector operational.
  The bench artifact reader retains historical pool, capture-receipt and
  answer-evidence consistency checks; missing evidence cannot become a complete
  archive merely because all candidate rows are present. Current conditional-field
  measurement uses its own index completeness contract.
- in-process `FIELD_RESUME`: process-local continuation; process loss
  invalidates; not durable.

Retaining these does not authorize running a retired selector.

The retired `flood/`, `coarse-filter/`, `scoring/`, `expansion/`, `rerank/` and
`supplements/` implementation directories are physically absent. The former
daemon field query session and its pinned candidate selector are also absent.
Tests for the retired equations and projection artifacts have been removed;
source integrity, source-frontier identity, actual lifecycle effects and
conditional-field delivery remain tested at their current owners.

## Conditional meaning

The field retains object, hypothesis, program state, binding and temporal
coordinates. Query compilation preserves supported ordinary-language meaning
and exposes interpretation holes. Missing knowledge is not a zero association
or a complete empty universe. Same-service bindings remain distinct from two
services that happen to share a provider.

Association uses `assoc.bottleneck.milligrade.v1`. Under the declared scalar
reference assumptions, compatible serial and AND composition use minimum;
OR alternatives use maximum. Witness dependencies and alternative roots are
retained even when their scores or source sets coincide. Withdrawal reevaluates
accepted dependencies; a score alone cannot reconstruct the derivation.

Same-path labels travel together. Product-specific explanations preserve
bindings and proposition identity. Association support is distinct from a
causal claim: unavailable common-cause evidence stays unknown. A causal claim
requires admitted evidence and current governance.

Source observation time and requested semantic time are separate from storage
creation time and reader lifetime. Missing observation time is not replaced
with `created_at`. An explicit metadata `time_field` filter retains its own
meaning. Immutable assertion validity and resolution history govern temporal
relations; tombstones and revocation cannot be bypassed by continuation.

## Bounded observation and delivery

One request pins its interpretation clock, snapshot and generation. Native
readers advance cursors within their allowances. Grounding, support, projection
and previews share request accounting and retain concrete unfinished work.
Cursor acceptance and retained effects must be atomic.

The public index distinguishes interpretation coverage, observed coverage,
logical-index completeness, transport completeness and payload completeness.
A page or top set does not prove the logical index complete. Narrow pages keep
the accepting products and explanation forest available through continuation;
budget exhaustion must not be reported as a complete empty result.

Continuation is bound to query, snapshot, model/interpretation identity and a
retained reader-process instance. Mutation generation changes invalidate stale
state, including same-timestamp source edits. Reader expiry is a lifetime
failure, independent of semantic `as_of`. Process loss invalidates continuation;
durable cross-process resume is not advertised.

MCP and CLI share the runtime contract. `index` is authoritative. Required
`results` remains a compatibility encoding in the same order, retaining
product coordinates and `output_binding`. Preview delivery and page width
cannot silently discard the index's interpretation or explanation semantics.
Bound source evidence pointers and supplied governance warnings retain their
granularity through the same worker and encoder. Pointers do not create
witness attribution. Hint-only representations omit bodies and pointers.

## Governance and feedback

Ordinary Recall does not enqueue extraction or call a missing embedding
provider. Explicit candidate ingestion and post-turn heuristic extraction
remain separate paths; `soul.report_context_usage` can enqueue post-turn work.

Usage reports preserve their supported granularity. Witness attribution binds
to verified exposure, principal and semantic identity. Full report/exposure
records persist atomically in the existing SQL ledger with bounded audit
commitments. Delivery, inspection and top membership are not evidence of use.

The operational reference does not perform usage-driven reinforcement or
decay. Existing background consumers must not turn unsupported attribution into
semantic strength updates. New learning mechanisms need their own necessity
and evidence; no empirical learning benefit is claimed by this route.

Active constraints are a separate governance response, never a relevance
selector. Their native reads share the request snapshot and work/memory
allowance, respect authorized scopes, and reuse the bounded path observation
for content ceilings. `active_constraints_count` is null if an exact count
cannot be established; `active_constraints_completeness` distinguishes this
from a complete empty result. Unavailable governance restricts previews to
references rather than silently granting full content exposure.

## Compatibility and recovery

The protocol 4.0.0 candidate is an unreleased major semantic cutover under
invariant §25. Explicit legacy selector request keys are rejected. Historical
response `delivery_path` and `ranking_authority` remain deprecated parseable
fields and are omitted on the target path. `recent_turn` remains accepted and
ignored by Recall. Required `results`, `index` and continuation retain their
documented roles. Retired `strategy_mix` is absent from the target payload and
rejected by the strict response schema; ignored inputs do not activate old behavior.

Indexed projection schema 6 prepares schema, relation indexes and embedding
indexes in one transaction. Failure leaves the previous schema and truth
unchanged. Isolated migration fixtures cover revisions 4/5, restart, replay,
mixed revisions and retained-original rollback. Temporal offline preparation
works on copies, preserves immutable source/assertion/EventLog history and
retains explicit quarantine and reconciliation evidence. Current startup
rejects an old or mixed tuple until explicit preparation; it does not silently
bridge schema versions.

## Evidence limits and historical records

The benchmark's `conditional-field-delivered-slots-v1` measurement contract
validates the actual index, ordered result slots, query/clock/snapshot binding,
explicit sent budget and zero Recall provider/Garden counters. It does not
invent legacy diagnostics to make a question scorable. Unusable source states
remain unscorable; partial/open results retain that status. Any@K and full-gold
formulas are unchanged, but structured product slots are explicitly
non-equivalent to the old ranked candidate pool. Duplicate product slots are
not silently deduplicated.

An internal execution receipt captures the actual compiler inputs, query and
interpretation identities, live source snapshot, and original request budget.
The worker transports that receipt through the same result boundary. Measurement
checks the independently supplied request against it and reuses the compiler's
identity rules. Archived measurement admission repeats identity and ordered
product-slot checks. These unsigned local receipts detect inconsistent or stale
bindings; they do not authenticate an artifact whose entire evidence was forged.
Payload omission that leaves fewer compatibility results than index entries is
unscorable, while the response retains its original index and omission status.

Requested work/memory limits are not measured consumption. The measurement
record keeps actual work, memory, independent relationship/explanation truth
and downstream utilization unavailable when the response supplies no such
evidence. Native-fork synthetic pagination verifies the real worker route;
it does not establish replayability of a historical dataset snapshot.

Continuation in the benchmark reuses the active question/source/working-file
identity and skips repeated warmup. Lost or changed process/source state
invalidates continuation before creating a fresh working copy. An old cache's
matching byte seal does not prove current target schemas, interpretation
dependencies or observer compatibility. Incompatible artifacts remain
`NOT_REPLAYABLE` until separately prepared and verified; baseline execution is
a separate action.

The selected index has memory identities. Standalone evidence-capsule Recall
delivery and artifact-kind semantic retrieval are unsupported live arms.
Capsule storage, qualified User/Assistant projections, provenance and evidence
support remain separate supported owners. Ready semantic artifacts remain
observable in storage with source-current publication/restart checks; an
unsupported kind query does not claim those artifacts are absent. Ordinary
memory-source recall continues without optional enrichment or provider work.

Finite max-min oracles establish only their stated finite reference properties.
Real SQLite, worker, MCP/CLI, continuation and attribution tests establish the
specific producer-consumer cases they exercise. Neither set establishes dataset
quality, full process memory usage, general-language understanding, or deployment
latency. Measurement readiness is separate from a successful scored run.

Any@K and full-gold metrics retain their declared definitions. Structured-index
coverage, relationship/explanation correctness and completeness must be reported
separately. Missing or incompatible source/cache/model artifacts are
`NOT_REPLAYABLE`, not measured zeros. No provider/cache fill or dataset execution
is implied by implementing the target.

Earlier RRF/family-max, prefix optimum, query-proof, flood, SliceKey and Gamma
descriptions are preserved in the
[historical handbook](../archive/recall-before-retirement-2026-09-08.md).
Their scores and approval records are historical evidence, not current
implementation guidance or target KPI certification.
