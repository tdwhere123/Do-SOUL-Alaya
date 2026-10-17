# Recall Algorithm

This handbook is the in-repository authority for Recall implementation
(invariant §32). Alaya is a local-first memory plane for CLI agents. Recall
produces a governed information index; delivery does not establish usage or
durable truth.

## Fallible interpretation and task use

Recall operates with potentially incomplete or mistaken interpretations.
Q/H production is not assumed faithful merely because a response is valid or
admitted. Original question/context and authorized source records retain their
own identities; a compiled interpretation does not replace either.

The goal of the conditional field is useful task support: organizing related
evidence, computing qualified consequences, exposing represented unresolved
conditions and preserving dependencies for revision. A missing proof is not
proof that its source is useless. Conditions remain strict for the conclusions
that claim them; uncertainty does not waive source permissions, currentness,
erasure, protocol integrity or dependency validation.

| Boundary | Implemented meaning | Limit |
| --- | --- | --- |
| Source access | Open-library raw source membership does not require H/C proof; source-only delivery is supported | Shared work/page limits may still leave useful evidence unread or undelivered |
| Interpretation | Q/H may carry located gaps; published interpretations remain unreviewed | A gap list or complete computation cannot certify that no meaning was silently omitted |
| Conditional computation | Selected admitted Q/H/C premises determine legal bindings and dependency-bearing results | Formal validity does not establish premise fidelity, world truth or every possible interpretation |
| Observation feedback | Attention can identify some represented unresolved conditions; an explicit Node source-feedback session can turn a native accepted source-bound closure into a fresh `prepare_query` access hint | Attention is not a complete task frontier; default Recall does not loop this session; a frozen continuation does not perform new discovery |
| Revision | Owned invalidation and dependency reevaluation preserve their specific lifecycle contracts | Detecting a semantic error, choosing a replacement and autonomous whole-task recovery are separate concerns |

An uncertain cross-source connection can be useful as an exploration hypothesis
or an explicitly conditional premise where the selected contract supports it.
Search usefulness does not establish equality. Current open correspondence is
local to one Q/H pair; it is not a general cross-H join or a schema for every
possible identity hypothesis. Unsupported joint semantics must stay explicit.

The task loop should retain opportunities to reconsider original task/source
context independently of current Q/H and Field feedback. This is a design and
evaluation requirement, not a claim of automatic omission repair or guaranteed
nondegradation under a fixed budget. The caller's use, further observation and
cost must be observed to establish whole-chain utility. Raw delivery alone does
not establish a Field gain; producer failure alone does not establish task failure.

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

Consumer compatibility is negotiated on the request before compile or execute.
Mixed and source_only views require `protocol_version` and source-evidence
support (`supported_result_kinds` or `supports_source_evidence`). The explicit
legacy view is `result_kind_view=memory_only`. Do not omit source members to
keep an older parser green; return a compatibility error instead. Worker
`conditionalField.recall` uses the same consumer check and a versioned RPC
envelope; a bare information index is not a legal worker result.

`packages/protocol/src/recall/conditional-field/` owns the shared contracts.
`packages/core/src/recall/conditional-field/` owns query interpretation,
observation, derivations, support and index projection. The shared runtime
runner owns request budgets and continuation. Storage owns native persistence
and generation changes; the daemon wires worker snapshots and MCP/CLI.

Readiness labels for new claims: `schema_only` (types only), `implementation_wired`
(startup plus fixture tests), `live_event_proven` (real workspace / attach /
bench E2E), `agent_used` (host agent invoked the surface with EventLog).
Official 100Q / 500Q promotion is not claimed.

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
- `ObserverReaders.embeddingIds` and `measureStoredPair`: ordinary worker
  readers for already stored query/object vectors. Enumeration is discovery;
  semantic admission additionally requires current source provenance, query
  guards and an explicit prepared measurement declaration described below.
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

The field retains a tagged target (memory entry or native source evidence),
hypothesis, program state, binding and temporal coordinates. A source-record-only
product uses root/revision/digest identity and must not mint a memory or capsule
id. Query compilation preserves admitted meaning and exposes declared
interpretation holes; it does not certify the interpretation against all
ordinary-language meaning in the original task. Missing knowledge is not a zero association
or a complete empty universe. Same-service bindings remain distinct from two
services that happen to share a provider. Canonical identity order is the
default enumeration; associative order is an explicit query-view policy over
the same legal membership. Source records and retained capsule text have
bounded discovery and UTF-8 payload readers through the ordinary worker route.
Record-only roots remain deliverable after optional memory formation fails.

Optional fact-frame formation rejects unquoted trailing dependent scope such as
`if`, `unless`, and `only`; an opaque value containing the condition does not
establish its meaning. Explicit proposals, automatic normalization, historical
frame replay, Core certification and current Storage qualification share the
complete source-frame contract in Protocol's Node-only `node/source-frame`
entry. This grammar requires recognized leading qualifiers and modality,
and coverage of every source token from the independently located predicate;
submitted slots cannot choose their own subject or predicate anchor. Explicit
subjects are bounded to recognized pronouns, `the user`, or a single capitalized
name at source start. Multiword named subjects and CJK subject grammar remain
unsupported; existing CJK tokenization is unchanged. Existing auxiliary
normalization and explicit source-head copulas remain supported. Core owns admission and effects. Its public
normalizer export serves daemon configuration and benchmark replay/backfill
consumers by exporting the same Protocol implementation. The Protocol browser
root's receipt verifier proves historical frame-to-graph binding only; current
source qualification must also use the source-frame contract. Native CJK
segmentation is owned by `@do-soul/alaya-cjk-segmentation` and stays outside the
browser root and the protocol install graph.

A source-qualified frame independently compiles its canonical graph through
Protocol's Node source-frame owner. Missing, rejected or incompatible model
graph nominations cannot veto that compilation or supply its identities.
Completeness receipts from operator v3 retain the complete upstream nomination
capture, including rejection, and bind it to the same source. Historical v2
receipt shapes and digests remain readable. This does not broaden the supported
source grammar or bypass source grounding, admission or current qualification.

Object-key minting and retrofit read derived fact keys and OSF graphs through
the same current stored-formation qualification owners. Fact-key contents must
also match their canonical projections. Unqualified historical derivatives do
not supply these inputs; gist, original source text, and ordinary memory remain
independently readable.

Source assertion fragments require demonstrated bounded independence;
mechanical coordination or a sentence-ending period is insufficient. Adjacent
dependent continuations retain their matrix context across whitespace, stopping
at explicit source-role boundaries. Unresolved references remain unsupported.
Source text still persists when the
optional frame, OSF certificate or F3 incidence cannot form.

Current extraction uses assertion-catalog locator version 3 and fact-frame
normalizer version 4. Historical locator version 2 receipts and prompt bytes
remain readable as historical data; current source qualification and extraction
do not reinterpret their catalog ids. New requests, prompt identities and
derived cache commitments bind the current catalog contract.
Extraction generations select `reference-eight` or `singleton` source packing
through the shared request owner. Manifest v4 requires `source_packing`;
historical v3 remains reference-eight and retains its original signed shape.
Bench `--extraction-source-packing` (or `ALAYA_BENCH_EXTRACTION_SOURCE_PACKING`)
must agree with an existing manifest. Omission restores that generation's
policy. The full catalog, assertion ids and total batch count precede selection;
physical packing does not change the semantic request template.

An extraction authority v5 `sample` action binds a distinct, nonempty, missing
native request set from the complete first-100 inventory. Its limits preserve
the full starting-missing denominator and derive attempts and successes from
the selected count. Only one exact Batch job is permitted, with durable
submission intent before reservation. Unknown submission and prior submitted
jobs block redispatch; sync, repair and continuation cannot reuse this scope.
Sample settlement remains partial and cannot promote the cache or snapshot.

Batch poll count and deadline bound ordinary `status`/`resume` observation;
they do not establish remote termination or release reserved spend. Explicit
`recover`, with both exact local and acknowledged remote job identities, makes
at most one timeout-bounded status request even after those bounds. It retains
the original plan, wire bytes, submission time, attempts and cumulative poll
count, and never submits, cancels or imports. A repaired observer may verify
the original receipt revision for this operation alone; request/plan, source,
authority and remote binding checks still apply. Import and semantic admission
remain subject to their original execution revision and authority.

Historical capture and certificate bytes remain intact, while current qualified
OSF and fact-key reads reject incomplete source obligations, including the
pre-capture Signal fallback. Raw field factor rows participate in immutable
frontier identity; the current conditional-field runtime does not consume them
as semantic readiness or truth. Retained source-root reads remain available.

Mandatory original-source imports use Core `createAuditedSourceAdmission`,
which composes existing source identity/span validation inside the formation
store transaction and then appends the receipt-first source audit. A failed
audit can leave a committed identity; retry repeats audit without reviving a
tombstone. Daemon workspace bindings and projection checkpoints remain the
applicable effect owners. Bench exposes this through its
[source snapshot operations](../../apps/bench-runner/README.md#original-source-snapshots),
separate from post-extraction artifacts. A known zero-byte source has an
`[empty source]` display preview; raw bodies, span identities and source evidence
remain unchanged, and missing payload stays distinct.

Bench can admit a retained SQLite source population through
`admitRetainedNativeSourceSnapshot`. It copies an explicitly digest-bound,
quiescent original into a fresh output under the snapshot publication lock;
only the copy is opened as SQLite. The version 2 native manifest derives each
complete current workspace record and original body from that copy, preserving
nullable event time, recorded time, speaker, validity, project scope and explicit
utterance attribution. Missing attribution is unavailable; explicit `unknown`
remains valid. Original path/digest provenance is distinct from the sealer's
candidate and publication run. Failed admission leaves an unsealed output.
Version 2 requires a known `user` or `assistant` speaker; absent/null and system
speakers are unavailable for this source-semantic route. Its known author is
forwarded through the shared SOUL unit, request and transport-identity owners;
literal role markers quoted in the body cannot override that author. Source
bytes, assertion segmentation and catalog text remain unchanged.
Version 1 construction and request identities remain supported. Census, source
request preparation, retained-response association and audited publication carry
the same attribution; publication verification compares the full source record.
This admission prepares source evidence for the existing extraction authority;
it does not authorize a provider attempt or establish interpretation quality.

Retained source bodies remain authoritative. Write transactions maintain a
derived projection of UTF-8-aligned chunks of at most 4 KiB, with a digest bound
to root kind, workspace, revision, original digest and offset. Migration builds
this projection for existing retained roots transactionally. Recall never
backfills it: absent, corrupt or stale chunks produce an unavailable read.
The native byte allowance pays for each physical chunk and metadata, including
when only a few excerpt bytes are returned. Verified record-to-capsule aliases
come from canonical evidence references and current workspace/lifecycle checks.

Association uses `assoc.bottleneck.milligrade.v1`. Under the declared scalar
reference assumptions, compatible serial and AND composition use minimum;
OR alternatives use maximum. Witness dependencies and alternative roots are
retained even when their scores or source sets coincide. Withdrawal reevaluates
accepted dependencies; a score alone cannot reconstruct the derivation.

Numeric preparation, adjacency and work queues retain immutable state across
pages. One relaxation unit handles at most one outgoing edge. New seeds and
rules enter through bounded preparation; a disjoint addition reuses the solved
graph. Reachable grade zero remains distinct from an absent activation.
Path cursors retain immutable input versions; their owners replace versions
instead of mutating arrays or maps held by an interrupted cursor. Native
relation-page exhaustion does not establish semantic closure: newly admitted
product states and facets must still consume the retained relation evidence.
Path-effect admission retains metered facet lookup and demand preparation across
small continuations. A prepared batch commits its effects and demand maps
together only after its work and retained bytes fit.
Conditional-field adjacency reads are demanded by reachable program advances,
hyperedge premises, routing discovery and bound claim evidence. A bound guard
may require a direct authorized source-fact read before its retained relation
can be decided. The physical pair cursor retains completion for each demanded
subject and relation kind. Its exhaustion means only that these consumer-relative
keys completed for this query and snapshot; it does not certify all possible
relations or completeness of the original source language. New identities,
facets, discoveries and facts re-run the affected demand producers. A resolved
guard is replaced only after a complete reevaluation; independent unknown
guards remain open. A continuation keeps completed keys only within the same
query, interpretation, scope and semantic population.
Bound source-fact demands retain a metered scan cursor and pending count. A
resource-limited read stays pending for continuation; completed absence or
unavailability settles that demand. A source reader's memory refusal remains
resource-limited even when the native read was never invoked. The scan, snapshot
pin and possible one-row read consume work before the demand can be marked done.

Dependency equations retain independent rule instances and shared compatible
alternatives. Generated derivations declare `provenance_layout: local_leaves.v1`:
leaf nodes own local provenance and ancestors reference children. Consumers
trace the retained forest; ancestor summary arrays do not establish evidence.
Witness traversal is resumable and rejects missing nodes or cycles. Materialized
explanations consume their own remaining allowance, so a founded product does
not require every proof path to be expanded before delivery.
Temporary explanation omission does not change a product's semantic delivery
revision. Interrupted proof work retains its own progress and shares the
remaining allowance with projection and payload delivery.
When a later payload page materializes that forest, its proof update identifies
the full prior product, semantic revision and new explanation root. It adds
witness exposure receipts without repeating object or source-span exposure.
An unknown observation region retains its uncertainty while other open regions
continue consuming their independently authorized work.
Projection charges retained candidate and facet visits through the request
cost ledger and resumes interrupted facet scans. Native, relaxation and
projection counters describe their instrumented operations; they do not
establish a bound on every process allocation or operating-system cost.
The request charge records newly admitted logical allocations even if a later
phase releases preparation; retained bytes report the full surviving field and
projection footprint separately from the request's available allowance. Payload
delivery charges new previews and metadata once, while cached previews carry
their retained level without a new charge.

Admitted immutable hard relation instances transfer at identity (1000).
Relation names do not assign grades. Associative enumeration requires a
declared common cap contract (`cap_contracts`); absence is incompatibility,
not a shared default.
A compiled causal demand with `required_claim: "supported"` is a membership
obligation: unknown common-cause products are not members. Prepared cosine
admission is opt-in via
`interpretation_proposal.stored_cosine_admission`, using registry
`stored.cosine.admission.v1`. Each named obligation pins producer
`stored.cosine.pair.v1`, provider, model, schema, dimensions, domain
`cosine.unit.v1`, normalization `l2.dot.v1`, and a raw threshold. The object
vector must match the current memory content hash; the query vector must match
the original-query digest in the same profile. The raw threshold is checked
before policy transfer `policy.cosine.linear.milligrade.v1` version `1` maps
cosine `c` to `floor(500 * (clamp(c, -1, 1) + 1))`. This is a declared policy,
not a probability or an empirical calibration. The declaration combines named
obligations with explicit `any` (maximum) or `all` (minimum); missing required
measurements cannot satisfy `all`. Without a declaration, ordinary Recall does
not schedule stored measurements or introduce binding obligations merely
because readers exist. The explicit raw-measurement primitive retains an
inapplicable cap without a declaration and cannot create semantic seeds.
Observation pages report their actual region; query planning owns the required
regions. A declared measurement with a missing producer or input remains unknown.
Recall performs no embedding generation or provider calls.

A query interpretation proposal is a candidate, not Core authority.
`ProposedGuard` has no `verdict`; Core admission maps adopted guards to
`unresolved` and re-evaluates authorization, equality, source-bound entity,
binding, and time from current state. Programs and conditions are admitted
only from the server-owned `QueryProposalProducerRegistry`. Unknown producer
identity or grammar/capability mismatch is `unsupported` and does not execute
or replace an epsilon program. Cosine admission stays on its own registry on
the same proposal object. Transport inspects proposal JSON iteratively before
recursive program decode (depth 32, 4096 AST nodes, 1024 guards/predicates,
256 hypotheses). Semantic admission uses the tightest of server, producer, and
declared AST limits and hashes those effective limits into `query_id`.

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

Source sketches are partial query interpretations. Unsupported source revisions
and unresolved alternatives remain explicit holes with bounded recoverable text
in query identity. A hint is a discovery proposal, never proof of relevance.
Core matches the predicate and required roles conjunctively inside one candidate
and source context. Storage performs bounded physical candidate scans before
Core applies the context-visit cap; every scanned row and fetched byte is charged.
Proposal pages seek the existing `(workspace_id, created_at, object_id)` index
with a tuple cursor; the terminating empty probe also consumes native work.
The text comparison lane hydrates current source bytes before matching phrases,
using the same temporal, retained-chunk integrity, scope and UTF-8 boundaries as
exhaustive lookup. Logical prefix size and physical chunk reads are separate.

Hint work reserves native hydration before consuming a matching identity.
Insufficient reserve retains that identity for continuation. Hint, exhaustive
source and memory lanes rotate with a persisted cursor under narrow budgets and
share normal field deduplication; an unavailable hint does not complete source
membership. Optional `source_lookup_reasons` binds each public proposal reason
to its exact source target, candidate and context. Protocol owns its schema;
retention and MCP/CLI encoding account for its bytes and may omit diagnostics
under resource limits. Reasons do not alter association grades or legal exposure.
Worker restart invalidates old continuations; interrupted payload expansion
remains incomplete and repeated delivery uses the existing retry contract.

The additive diagnostic fields are a Protocol minor change under invariant §25.
Fixed-corpus local canaries measure scans, hydrated contexts, native bytes,
retained memory and legal exposure separately. They establish mechanism behavior;
semantic usefulness and the R02 quality gate remain unaccepted.

Public source-consumption evidence uses `public-source-consumption-v2` and the
`published-hint-utility-v2` evaluator. It retains request proposals, public
lookup reasons, target identities, and receipt identities. An improvement can
satisfy this evaluator only when the intended source has a published
candidate/context witness at or before its first complete read. Missing or
omitted reasons remain unobserved; legacy traces without these fields remain
unavailable. The original paired visit metric is reported separately. Alongside
the frozen 72 cells, 24 companion cells omit only the query interpretation
proposal from the same published population. Acceptance requires complete
companion coverage and at least one witnessed pair that uses fewer visits than
both source-text and no-hint controls. Missing controls cannot pass. The measured
benefit is limited to this fixture intervention; semantic fidelity and consumer
agent usage remain unproved. Historical v1 reports are not
reinterpreted or rewritten. The admitted matrix publishes through Core source
observation publication, retains its returned UTF-8 bound interpretations, then
reopens SQLite through the public worker. Witness comparison preserves the
publication's exact assertion span and source alias. Direct gist fixtures prove
only their explicitly scoped matcher mechanisms. Query matching, request
admission and public wire contracts remain unchanged.

One request pins its interpretation clock, snapshot and generation. Native
readers advance cursors within their allowances. Grounding, support, projection
and previews share request accounting and retain concrete unfinished work.
Cursor acceptance and retained effects must be atomic.

Possible and guaranteed field bands alternate charged preparation or relaxation
steps, retaining their next-band cursor across continuation. An idle band yields
to the other. Contract-separated numeric nodes prevent propagation between
incompatible grade domains; newly admitted rows extend retained preparation.
Guaranteed products may become known before possible-band discovery reaches them.
An unfinished possible solve retains an unknown upper bound, never its current
growing iterate as a certified upper bound. Both bands' values and completion
states invalidate dependent projections and support assessments. This scheduling
does not waive ordering, delivery, memory or completeness requirements.

Reachable products under incomparable cap contracts retain an `incomparable`
activation with `cap_contract_conflict`, without a scalar or low/high pair.
A required binding residual prevents a complete-empty result. Withdrawal or
compatible reconstruction can resolve that state; absent measurement is not
evidence of no path. Prepared solver growth reserves a conservative accounted
representation bound before each growing atom. This measures retained
representation, not JavaScript RSS. A memory-blocked band leaves its cursor
unchanged while the other may advance. Existing continuation roots can retain
prior allocations, so same-epoch reconstruction does not refund that charge;
a new epoch starts a new owner. Deferred input remains bounded, and replacing
one band's deferred preparation preserves source rows and the other band.

The public index distinguishes interpretation coverage, observed coverage,
logical-index completeness, transport completeness and payload completeness.
Logical-index completeness is a coverage certificate that remaining
counterfactual influence is none. Observer `exhausted` is an execution fact
and does not by itself prove that certificate. Memory-path exhaustion does
not make source-only results irrelevant. A page or top set does not prove
the logical index complete. Each page shares one envelope allowance across membership entries and typed
product updates. Only delivered component revisions advance the retained ledger;
pending components and retractions remain resumable. Narrow pages keep the
accepting products and explanation forest available through continuation; budget exhaustion must
not be reported as a complete empty result.

Continuation is bound to query, snapshot, model/interpretation identity and a
retained reader-process instance. Mutation generation changes invalidate stale
state, including same-timestamp source edits. Reader expiry is a lifetime
failure, independent of semantic `as_of`. Process loss invalidates continuation;
durable cross-process resume is not advertised.

Long binding recovery belongs to the retained field. Its immutable snapshots
share unchanged storage; preparation extends a private fork and charges retained
strings against the field memory budget. Missing recovery state fails closed.
No process-global binding recovery table outlives the execution owner.

Prepared pages advance retained field state only after delivery acknowledgment
validates the current snapshot. The acknowledged page is immutable and
replayable; the daemon persists its delivery receipt under a snapshot-generation
check in the same transaction. Failed persistence can retry the same page and
delivery identity. Bounded worker affinity routes continuation back to the
owning process. Payload expansion
requires an issued continuation and a source root already delivered in that
query epoch. Its offset, end and byte cap are part of retry identity. Partial
or omitted payload keeps the member delivered once while later payload work
uses its own progress. Source pages retain an authorized payload continuation
after membership ends so public response clipping cannot strand unread bytes.

Observe authorization is a tri-state principal, not a default scope.
Chat, analyze, and govern set `scope_filter: null`, which the runner maps to
`authorized_scopes: null` (key present): the unrestricted local-daemon
principal, which admits every `scope_class`. Omitting the worker or CLI key is
a forgotten payload and fail-closes (invalid index / no admission).
`authorized_scopes: []` is an empty authorized set and admits none. A nonempty
array keeps the named includes check. One-sided continuation omit still
mismatches. Do not invent a workspace or project default.

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
fields and are omitted on the target path. Live ranking ignores
`ranking_authority`; do not delete it in 0.3.x. Removal waits for a protocol
major after the compatibility ledger expires so old parsers keep working. `recent_turn` remains accepted and
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

A validated miss without causal evidence remains scorable and is counted as
`conditional_field_unattributed`. Stage tables and exposure comparisons preserve
that unknown cause; they cannot infer early absence or write loss from missing
legacy pool ranks. Such comparisons remain inconclusive.

Membership continuation retains the first memory interruption so an unconsumed
cursor can resume with a larger budget. A repeated interruption at the same
effective budget may close an empty page only when all retained phase progress
is unchanged. The result remains open and partial; consumed-token replay retains
its original result. Attempted work is not retained progress. Late seed subjects
reopen adjacency for new pairs, and guard closure waits for those dependencies.

An internal execution receipt captures the actual compiler inputs, query and
interpretation identities, live source snapshot, and original request budget.
The worker transports that receipt through the same result boundary. Measurement
checks the independently supplied request against it and reuses the compiler's
identity rules. Archived measurement admission repeats identity and ordered
product-slot checks. The bench Recall handle freezes initial membership and
scoring slots under session, delivery, query, snapshot, and interpretation
identity. Later membership, update, payload, and retry pages retain those first-K
inputs while recording their current results and cost separately. A continuation
or archive without initial-exposure evidence is unscorable; it cannot start a
new first-K measurement. These unsigned local receipts detect inconsistent or stale
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

The selected index carries typed memory and source-evidence identities.
Retained source-record and evidence-capsule roots can be delivered without a
memory entry. Source usage revalidates the current root version, retained
content digest, active capsule alias and UTF-8 span through the same bounded
root reader used by Recall. Artifact-kind semantic retrieval remains an
unsupported live arm. Qualified User/Assistant projections, provenance and
evidence support retain their separate owners. Ready semantic artifacts remain
observable in storage with source-current publication/restart checks; an
unsupported kind query does not claim those artifacts are absent. Ordinary
memory-source recall continues without optional enrichment or provider work.

The finite max/min result assumes legal admitted premises; it does not prove
that a natural-language event predicate or model identity is correct. Source
retention, single-frame graph conformance, source-wide semantic coverage and
query-relative index completeness are separate claims. Unsupported enrichment
holds its dependent mode, while independent ready source modes remain usable.
The shared failed-deployment producer recognizes only complete unquoted event
records in its bounded grammar; conditional, reported, multi-sentence, partial
or excerpt-only sources remain unresolved for that predicate. Exact retained
literal retrieval does not require this event interpretation. This producer's
whole-record limit is not an algorithm requirement for global unique parsing.
Packed source-filter time bounds are inclusive; typed event-time and relation
intervals remain half-open, and event time never substitutes for creation time.

Garden `temporal_projection` version 1 and the corresponding MemoryEntry fields
retain inclusive endpoints, matching Graph `TemporalWindow`: a year ends on
December 31 at `23:59:59.999Z`. They do not adapt to typed source event-time or
relation intervals. The Soul temporal draft schema owns generation and parsing;
Protocol owns the shared precision/provenance enums. Historical final-day
date-only nominations may normalize to that day's final millisecond, but an
exclusive next-period endpoint is not reinterpreted as v1. Historical raw bytes
and stored v1 windows are not rewritten.

Soul's source-time owner binds discovered dates to their local roles before
official, replay, or local heuristic event projection. Absolute years 1000–9999
require a temporal preposition and a closed numeral, or an explicit Chinese
calendar-year context; bare identifiers, amounts, quantities, partial dates,
alternative years, and unresolved before/after bounds do not establish an event
window. Supported closed `to` and `through` ranges retain both endpoints as one
candidate, including in local heuristics. Unresolved `until` or explicitly excluded
endpoints remain unavailable. Validity requires a construction directly governing
the date; a descriptive adjective elsewhere cannot supply that role. Local role
context retains the construction between two dates in the same clause. Before
calendar acceptance, source inventory preserves arguments introduced by temporal
prepositions through their clause or connector boundary, including unknown words
and unsupported date formats. A choice or range between those arguments remains
unresolved with unparsed intervening text: punctuation or conjunctions inside it
do not prove independence. This bounded owner also abstains across sentences when
it cannot establish that a preceding temporal choice is independent of a later date.
Unlinked statements and ordinary object alternatives retain their date eligibility.
Raw range dependence requires a governing `from`/validity opening; otherwise the
existing calendar owner must establish the endpoints. A bare `to` does not turn
a purpose or object into a temporal endpoint. An explicit occurrence year can
remain supported without interpreting such an unmarked suffix as a range; this
does not claim complete temporal understanding of that suffix.
Recognized but rejected date fragments also retain their complete lexical extent.
This bounded argument discovery does not extend the accepted calendar grammar or
create local heuristic candidates for unknown words. An alternative or range cannot
become certain by dropping its unresolved branch.
Local heuristics qualify the complete source before using shared sentence spans
for excerpts; presentation boundaries cannot recreate a rejected time window.
Relative terms obey the same complete lexical-unit check as explicit dates.
Attached ASCII/curly apostrophe `s` suffixes, ASCII identifier characters,
ASCII hyphen/Unicode hyphen/nonbreaking-hyphen/en-dash/em-dash compounds and the
Chinese marker `的` remain unresolved rather than establishing an event window.
The existing range owner qualifies complete calendar units atomically, including
mixed relative/absolute endpoints: a rejected endpoint cannot leave one day
as the range's surviving interpretation. This bounded delimiter check
does not recognize every possible lexical attachment. It checks
modifier eligibility, not general rhetoric or part-of-speech semantics. Existing
standalone calendar adjuncts remain supported; an independent `yesterday` does
not inherit an attached `today's` modifier's date. Outer quotation alone does
not invalidate an otherwise supported adjunct. Rejected terms remain in the
dependency inventory, and relative windows still require the trusted source clock.
A nomination that omits a source-established closed validity end remains rejected in the audit,
even when the independent source owner can preserve the complete range. Missing
source clocks leave relative dates unresolved; live and replay preserve a supplied
fixed offset for every civil-time consumer, including time-concern proposals.
Absolute calendar years use UTC and need no clock.
Source observation publication derives temporal fields through the existing Soul
projection owner using the verified assertion and retained source `event_time`.
Ingestion or provider timestamps cannot replace a missing source clock.
Its bound target preserves the current source record's evidence alias, including
`null`; the new interpretation capsule is provenance in memory evidence refs,
not a replacement source alias. Both complete and interrupted publication
recovery verify the stored interpretation against the current expected binding.
Legacy interpretations with an invented capsule alias are rejected unchanged;
they require a separately authorized rebuild, not automatic identity promotion.
Generation response-schema JSON participates in raw cache identity; current
parser, grounding and formation identities separate newly derived artifacts
from historical raw or previously qualified generations.

Finite max-min oracles establish only their stated finite reference properties.
The opt-in `source-interpretation-reasoning-v1` worker capability accepts one
published `source-interpretation-v2` packet and one explicit hypothesis. Core
publishes it through audited EvidenceService creation; it never creates fake
memory entries, governed relation assertions, or inferred temporal validity.
The existing typed query, observation, sequence/hyperedge composition, max/min,
and index projection operate on source endpoints with a separate local node
coordinate. Physical source identity remains unchanged.

A caller-provided, content-bound semantic profile owns predicate/role symbols
and each predicate's mandatory `governing_roles`. All scope-operator operands
govern their descendants. Only governing edges prohibit independent asserted
roots and scope cycles; ordinary references may connect co-roots or form cycles.
Mention selections locate evidence, not entities: local referent grouping and
semantic predicates remain unreviewed proposals. Typed queries consume the same
profile; unknown symbols fail admission. There is no automatic natural-language
query compiler or general ontology in this capability.

New packet mentions select inclusive host-generated first/last segment IDs from
`ascii-run-unicode-scalar-v1`, bound to the source digest and selected assertion
catalog. ASCII letters, digits and underscores form runs; every other Unicode
scalar, including whitespace, is a separate segment. The catalog is lossless and
does not normalize source text or split surrogate pairs. ASCII run-internal spans
are explicitly unsupported. Missing, reversed, cross-assertion and foreign
catalog references fail whole-packet admission. The host derives quotation text
and UTF-16 spans; Core's existing owner converts durable spans to UTF-8. An
implicit predicate is still a semantic proposal, never a fabricated quotation.
The previous in-progress packet text/occurrence wire is superseded; historical
interpretation-v1 retains its strict original selector and ambiguity policy.
Catalog preparation is capped at 128 assertions, 65,536 UTF-16 code units and
32,768 segments, with a 1 MB new-request envelope limit. The catalog schema
checks these aggregate bounds before copying nested input. This is an admission
ceiling, not a promise that every legal catalog and graph fits a request budget.
The Protocol segment
owner estimates temporary catalog/index workspace before worker reconstruction;
insufficient request memory fails without a proof. This is conservative logical
budget accounting, not a measurement of JavaScript process RSS. Temporary
workspace reservation is released after verification and is not native read
bytes; scanned source code units and segment work remain charged.

The result includes the complete published interpretation and the actual proof
leaves, with mandatory source/hypothesis/unreviewed/world-unknown qualifiers.
`computation_status` describes finite selected-hypothesis closure; semantic
coverage can remain unresolved even when that computation completes. A finite
selected packet may also complete with no accepted entries: the index owner
validates every retained seed, state and transition against that packet's node,
source and hypothesis domain before closing it. Resource exhaustion, pending
projection and open observation still prevent closure. Default hypothesis
queries retain their open logical-index meaning; selected-packet closure does
not establish a global absence or verified interpretation. The normal
MemorySearchResult mapper refuses these entries. Output limits remove the
conclusions and interpretation together, never their qualifiers alone. Native
reads, indexed premise preparation, engine work, and projection work are reported
separately; unused finalization reserve is not consumed work. Capsule creation's
existing character limit remains authoritative, while reading uses the request's
byte budget rather than the historical hint byte cap.

The new ordinary `extractSourcePacket` capability and Batch packet adapter share
request-v3 construction, profile/schema generation, and whole-packet reception.
They are explicit opt-ins; historical request-v2/interpretation-v1 and default
Garden ingestion remain unchanged. Packet reception rejects raw UTF-8 responses
above 1 MiB before JSON parsing; failure is never converted to `packet:null`.
The governed Batch fill CLI opts in with `--extraction-packet-profile`. The full
profile content binds request, schema, cache generation and authority identity.
`--extraction-preflight-out` with `--extraction-preflight-keys` produces a local
read-only request preview within the original dataset scope, without a grant.
A genuinely empty eligible source catalog produces a typed deterministic-empty
artifact and uses the existing zero-attempt ledger completion. Provider-backed
`packet:null` remains a separate, receipt-bearing empty response.
Typed cache artifacts remain source-unbound until a caller supplies an admitted
source ID to `publishCachedSourcePacket`; Core checks the exact current source.
The cache retains a shared Batch plan reference instead of copying the plan.
Durable reads verify the retained input/output/attempt and decoded line receipt,
including the exact transport route in the retained original authority receipt;
raw ledger readers accept this checked artifact, while parsed signal readers
reject it. Workset preparation checks the actual source/request JSON size plus
worst-case bounded response escaping against the existing 32 MiB shard reader
limit before reservation. The writer also checks exact serialized bytes.
Cache admission and audited publication enforce their own contracts. Semantic
fidelity is a separate quality claim, not a universal prerequisite for raw-source
use or explicitly unreviewed conditional computation. This is an additive qualified result
capability, not a redefinition of an existing guaranteed world result or MCP
tool. A new public MCP surface would require the separate invariant 25 review.
On read, bounded source verification checks exact assertion and mention spans,
the current root and source eligibility. Source erasure discovers both published
packet-v2 and bound interpretation-v1 dependencies through their Protocol
contract and scrubs their capsules in the existing erase transaction. Derived
interpretation capsules are dependencies, never fabricated source aliases.

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


## Source disclosure

Permitted reads of retained originals carry a required `source_disclosure`
qualification. It identifies original body versus retained excerpt, gist or
interpretation, the exact read evaluation clock, the admitted source interval
when checked, and the interval's relation to that clock. A bounded end is
exclusive; a future start is `before_start`, not expired. A null or unavailable
interval remains explicitly unknown. The comparison uses the full UTC precision
of stored timestamps. Ordinary Recall uses its pinned interpretation clock;
frozen library pages keep the first request's clock while their separate lifetime
lease expires.

`source_only` says `not_current_proof`; an actually delivered conditional proof
says `conditional_support` and remains an unreviewed interpretation with an
unknown world claim. The qualification does not change source eligibility, proof
admission, ranking, erasure, current-source selection or source identity.
Retained capsule gist and excerpt are independent reductions: completeness of
the reduction does not make it an original body. Their original validity stays
unknown without a checked source binding. Evidence pointer and HTTP reads
disclose each text field; Inspector shows the qualification outside the stored
text.

**Current wire (unreleased Protocol 19.0.0 / engine gateway 2.0.0, invariant
§25 major; not a release).** Live MCP, worker, library, recall-candidate,
evidence-text, and Inspector payloads admit only codec version 1: the lossless
positional tuple `[1, material_kind, source_binding, source_representation|null,
evaluated_as_of, source_time|null, validity, temporal_state, proof_use]`.
Nested values keep their named fields. Null optional slots mean undisclosed, not
unknown. `encodeSourceDisclosure` captures and validates the named semantic once
before emitting the tuple. `sourceDisclosure` is the named helper for an admitted
current tuple. `qualifySourceDisclosure` changes only `proof_use` and optional
time omission without recapturing source metadata. Core `projectSourceDisclosure`
emits this tuple. Codec version is independent of library/result versions. Named
Protocol 14–18 objects are not live ingress; `decodeHistoricalSourceDisclosure`
is an offline ordinary-recall archive reader for those majors and must not be used
for current MCP or worker admission. Unsupported codec versions fail closed.
This compact helper/decoder pair is still being finalized. It does not establish
review, release, or default useful recall.

Consumers of the live tuple include `soul.recall` results, `soul.interpretation`
prepare/reason/library deliveries, Core recall encoding, evidence-pointer HTTP
reads, and Memory Inspector (`sourceDisclosure` before display). Public callers
cannot supply query vectors or selected profiles on this surface.

## Historical source disclosure

The named-object public fields were a Protocol 13.0.0 major cutover under
invariant §25. That object is historical public bytes, not the live wire; live
Protocol 19 admission is the compact tuple above. Semantic field meanings in this
section still apply through `sourceDisclosure`. The semantic library delivery
identity at that cutover was v6 with worker/public protocol 7; old response bytes
and continuations were not relabeled. Source-record and interpretation identity
algorithms remain unchanged.

Protocol 13.4.0 added optional named `source_time` to that historical object.
Live projections still disclose the checked source record's `event_time` as source
observation/event metadata, independently of its validity interval and the read
clock. Known, not-recorded, metadata-unavailable and unbound remain distinct; this
metadata does not establish when a described event occurred. Named 13.x objects without the field remained parseable as that historical object
and are not live ingress; existing library identities stayed v6/7 at that minor. In native
library delivery, the complete source facts and text reserve the first-page
envelope before optional source time is included. An absent `source_time` means
time was not disclosed, including when the byte or work budget omits it; it does
not mean the original record lacked source time.

Source records may explicitly qualify their `source_representation` as
`original_body`, `retained_excerpt`, or `canonical_projection`. Missing historical
metadata remains unknown; current read disclosures do not infer original fidelity
from a source-record row. `original_complete` is true only for an explicitly
qualified original body. `content_complete` separately reports whether the
retained record's own bytes were completely read. Existing records and retained
response receipts are not relabeled.

Post-turn capture preserves each supplied message's exact excerpt, including
indentation, line endings, and leading or trailing whitespace, in a separate
`retained_excerpt` record. It keeps the existing normalized extraction corpus as
a `canonical_projection` with an ordered list of the exact retained record
identities. The projection can be read only while every origin body is available
and remains current in the same workspace and scope. A projection cannot depend
on another projection. Dependency checks share the Protocol qualification owner
across in-memory and SQLite stores. Representation metadata participates in new
record identities; absent metadata keeps the historical identity preimage.
Correcting a representation requires a later recorded time and a new revision.

Each raw message retains its supplied speaker and scope. Conversation capture
uses each message's own observation time; report-context excerpts have unknown
event time. Native source-semantic request preparation uses the retained record's
supported speaker as its `sourceRole`; an assistant's quoted `User:` line remains
assistant material. Reference catalogs contain text locations, not speaker
authority, so public catalog preparation alone does not establish an author.
The legacy normalized projection and historical records retain their existing
role-marker interpretation. Speaker roles do not establish a person's identity
or replace utterance attribution.

## Opt-in open source semantics

The `soul.interpretation` channel retains its source-local source interpretation, source-independent
query semantics, explicit semantic correspondence, and selected conditional computation. It does not replace ordinary `soul.recall` or
Garden v1. Protocol 13.1.0 uses `source-interpretation-v4`, `source-semantic-query-v4`,
`source-semantic-correspondence-v3`, source request envelope v6, source response envelope v5,
published source interpretation v5,
reasoning v5, cache v3,
library v6, public/worker recall protocol 7, and `source-semantic-k-v3`,
`source-semantic-normalizer-v5` and `source-semantic-lowering-v6`. Each complete
source-frame group is a jointly constrained compile alternative; slots must not
float off that group's predicate frame. An older open source interpretation is not relabeled or silently promoted; recreate its interpretation explicitly.
The profile-bound source-interpretation-v2 route and its recorded bytes remain
separate regression contracts.

Source generation may opt into `source-semantic-generation-task-v1` through the
existing extraction generation config for one original-query family. Both
`all_supplied_meaning` and `original_query_task` receive the same complete original
source, catalog, roles and recorded attribution. The query cue supplies no source
fact or identity relation. Scoped responsibility preserves every dependency needed
for represented claims and declares other meaning `unassessed`, including meaning
inside an otherwise represented assertion. Structural accounting remains unchanged;
neither accounted units nor a task declaration certify semantic completeness.

The shared source-request owner derives original text from `sourceCorpus` and
verifies its digest, indexed units and locations. Strict model table/inline output
cannot set task metadata. After materialization the host attaches the request task
to `SourceSemanticHostBoundDraftSchema`; normalization, cache readmission, revisions
and draft or normalized publication retain it. Public MCP `soul.interpretation`
`propose` carries the same declaration as an optional sibling of the strict model
draft; nested `draft.generation_task` stays invalid. The handler binds a validated
sibling through that host-bound draft owner after source-handle admission and before
existing publication. The field is caller-declared responsibility, not verified
generation history or completeness. H identity binds the exact cue bytes.
Full delivery includes the task; lightweight descriptors disclose responsibility
without repeating the cue. Later use under another query remains task-scoped and
cannot establish omitted-fact absence. Explicit abstention has no H and is not a
corpus absence certificate. Raw text plus catalog duplication consumes the same
finite input budget in both modes. Without a task the existing bytes and identities
are preserved. Native population membership, inspection, preflight and publication
associations regenerate requests from the same opt-in generation config.

The additive MCP request may bind finite preview byte extents to exact current
source tuples. Native source reads expose the bytes actually observed and retain
unread tails as open; an available empty body is complete. A later `prepare_source`
performs a separately metered fresh read. A handleless `reason` on a sealed H-bearing
snapshot can return bounded branch attention before accepting bindings exist.
Computed attention binds the admitted Q/H/C/computation and actual demand state;
preparation attention names a missing Q or C without inventing its identity.
Unreached or unattributable branches remain unknown or unobserved. Attention is
control information for one correction cycle, never source fact or proof authority.
Protocol 13.3.0 optionally delivers completed zero-binding computations for
delivered source records as bounded `unproved_computations`. Each control binds the
current source and Q/H/C/computation identities, logical completeness, and any
keyed attention. It conveys no answer binding or source fact. Conditional
computation coverage follows actual execution; missing dependencies remain
unexercised, while resource-limited execution remains open. In the unreleased
Protocol 19 major, public `execution` is the `native_reasoning_only` literal or
the version-2 compact tuple `[2, preparation, acquisition]`; access receipts
retain typed compact `phases` `[2, preparation, acquisition, observation|null]`.
Inner preparation and acquisition remain version-1 compact tuples; each may carry
one optional supplemental route at slot `[3]` (original-first primary, distinct
hint). Wire admission checks those compact slots directly. Expanded
`source-semantic-execution-v3` meaning remains authoritative only through
`sourceSemanticAccessPhases` and `sourceSemanticExecutionPhases`.
`sourceSemanticExecution` emits the literal only for exact canonical
not-requested/not-run receipts (`query_preparation` reason
`operation_does_not_prepare`, `acquisition` reason `operation_does_not_acquire`,
`semantic_generation_attempts: 0`, no supplemental route). That literal excludes
model/index acquisition attempts, not native reads or computation, and does not
mean zero native work; it is never inferred from generation-attempt count alone.
Any other reason, resource evidence, supplemental route or unknown measurement
stays a compact non-literal execution tuple. Packing captured semantics
round-trips through the expansion helpers without dropping profile identity,
unknown measurements, or supplemental route costs: `null`, `unknown`, `not_run`,
and vector `valid_empty` stay distinct from zero, absence, or `ready`.
Public consumers derive external attempts from execution (preserving `null`),
summing original and supplemental routes, not a duplicate `provider_attempts`
field or semantic-generation count, including via
`sourceSemanticExecutionExternalAttempts` without expanding complete phases.
Frozen access `phases` are observation provenance, not this delivery's execution;
current-call `execution` is attached separately on first page and frozen
continuation.

Reason delivery tries the complete v5 result and all premises against the actual
native/public UTF-8 envelope cap for every outcome. Full results and premises
are retained whenever they fit. Only an oversized envelope may carry
`no_conclusion`: an explicit no-delivered-conclusion receipt with the original
`outcome`, available H/Q/C/computation identities and restrictions, intact
disclosure including `proof_use`, actual coverage and measured work, but no
result, bindings or premises (`coverage.payload: truncated` when clipped). It is
not delivered proof or attention, not a failed or uncomputed kernel result, and
carries no world claim. Complete computation coverage remains complete when only
payload delivery is clipped. Mandatory evidence that does not fit fails closed;
there is no universal 1024-byte evidence guarantee. The compact receipt tuple
holds `[outcome, [H, Q, C, computation], optional query gaps]`; `null` in its
identity tuple means no available result identity, never proof of uncomputed
work. The outcome object and complete identity digests stay intact; only field
names are contracted. Recovery expands it through `sourceSemanticReasonControl`,
retaining computation identity, restrictions, coverage and disclosure without
inventing attention or treating omitted premises as never computed. Frozen continuation
pages and the immutable first-exposure row retain only controls for their
delivered source records.

Query meaning v5 uses `conditions` for conjunction and optional
`evidence_inputs: [{conditions}]` for the facts needed by the original requested
operation. Ordinary `alternatives` are disjunctive ways to satisfy the same query
with the same return projection, not independent subtasks. All `return:true`
declarations form one global return set; every nonempty answer view must bind
every returned key, except comparison evaluation, which uses its operand rules.
An empty ordinary answer view has no direct-answer binding. Each evidence input projects
its own participating free entity values independently of the direct-answer
return set. The shared generation guidance explains these existing rules and
requires the whole request's participants, governing conditions and residual
relationships to remain in the relevant answer/input conditions; moving
conditions between branches alone does not establish faithful meaning.
Q proposal inputs and native query workset items may select
`generation_presentation`. Omitted or `flat-carrier-v1` selection keeps request v9
and response v8: expression occurrences use a bounded acyclic `nodes` table, and
condition/operand positions carry serialization tokens. Explicit
`nested-meaning-v1` selects request v10/response v9 and supplies the current nested
expressions directly to the same meaning compiler. The captured request contract
selects generation and receive; body shape cannot select a decoder or reuse a
different presentation's cache identity. Opt-in `nested-referent-constraints-v1`
selects request v11/response v10 with the same nested grammar. Its producer labels
`query_referent_constraint` and `no_referent_constraint` map exactly to canonical
`named` and `free`; local `reference` uses are unchanged. The adapter preserves
explicit choices, including wrong ones, without inferring identity from excerpts
or keys. Its vocabulary copy uses the shared depth, byte and resource bounds;
mixed old/new labels are rejected. This does not change the default presentation
or establish producer fidelity. Protocol derives the wire schemas from
one expression authority. Flat receive checks references, cycles, reachability
and expansion bounds; nested receive checks depth before recursive serialization
and parsing, retaining the shared byte and resource limits. Earlier recursive
wire contracts remain historical and cannot enter current execution. Nested
`forall` is rejected; explicit top-level universal evaluation remains supported.
The outgoing generation schema requires one entity declaration table and explicit
role excerpts. Argument and reporter targets use local references; examples and
schema present entities before branches, with nodes before roots in flat output.
Protocol 16.0.0 derives generation and receipt from the same structural query
body modes: ordinary alternatives need answer conditions or operation-bound
evidence inputs; universal evaluation needs nonempty conditions; comparison
evaluation needs empty conditions. Neither finite mode admits evidence inputs.
Pairwise comparators require both operands and matching strictness; extrema omit
the right operand. These public required/removed fields and narrowed values are
a major under invariant §25 even though native admission already rejected the
illegal combinations. Upgrading clients must adopt the structural alternatives;
existing valid canonical identities and wire contract IDs remain unchanged.
Domain, reference, binding and semantic checks remain native.
Protocol 17.0.0 further restricts alternative `purpose: "counterexample"` to
universal evaluation. Canonical admission and all three producer presentations
derive this implication from one Protocol purpose rule. Ordinary, operation and
comparison bodies allow omitted purpose or `support`; universal bodies retain
both purposes. This public schema narrowing is a major under invariant §25.
Clients must adopt that combination; valid canonical identities and wire
contract IDs remain unchanged. Same-body negation and connectivity still require
native validation, and lawful generation shapes do not prove producer fidelity.
Historical current-wire inline declarations and unambiguous entity-support
inheritance still use the same receiver. Generation shape does not certify
reference closure or fidelity.
The canonical query also binds the complete host-approved fixed context
(`null` when none was supplied) and one `utterance-attribution-v1` value. Its
identity changes when those consumed fields change, even if the query text and
meaning body do not. Source records hold the same attribution schema; the current
source request and published interpretation carry the exact source value. The
full-catalog correspondence request is v7; the optional native branch-demand
request is v9. Both use the same versioned endpoint-evidence
projection, which copies declared named-reference uses, source mentions, attribution,
assertion locations, frame context, support and bindings onto the existing catalog
handles. It selects no equivalence and gives no new proof authority. Mention span
units remain tagged separately from source UTF-8 assertion and attribution spans;
the source interpretation identity does not bind mention spans. Recorded v5 and v6 C
request bytes and cache identities remain historical and cannot enter current
generation; there is no retained historical C semantic replay entry. Current C
response v5 derives its request-specific generation schema from
`source-semantic-correspondence-assessment-v1`; retained v4 responses keep their
original decoder. Each advertised query endpoint has exactly one supported or
unresolved assessment. Supported
assessments propose explicit source equivalents; unresolved assessments propose
none, while supported endpoints may still form a partial canonical C. In v5,
only a referent or slot with one unique, stored, verbatim original-query excerpt
may omit `query_excerpt`. SOUL uses one eligibility resolver for generation and
reception, meters prospective UTF-8 expansion before copying,
and fills only absent properties before unchanged assessment and Core admission.
Predicate quotes, ambiguous or context-only support, and supplied invalid quotes
are never repaired. Pair choice, source support, context and unresolved meaning
remain producer responsibilities. This mechanical completion does not certify
semantic correspondence. Benchmark request identities include the new schema
and prompt; retained raw v4 responses and Q/H-keyed library caches are not upgraded.
Scoped request v9 uses a flat draft with no `contract` field: the model returns `decision`
(`assess` or `abstain`), required `assessments`, and optional domain/membership
arrays. Strict generation and receive reject both `source-semantic-correspondence-response-v7`
and `source-semantic-correspondence-assessment-v1` on that draft; neither identifier
grants admission to a producer draft. The host binds
`source-semantic-correspondence-assessment-v1`, the outcome and the sole H
handle from the captured request. A scoped v9 request requires exactly one
identity-validated H descriptor. Abstention cannot carry assessments or domain
payload; optional absence is preserved and `null` is rejected. Captured v8
requests retain their v6 envelope decoder; response shape cannot select a decoder,
and historical raw results are not upgraded into new request identities.
The Protocol-owned `branch_demand` policy
addresses an existing query alternative and answer/evidence target. The existing
branch-view owner retains governing context and connected obligations. The host
derives the exact demanded catalog handles; generation and receive require one
assessment per demanded handle. Full Q/H, catalog and endpoint evidence remain
bound. Endpoints outside the demand stay explicitly unassessed, never synthesized
as unresolved. Successful receive reports demanded, assessed, unassessed,
supported and unresolved coverage; failed or unattempted work has no successful
coverage receipt. Coverage describes producer work and grants no proof authority.
The original full-catalog request/response bytes and two-part cache identity stay
unchanged. Scoped cache material additionally binds the policy, and native request
keys bind its version, full request, prompt and schema. A scoped result cannot
satisfy another demand or a full-catalog cache lookup. Each C remains a separate
premise through the existing runtime; there is no union of conflicting mappings.
Library/benchmark preparation independently bounds H candidates and total C
requests, retaining every attempt and its costs. Replay and withdrawal select the
exact correspondence identity consumed by the proof. A delivered source root
occupies one slot and may carry several independent proof qualifiers. Consumers
join qualifiers by their explicit slot index and full Q/H/C/computation identity;
qualifier array position is not slot position. Each qualifier's witnesses and
support come from that proof alone. Protocol 14.0.0 records this public semantic
change under invariant §25; occupied-source counts remain distinct from proof
counts.
Native benchmark source preparation can bind an explicit `native_first_page`
scope with a source cap against the retained first ten source opportunities. It
preserves complete source text, the entire census and original ordering. Eligible
but unowned sources remain distinct from sources outside the assessed scope.
An explicit empty dry-preflight selection produces zero requests; execution
sample authority still requires a nonempty key set. `--generation-task-json`
passes the same protocol-validated query task through extraction CLI preparation,
quote, authority inspection and execution. Bounded binding requires the exact
original question; changing the task changes request identity and invalidates
old request ownership. The existing complete-census caller retains its full
ownership requirement when no bounded scope is supplied.

Producer disposition eligibility has one kind-specific Protocol authority:
H permits `interpreted`, `no_executable_proposition` or `abstained`; Q and C
permit `interpreted` or `abstained`. Flat C decisions map through the same policy.
Generation and receive both derive eligibility from this owner. Models cannot
claim operational failures or supply host raw-response provenance. Actual
transport, truncation, resource and parse failures remain host-observed states;
the canonical runtime outcome schema retains those distinctions.
Only supported pairs lower to the existing canonical C; grounding and unresolved
explanations remain inspectable metadata, not executable proof. Protocol counts
projected JSON bytes incrementally before expanding each endpoint and repeated
use. SOUL uses the same meter to bound descriptor aggregation and reserve
the other request fields before projection; the projection spends only the
remaining 1 MB request allowance. SOUL retains the final full-request
serialization cap as a backstop.
The Protocol endpoint-evidence projection exports are additive minor API under
invariant §25; the v7 C request and request-aware v5 response have current wire
identities. The existing no-argument Schema API still describes retained v4;
new generation passes its request to the same API. Canonical C is unchanged.
Role-only inputs explicitly
carry `unknown`; they do not manufacture a speaker or conversation identity.
Captured attribution is scoped to its issuer and conversation, and exact UTF-8
occurrence ranges bind it to the admitted bytes. It supplies bounded outer-author
context, not a source fact or an answer. A metadata correction keeps source bytes
and digest unchanged but requires a new source revision recorded at a later time;
same-version attribution changes conflict.
The producer marks each requested entity, statement or operator on its declaration with
`return:true`; Protocol derives the canonical return list. A separate producer
return list is rejected. Evidence inputs cannot declare returned targets. Boolean
queries need no return marker. The host still cannot supply an omitted answer
relation or copy a qualification from an answer into an input.
`required_evidence_act: {act, excerpt}` explicitly constrains sought evidence to
a question or directive, with exact support in the original query; it maps to
the unchanged canonical `source_act`. The host
defaults those roots to `unresolved` context; ordinary roots still default to
`asserted_at_source`. Shared query admission rejects asserted or entailed content
requirements on a frame constrained to either non-assertive act. Nested incidence
and explicit compatible obligations remain intact: a source-act root can govern
content, but a governed occurrence cannot itself require a source act. Query
wording alone never selects a source speech act, and retrieving one does not
establish its content.
Entity handles are arbitrary local references, never text support. A free reporter
provides its original-question excerpt once; a named reporter already carries its
excerpt. A reference reuses its declared entity's unambiguous support. Missing or
fabricated excerpts remain invalid through the existing Core admission owner.
More generally, a free target binds a value without an added identity constraint
from that declaration; unknown answers, existential witnesses and binders remain
free when the question leaves them unconstrained. A `named` target retains an
original-query referential expression, including a speaker, addressee or definite
description, through the canonical variable `reference`. It does not assert a
resolved global identity or that any source participant is equivalent. A local
reference reuses the declared constraints. An exact excerpt on a free role proves
text support only; a suggestive key or matching role cannot supply a missing
referent obligation. If authorized query context genuinely leaves the intended
referent unresolved, retain its constrained target with a located
`unresolved_referent` gap, or return unavailable meaning when no faithful query
can be proposed. Lack of source correspondence alone does not require a query
gap. Core admission checks structure and excerpts; it cannot infer omitted
language constraints. Semantic correspondence must independently justify a
reference-bearing target against a source referent before conditional proof.
Optional occurrence aliases are bookkeeping, not evidence. A single occurrence
alias that collides with an entity declaration can use a fresh host ID only when
no reference, return, gap, domain or evaluation uses that alias. Referenced,
multiply declared or otherwise ambiguous collisions remain invalid; neither
meaning nor an existing accepted identity is repaired by this allocation.
The host derives frame views and execution groups from the original query semantics.
A view retains governing context and sibling operands. It never introduces another
query semantics or semantic correspondence identity.
Direct answer conditions preserve every original restriction even when inputs
are also declared. An unrepresented answer relation remains explicit.
Producer guidance preserves a requested attribute in the relation itself and
connects every qualification of a definite event to that same referent. An outer
request to recommend, compare or calculate retains its requested operation and
target; polite request wording alone does not seek evidence of the addressee's
ability. Candidate suitability does not execute a recommendation.

Reasoning `binding_results` distinguish `answer` from `evidence`; evidence
always has `query_complete: false`. For an execution-owned answer binding,
`query_complete` means that the supplied Q has no declared gaps. It does not
certify complete original-language meaning or faithful H/C premises. Producer
`interpreted` means decoded/materialized output; Core admission checks the
conditional premise's structure, identity and evidence references. Neither is a
language-truth certificate. Both binding kinds use the same execution, projection and
proof verifier. Each occupied source root retains all delivered binding witnesses
and their required explanation forests. `semantic_proof` means verified conditional
evidence, not necessarily a complete answer. The shared query-support projection
reports original-answer and per-input coverage. It never performs the requested
operation, joins identities across sources, or infers distinctness from local IDs
or equal names. Incomplete execution phases remain resource-exhausted/partial.
Archive-only source-evidence protocol 1/library v1 retains its recorded identities,
page and order through the offline admission owner.

Current source-interpretation extraction uses the producer-only
`source-semantic-proposal-v8` contract with `host-owned-table-schema-v1` at
canonical domination depth 16. The finite table declares typed entity and
occurrence keys, roots, nodes, domains, measurements and gaps. Omit optional
domain and measurement tables when the source does not support them. The producer
owns predicate/role readings, co-reference, semantic scope, speech acts, domain
membership/closure and measurement context. Every materialized entity is declared
once and referenced by its table key; a distinct semantic alias records supported
co-reference. `content_ref` owns nested content, `content_reference` reuses content
under the same parent, and `occurrence_ref` names an occurrence without governing
it. Source-label equality is not identity. The table's ownership edges preserve
nested scope; the host does not reconstruct lost scope from English labels or map
a missing act to assertion. Role evidence alone does not define an argument
target, and a local key cannot supply missing identifier or date text. A reporting
event with its own time or other roles uses the ordinary statement with nested
content; the `reported` scope operator does not supply those event attributes.
These forms remain distinct, and neither asserts its embedded content independently.
Producer guidance represents the source's relations and attribute values as
predicates and arguments, rather than replacing them with a summary of an
utterance. Transport labels do not introduce speech events. A statement can be
the content of an assertion, directive or question; its root act preserves that
distinction without an invented negation or reporting operator.
Protocol assigns canonical IDs and compiles mentions,
slot/binding pairs, reciprocal context owners, assertion membership, quantifier
binders and canonical outcome gaps. A plain occurrence reference does not embed
its target. Unowned or conflicting scopes are rejected; the compiler never
guesses assertion permission, pronoun antecedents or domain facts. Compilation
and normalization share one resource ledger. Structural admission and located
gaps cannot certify language completeness. The table-producer change preserved
the canonical interpretation and source response envelope. The attribution cutover
adds required source-binding attribution and published envelope v5; the source
response envelope remains v5. Current SOUL request, receive, prompt, schema and
revision admission require the v8 table request, source units, explicit
host assertion locations and normalizer-v5. Earlier H producer envelopes and marker-absent normalizer-v3 requests remain
recorded as their original bytes and evidence, with their original commit and
receipt lineage. They have no current generation, executable cache, import,
revision, publication, worker discovery or conditional proof eligibility. SOUL
exports only the current H request, prompt, schema, receive and revision entry
points. These reject older requests and responses directly. The ordinary
source record and published canonical H storage paths retain their independent
identity, currentness, scope and erasure rules. Historical source records with
absent or null attribution remain distinguishable from a new explicit `unknown`
value; no historical semantic verifier or published-v4 identity preimage is an
active API. Current H publication requires envelope v6, normalizer-v5, host
assertion locations and published-v5 identity.

Bench keeps bounded raw request lines, raw response digests, manifest generation,
receipt, attempt and lineage evidence for recorded old shards. Its old-H
classifier can mark a well-bound shard `retired` and an inconsistent record
`invalid` without decoding an old semantic proposal or reconstructing an old
prompt/schema/cache key. A retired shard is neither a current hit nor a payable
miss. Pending, unknown, transport-failed and incomplete attempts retain their
separate recovery and accounting states. The current request-line, Batch,
cache and fill gates use the current SOUL receiver; old raw bytes cannot be
relabeled current. This direct producer-wire cutover changes the exported API
for historical H readers under invariant §25; it does not publish a package
version. Provider acceptance and syntactic constraints do not certify language
fidelity, coverage or operation execution.

Current table requests bind `host-owned-table-schema-v1`. Every source selection
names an assertion ID and exact text. Occurrences are zero-based among exact
catalog-eligible matches ordered by start, including overlapping matches; only
multiple eligible matches require an explicit occurrence. The catalog boundary
resolver rejects absent, ambiguous, out-of-range and word-internal selections.
The historical raw-substring locator does not define this producer's ordinal.
Discontinuous lists retain their existing bounds. The request carries the original source digest and units;
the catalog remains host-owned and is reconstructed by the existing owner. The
table adapter checks key ownership before expansion and lowers through
internal selection, compact, expression and content compiler phases under one
resource ledger. Their source selection, scope, co-reference, domain,
measurement and canonical admission checks remain active; no historical
producer wrapper is accepted. Retired v7 and earlier responses remain raw
execution evidence, not current v8 admissions. Gemini decoding guidance has
its own provider projection: recursive schemas use JSON mode with complete
schema guidance and strict local admission, while safe acyclic schemas use
structured decoding within conservative byte and expanded-node bounds. Current
cache material binds the complete current schema and actual instruction-only
encoding. A recorded request stays bound to its original candidate and wire
identity without executable historical schema reconstruction.

Query role references resolve to a unique declared entity, proposition or context without adding embedding or
changing a root's truth obligation. Proposition/context role references require
an explicit original-query excerpt. Reporter positions remain entity-only.
Structural checks do not prove that
the producer chose faithful meaning, complete attachments or requested operations.

SOUL can prepare an explicit `source-semantic-revision-v1` input from retained
JSON. The additive `source-semantic-revision-v2` records caller-observed complete
generation and can retain invalid JSON with a stable syntax diagnostic. Truncated,
unknown-completion and empty responses are not accepted by that preparation path.
The transport adapter owns completion observation; SOUL does not independently
attest a network response. Completion does not establish syntax or fidelity.
Each revision binds the unchanged base request, immediate parent request
and prior raw bytes; the chain is validated before use and capped at three
revisions. The shared compiler rederives structural diagnostics, including exact
alias and ownership paths. Separately labeled source-review comments are bounded
to selected assertions and remain proposed interpretations. Revision input does
not become source-interpretation evidence or relax admission. Preparation is provider-free and never
automatically retries. The native Batch flag `--extraction-source-revisions`
requires `--extraction-open-semantics` and a bounded registry produced by SOUL.
The registry is pinned in generation identity and must match the source inventory;
changed requests require fresh native authority, reservation and attempt receipts.
Original failures and every paid attempt remain in the case's evidence history.

New source requests also declare `source-semantic-units-v1`. SOUL owns their
unfiltered lexical units, exact source locations and message-role provenance;
questions, directives, fragments and assistant text remain available for
interpretation. Bench uses that same owner for packing, request deduplication
and transport occurrence identity. Garden factual eligibility is not an input
filter for this channel. Marker-absent requests retain their historical Garden
assertion binding for offline replay. A source role records who supplied text;
it does not certify the text as a fact or resolve its semantic context.
An optional source-request `source_role` binds a known single-source author and
all its units. It is included in request/revision identity and reconstructed
from the retained request during admission. This additive SOUL request-body
field keeps the existing opaque public request envelope version; absent fields
retain legacy marker parsing and exact request bytes/keys. It changes neither
the public source-reference catalog nor the producer response schema. New
role-bound requests require their own exact request authority and cache key.

Open extraction may explicitly select `complete-source` packing. Its request
records that scope and binds all indexed units of the supplied source corpus
in order, including both message roles. SOUL checks this membership against the
original source on receipt. Existing catalog limits (128 units, bounded text and
segments) apply. For a valid complete source beyond a catalog limit, the host
records a typed `unsupported_source` preparation disposition with the exact
capacity reason and source/contract identity. The full raw source and every
question occurrence remain in the census; that source has no extraction request,
cache key, provider attempt, or interpretation. Invalid source identities,
membership, metadata, or revisions remain errors rather than unsupported
sources. Ready requests retain their existing identities.
Historical assertion-capacity reasons with limit 64 remain readable alongside
current limit 128 reasons. Reading them does not authorize re-execution or
rewrite the original disposition. Batch dry preflight
reports ready request counts separately from original source and unsupported
occurrence counts. Its versioned source-publication associations carry the
unsupported disposition to native publication, which rechecks it against the
exact source census and records it in the publication report after SQLite reopen.
Interactive source preparation surfaces the same typed capacity reason as a
validation error; its successful response contract is unchanged.
The native Step path defaults to `step-3.5-2603-low-json-schema-v1`; the explicit
`step-3.5-2603-high-json-schema-v1` profile selects high reasoning with the same
exact `step-3.5-flash-2603` model. Protocol owns these identities and effort
bindings. Profiles have distinct cache, wire and authority identities; one cannot
reuse the other's receipt. The exact selected Step Plan or ordinary OpenAPI route
remains bound to its quote. Source,
query and correspondence preparation bind the gateway-encoded strict JSON
schema body, profile-owned reasoning effort, `max_tokens`, route and profile before
reservation. The Step source dry preflight is provider-free and may select an
exact set of ready keys while retaining the full source and unsupported
occurrence counts. It defaults to 4096 output tokens; an explicit positive
safe `--extraction-preflight-output-token-cap` selects another finite bound.
The retained `source-semantic-interactive-preflight-v3` binds the encoded wire,
input and cost bounds. Its complete ready-request inventory includes compatible
cache hits and their current occurrence keys; planned requests remain only new
payable misses, and deterministic empty requests remain zero-attempt. The native
association reader validates each retained ready request against its current source
and retained cache/raw evidence, so a later question can reuse the same key without
pretending the earlier question's occurrence keys were new attempts. A Step complete-source sample authority requires that
report via `--extraction-source-preflight`, with matching logical and physical
route, selected keys, cap and quote; historical v1/v2 reports are not current proof.
The sample receipt reserves at most one
attempt per selected key; an incomplete or failed response stops the remaining
keys. The shared attempt ledger enforces that per-key limit across reopen.
Query and correspondence proposal authorities use the same one-attempt policy.
Step raw records retain the bounded original HTTP byte prefix plus the digest,
length and completeness of all received bytes; only a lowercase `stop`
finish reason counts as complete. Missing usage remains unknown under the full
reserved bound, while contradictory reported totals or token caps stop
settlement. The frozen Step Plan quote is a conservative USD-equivalent policy
bound derived from documented CNY rates, not an invoice or balance reading.
Recorded requests without the scope marker remain limited to eight selected
units and retain their historical replay. Closed Garden/profile extraction
rejects complete-source packing. This supplies source context without deciding
co-reference or enlarging canonical source interpretation, output, or execution budgets. It does
not claim access to conversation outside the supplied source corpus.

Normalizer-v4 accounts for selected assertions without connected evidence,
orphan mentions/referents, unresolved slots and embedded occurrences without
parent bindings as located gaps. It never invents missing relations or bindings.
Core checks the same accounting on normalized admission and persisted reopen;
stripping gaps cannot bypass it. Host expansion beyond graph or work/memory
capacity is resource exhaustion. These structural checks cannot discover every
omitted qualifier inside a supported clause: an admitted source interpretation remains unreviewed
for language fidelity, even when no structural accounting gaps remain.

Protocol owns operator/embedding incidence and the exact host-derived entry
roots and assertion permissions. Entry activation is not assertion. Conflicting
operand and context-owner declarations are invalid. Reporters are participants,
not governed content. Query operators, role targets, variable sorts, named
referent correspondences and all incidence obligations lower onto the existing
conditional-field engine. Iterative traversal visits reverse and non-tree
incidences with shared variable binding; it is not a second answer matcher.
Mentions locate source evidence. A slot binding's node target must be a
declared referent, frame or operator; a mention is not an argument node.
Gap locations may also name declared mentions, so an uninterpreted clause can
remain a source-located gap without inventing a frame. Neither a target nor a
gap location may cite an undeclared handle. Producer guidance explains these
distinct reference domains; Protocol remains their admission authority.
The query-semantics context obligation `unresolved` requires no completed-event assertion and
excludes source assertion occurrences. It accepts question, directive,
unresolved source acts and embedded/operator content through the non-asserted
context premise; it is not a positive test for `source_act=unresolved`.

Finite universal operators declare a domain, binder, optional restriction and
body. Domains carry source evidence for membership, exclusions and optional
closure, in a declared source context. Open domains support member instances;
exhaustive universal queries require a closed asserted domain. Closed empty
domains yield a boolean certificate with no witness. Scoped-domain exhaustive
queries remain unproved. Nested universal binders are explicitly unsupported.
Counterexample branches currently require asserted negation of the same single
positive predicate/role-variable body; complex counterexample formulas are
rejected instead of treating an unrelated negated clause as a falsifier.
Elimination does not cross negation, opaque operators or conditional antecedents.
`entailed_at_source` distinguishes an inferred instance from literal
`asserted_at_source`. Promise, report and possibility content retain their path.
Novel query entities require explicit semantic-correspondence membership assumptions; their derived
coordinates and assumption leaves remain visible in the conditional proof.

Measurements declare a subject, owner occurrence, population, metric, unit,
context and exact decimal value (at most 128 digits and 64 fractional digits).
Comparisons use identical units without conversion. Missing operands remain
unknown; incompatible signatures remain incomparable. Extrema require closed
populations, retain non-strict ties, and have no winner in empty populations.
Each operand consumes membership evidence or an explicit semantic-correspondence assumption for its
aligned query referent. Open unknown membership remains unresolved; measurement
metadata alone does not establish eligibility. Excluded subjects and subjects
absent from closed populations cannot have measurements in that population.
Conflicting values for the same subject/population/metric/unit/context require
an explicit context distinction and are rejected at admission. Additional
comparison frame constraints are unsupported; the typed operand scope controls
assertion versus preserved context. Subjective adjectives alone create no numeric
measurement or objective ordering. All finite obligations lower to existing
relation gates and AND joins; only arithmetic order is a primitive evidence atom.
Enumeration, proof material and encoded output consume the request resource
ledger. Compiler coordinates are compact, bound to the conditional computation, and explicitly described in
proof output; they do not become declarations or assertion permissions in the source interpretation.

Core publishes source UTF-8 assertion locations and re-resolves mention
selectors at both the normalized-IR entrance and SQLite reopen. Ambiguous
repeated text requires explicit host locations. The unique-text compatibility
adapter is not permission to guess an occurrence. Source revision, authorized
scope and erasure still govern every read and audited publication.

`soul.interpretation` `invalidate` is an explicit inline resolution of one
published, unreviewed H. A current authorized source handle and the exact H
identity bind the action. The caller supplies an error basis and reporter
provenance; these remain an attestation, not a source-truth certificate.
Core rechecks source binding and scope with the same bounded current-source
authority as publication, including the effective evidence alias. EventPublisher
owns the EventLog/CAS transaction and post-commit notification; a propagation
failure records diagnostics without turning the committed archive into a failed
mutation. Source validation and the archive phase share the request allowance;
exhaustion before mutation leaves H and its audit unchanged. Source bytes,
the archived interpretation, audit history and independent H remain intact.
Failed supplementation does not invalidate existing support; an independently
invalidated H cannot become active because its successor fails to publish.
Current discovery/reasoning excludes archived H and database revision changes
invalidate old frozen query/library handles. Pure proof-witness replay remains
historical computation evidence; it does not certify current H eligibility.

`prepare_query` returns bounded current source-interpretation descriptors and optional
`continuation_handle` pages. Query-semantics generation is source-independent; semantic-correspondence generation
uses these exact descriptors, including roles, bindings, mentions and contexts.
Host operations accept the same `authorized_scopes` admission as ordinary Recall
(`unrestricted`, `named`, or `denied`); omitting it stays unrestricted for the
attached-agent default. Source/query/page handles have distinct operations,
principal/workspace/scope bindings and finite process-local lifetimes. They do
not survive worker loss. The host passes `lifetime_now` separately from semantic
`as_of` to the worker. Preparation and library continuation expiry use elapsed
lifetime even when a benchmark pins the interpretation clock; freezing semantic
time cannot extend a capability. Internal callers without an explicit lifetime
clock retain the existing advancing `as_of` convention.
Query/page handles conservatively invalidate on the worker database revision;
reprepare after changes. One-shot reasoning is supported without claiming that
library discovery ran. There is no cross-run semantic result/coverage cache.

Initial `prepare_query` may carry an optional `access_hint` of 1–1024 nonblank
characters. Original-query navigation is always prepared first. A distinct hint
adds one supplemental navigation route that shares the same embedding bind and
selected profile; a failed hint cannot replace original work, and an identical
hint is not a second route. Original query, admitted Q and final
source/interpretation scoring remain unchanged. The hint is incompatible with a
source handle or canonical access. Access pool identity for `source-semantic-access-v2`
binds `original-first-navigation-v3` together with the exact hint. A continuation
can omit it to inherit the frozen value, but cannot change or introduce it and
never resumes observation. Query-handle recall reuses that pool. The hint provides
no semantic correspondence, fact, or durable memory. Existing FTS covers published
interpretation capsules; raw-only sources still depend on source observation.
Each route meters its own work against the shared request ledger. A task performing
another preparation must reserve and account for both calls and delivery in its
outer total budget; this parameter does not establish a cross-request allowance or
generate clues.

An explicit request-local Core session
(`packages/core/src/recall/runtime/source-feedback-session.ts`) can enqueue that
hint from a native accepted source-bound one-shot `reason` closure: mention text
on newly bound entity coordinates, not query literals, derived nodes, attention,
or an opaque `binding_id`. The yield is fresh `prepare_query` navigation that
keeps the captured original query, authorized scope identity and `as_of`, with the
seed source id/version/digest retained as root provenance. It is not a joined proof,
chronology settlement, source write, or frozen continuation. Navigation-only
sessions stop at that exposure. With an explicit private cache-only host policy,
Core can reserve one correspondence preparation for an exposed non-seed H whose
mention text matches that originating reserved action's hint through the existing
`sourceLiteralOccurs` NFC literal owner. The worker's order chooses among bound
matches; scores alone, metadata substrings, or unread/off-page H do not qualify.
This is navigation, not source identity or cross-H binding transfer. No exposed
match remains explicitly unavailable without extra pagination or quota. One existing
leased `reason` then uses that H, the unchanged original text and Q, and newly
admitted local C. Preparation binds its originating action/exposure and hint,
exact descriptor, policy and parent entitlement. An ID-only/mismatched descriptor,
missing lease, unusable cache or insufficient allowance is not ready-empty.
The daemon and bench collaborator reuse SOUL request construction and the existing
semantic-proposal key, read, decode and Core admission owners; no provider request,
fill fallback, cache write or new worker operation is introduced. Each subsequent
native reason obtains its own local snapshot and current-lease checks, not a joint
snapshot. The actual discovery exposure retains its completeness. The result is
independent local qualification only; seed assignments never transfer across H,
and the follow-forward result does not navigate recursively. Existing Q evidence
branches may qualify independently; C cannot split a purely conjunctive Q.
Seed H/Q/C is selected input, not an authoritative demand; only native
acceptance produces navigation. Each reserved action copies the same parent
entitlement and child `action_budget`; unknown or cancelled occupancy holds that
reservation and is never booked as zero. Host construction, physical cache reads,
decoding and native reason debit the same parent allowance through existing logical
resource owners. Unknown host cost retains its reservation; historical producer
usage (possibly unknown) is separate from zero new dispatches. Recorded native
exposures and host preparation outcomes are append-only.
Finish always reports `joint_assessment.status: not_lowered`
(`source_qualified_join_and_temporal_comparison_not_admitted`). The daemon adapter
(`apps/core-daemon/src/runtime/recall/source-feedback-execution.ts`) is trusted
Node wiring through `withExecutionScope`: a caller-linked abort and timeout
lifetime, not a read snapshot, MCP delivery, or ordinary `soul.recall` loop.
Execution certainty and terminal cause remain separate: worker loss, deadline
expiry, and an in-flight caller abort can all leave unknown occupancy with its
reservation held; the recorded cause distinguishes them. A measured qualifying
reason failure terminalizes qualification as unavailable with its cause; unknown
or cancelled occupancy stays unknown and held, never stopped-but-pending.
The private `executeSourceFeedbackForRuntime` Node entry uses the existing port
registered by `createAlayaDaemonRuntime`, with no client getter or runtime field.
Constructor and entry must use matching compiled module identity. Missing binding
fails closed and a closed client retains its existing execution-scope refusal.
This entry does not construct a seed or make ordinary Recall a feedback loop.

A separate private worker adapter, `researchLibrary.recall`, can apply the fixed
`private-two-h-chronology-v1` rule after native library execution in one snapshot.
Core owns the rule; explicit selected coordinates must bind an actually executed
Bridge/Review local closure and an independently qualified Approval closure. Typed
key kind, issuer, project, exact normalization and value must agree; source-located
explicit-offset event times must establish strict precedence. Missing, ambiguous,
unsupported or non-assertive premises do not become a witnessed result. The
assessment remains unreviewed and its world claim unknown; it does not change the
feedback session's `not_lowered` result or add a public joint-proof field.
The adapter tests delivery through the existing package, fit and encoder owners,
then recomputes a budgeted Bridge-premise withdrawal with independent Approval
preserved. This is a private causal diagnostic, not a durable source retraction.
All private computation and transport consume the native request's remaining
ledger; the reported private work includes that native prefix and must not be
added to it again. Funded diagnostic failures preserve the native sibling; if even
its minimal failure envelope cannot be funded, the private call fails closed with
separate known native and diagnostic work. Native continuation identity and worker
affinity remain ordinary; private fitting issues no hidden continuation leases.
Only delivered, non-routable private pages and bounded dependencies escape; no
joint cache or persistent graph is introduced. Ordinary MCP/default recall does
not enable this adapter. Its guarded non-test benchmark caller is not yet wired;
authored native-worker controls do not establish natural semantic fidelity.

`soul.interpretation` `recall` is the opt-in library path shared by native callers
and the benchmark. Original query and authorized scope enter once. After snapshot,
host observation and conditional computation remain provider-free; query semantics
and semantic correspondence are supplied by explicit producers or a prepared
cache. Query embedding is prepared outside the snapshot and is not that guarantee.
Discovery pages current source records and published source interpretations beyond a single
16-row descriptor page, records the eligible population, visited pages, candidate
prefix and open residuals, and does not treat query hints as semantic membership.
Absent or unadmitted query semantics retains the unchanged original question for
raw-source access. Preparation and delivery expose one admitted/unavailable semantic
status with a reason; unavailable semantics cannot produce a conditional proof.
Malformed public semantic objects still fail schema admission, and access,
scope, source-currentness, lease and continuation guards remain in force.
`prepare_query` and library `recall` share Core's `source-semantic-access` owner.
The `query-conditioned-v1` policy scores original query against observed source
text, then uses independently verified query/source predicate readings to break
access ties. `canonical-v1` is the explicit diagnostic control over the same
metered observations. Both order the whole observed pool before descriptor pages
or native correspondence opportunities. Scores are lexical access signals; role
and modality foils may tie or outrank a relevant interpretation without acquiring
assertion authority. A source without an interpretation remains a raw candidate.
Before interpretation verification, the query-conditioned policy nominates up
to 16 inspected capsule candidates across the existing Porter/trigram FTS lanes.
Quoted navigation tokens use the original query for that original-first pass; a
distinct hint does not replace those original tokens. Seeks are resumable
ascending native rowid seeks and
bounded capsule metadata point reads, without BM25, body reads or a SQL sorter.
The exact signed-64-bit cursors bind workspace and query. Empty seeks and all
metadata/filter attempts count against the same observation ledger, including
inactive or cross-workspace matches. Native work counts logical indexed
operations and returned bytes, not SQLite posting comparisons, physical I/O or
CPU. SQL failures remain unavailable. That capsule path adds no index or model
field.

Separately, unscoped query-conditioned `prepare_query` / library `recall` may run
one snapshot-owned `source-index-interleaved-prefix.v1` join: bounded BM25 lexical
rows and inspected vector windows (`ranking: exact_over_inspected_subset`, not
full-library nearest neighbor). This Source-index pass nominates at most 16 roots;
canonical observation is separate, so this is not a total candidate-union ceiling.
Query embedding is `SourceIndexAcquisition.prepareQuery` under
`beforeSnapshotPreparation`, before the caller-owned read snapshot. The parent
prepares original navigation first, then a distinct `access_hint` as
`supplemental_navigation`, capturing both texts and the selected configuration
before the first bind; both routes share one bind promise. A begun snapshot
reports `snapshot_already_begun` without inference, replacement or commit; an
unwired binder is `embedding_preparation_unwired`. Those unavailable receipts may
still occupy both original and supplemental slots. Prepared vectors and selected
profiles stay on the private worker `prepared_query` envelope
(`conditionalField.sourceSemantics`); public MCP/CLI payloads cannot supply them,
and a private route receipt cannot nest another supplemental. Compact
`observation` is `null` when unmeasured, never zeros; a measured slot is
`[work, memory_bytes, native_bytes]`. `sourceSemanticAccessPhases` restores
`sql_internal_work: unknown` and the fixed `phase_accounting` literals
`completion: included_in_worker_work_not_separately_measured`,
`native_cpu: unknown`, and `deadline: soft_quarantine_until_exit`; those fields
are not retained on the receipt. Soft worker deadlines bound caller latency; a
quarantined slot stays owned until actual exit. Packing, expansion and pool-identity
traversal charge the request ledger without refunds. Native resource accounting
stays truthful and request budgets are not increased; holding a
canonical-observation quote does not prove that every previous envelope still
fits. Source-index query and backfill mechanisms exist. A private daemon
Source-index producer is wired into background start/stop and is separate from
Garden `EMBEDDING_BACKFILL`; it is not an MCP surface. Local model artifacts must
already be provisioned; this wiring does not download them. Mechanism-level
cached-model checks do not establish default useful recall or natural-corpus effects. Configuration absence uses `SourceIndexLifecycle.unbind`, not
build failure: it retires generations, clears active eligibility and advances the
selection revision to fence old work. Query preparation requires an eligible active
generation. Producer stop/deadlines end local waiting without cancelling shared
inference; native occupancy remains owned until settlement or provider close.

Access progressively interleaves source-text observation, bounded header pages
through the existing capsule cursor index, and whole interpretation verification
within one observation envelope. Inactive header rows are charged as well. Each
new source observation contributes its digest hint once to the request-local Core
policy; duplicate digests retain the best signal under the same comparison owner.
Within the observed headers, the query-conditioned policy alternates lexical
nomination/source-text hint priority with cursor exploration, deduplicating
capsule identities. Exploration retains its own chronological arrival sequence;
consuming a pair removes identities from both arrival queues without feeding the
priority order back into either queue. A pending lexical nominee encountered by
the chronological reader also occupies that cursor position, while a previously
consumed identity cannot be reintroduced. Each side advances past already selected
identities before alternating. A capsule source hash only hints at scheduling; missing or wrong
hashes and reading-only matches remain reachable. The canonical control verifies
in cursor order. Each scheduled body is loaded and decoded once by the
verification owner, which checks its derived capsule identity and authoritative
current source, version, scope and location. Verification may discover a current
source beyond the bounded census; its verified record and already-read complete
body join the observation, avoiding a second raw-source read. Unvisited census
residuals stay open. Lexical nominations do not establish semantic correspondence;
sources without a matching stored lexical signal still depend on ordinary
source/header exploration. Before freezing the whole observed
pool, interpretation source scores reconcile against the final source observations
by verified record identity. Descriptor delivery independently rechecks currentness.
Unverified headers remain an open residual; only verified interpretations enter
the observed pool and its final access order. Header reads, association, scheduling,
decoding and verification use the existing ledger and phase reserves. Bounded
membership may change with the implementation; the pool identity binds actual
observations and prepared benchmark plans also pin the implementation revision.

The access receipt retains identities, cached scores, source byte extents,
compact `phases`, and open residuals, without duplicating interpretation bodies
or expanded preparation/acquisition/`phase_accounting` fields. `pool_id` hashes
the expanded preimage independently of that retained compact form. Identity hashing
streams canonical scalars through the shared hash owner; it does not retain an
additional expanded tree or enclosing JSON string. Phase expansion charges new
container/reference frames while borrowing immutable scalar strings. Encoding
charges traversal, ordering, scalar JSON and UTF-8 handoff allocations. Native
acquisition wrappers pack owner-produced data directly, validating forwarded
repository/binder leaves before issuing leases; wire ingress still captures the
complete semantic schema. Execution reserves price its actual tuple construction,
not another deep copy of already-owned phases. It reports the total
observed source and interpretation counts separately from rows omitted from the
current trace. Preparation continuation pages at most 16 source trace rows and
16 interpretation descriptors; their offsets refer to the same frozen pool.
Trace-only source pages make no native reads or scoring calls and do not reopen
an already complete census. Library delivery includes only examined interpretation
and returned-source trace rows. Unvisited observations remain open regardless of
how many trace pages have been displayed. Query/page/library
leases retain the full compact observed pool and its order. The pool binds query,
policy, budget, scope and database revision; continuation cannot rescan or reorder
it, and query-handle recall uses all bound candidates beyond the first descriptor
page. Source reads, metadata and interpretation decoding, verification, query
normalization, scoring, ordering and retention consume the request ledger.
The observation envelope leaves outer request capacity for descriptor/lease or
library finalization. Source reads and whole interpretation verification do not
resume after exhaustion; an unread body tail or budget-limited pool remains open,
and frozen continuation does not resume observation. These are conservative logical
charges, not a wall-clock guarantee or an RSS bound.
Only an initial native `prepare_query` whose navigation and first unfiltered
chronological header page conclusively find no capsules may promote its source
observation allowance. It first reserves bounded receipt, ordering, trace and
lease completion, including source-only continuation feasibility, and retains
the already-spent census/header cost; an unfunded completion reports resource
exhaustion. Inactive, filtered, unavailable and truncated populations keep the
ordinary observation envelope. The shared access input identity includes the
`empty-interpretation-reserve-v1` resource contract so frozen pools cannot cross
allocation semantics; continuation and direct Recall behavior remain unchanged.
Compatible source interpretation, query semantics, and semantic correspondence compile independently through the existing field; there is no
cross-interpretation join. Each local reader enumerates that prepared premise
population. Its exhaustion closes only that domain, not unobserved sources or
alternative language interpretations. Source-local H does not itself require all
future reasoning to remain source-local; cross-source reasoning would need a
separate explicit identity and joint-rule contract. Current input coverage keeps
compatibility and distinctness unknown. Native delivery selects at most five source roots
(`source_gold_root_identity`) after reserving their complete support packages.
It prefers a qualified direct answer, then uncovered original-query evidence inputs,
then additional qualified local witnesses with unknown cross-source identity, and
finally raw sources in the native access order. A bounded one-root exchange repairs
overlapping greedy coverage when the complete replacement page fits. Bounded
final-proof deferral still uses that existing selector: it prices a tentative
later page against the actual current-execution envelope after a real earlier
page fits, never refunds failed work, and adds no relevance, proof authority or
recall gain. This is not a global optimum or a distinct-person count. These lexicographic preferences are a
ranking policy whose recall utility requires paired evidence. Candidate coverage
is not joint answer sufficiency. Canonical order remains a diagnostic
control and tie-break. Proof-bearing slots
keep source-interpretation, query-semantics, semantic-correspondence, and conditional-computation closure. Delivery and first-exposure `object_kind` is
`semantic_proof` on those slots and `source_evidence` on a source excerpt
without a closed proof. Mixed Any@K joins only `object_kind: source_evidence`;
proof-conditioned Any@K joins closed proof ranks; the two metrics must not
collapse. A source excerpt without a closed proof is source evidence, not
assertion truth or source-interpretation or semantic-correspondence success. Over-budget proof-bearing conclusions are
omitted rather than delivered after stripping assumptions. First exposure is the
initial membership page recorded by the existing `FirstExposureSession` owner.
This path does not replace ordinary `soul.recall`.
Library continuations transfer the already frozen page/witness plan without
source observation, solver replay or re-selection. Ordinary field continuation
has a separate contract. Raw-source entries derive eligibility from current
source/version/authorization and delivery owners, without semantic proof membership.

The separately named source-bearing union metric scores the same initial occupied
slots across source evidence and validated semantic proofs. The entire delivered
slot sequence must bind to the native index before either source or proof
scoring: count, order, kinds and product coordinates must match the native delivery
owner. Protocol owns the complete delivery identity: protocol 8, library v6,
membership purpose and the five-slot page budget. Worker and public readers derive
from it; a public outcome-only response contains no partial delivery fields and
is unavailable for measurement. Unknown/obsolete delivery versions are invalid.
Explicit offline source-only v1 readmission retains the original index, query and
first-exposure identities while deriving all other delivery checks from that same
contract; it is never a fallback in the current reader.
An inconsistent page is invalid, distinct from a consistent slot whose proof
remains unverified. A proof must also bind its
source record to the independently verified native snapshot publication, including
root, workspace, version, digest and known scope; a self-consistent copied proof
record is insufficient. Admission reuses the native execution and projection owners
to reproduce the accepting binding, selected alternative, returned coordinates and
explanation witness. Each proof verification has a separate explicit budget bounded
by the admitted native request budget, including retained proof and replay costs;
the standalone Core helper defaults to the Core execution budget. Exhaustion leaves
a proof unverified. Without another validated hit, an unverified
gold proof within the cutoff makes the union unavailable, never a definitive miss.
Native unvisited sources or interpretations, truncated discovery, and unfinished
discovery or computation likewise keep a negative union outcome unavailable.
Observed source hits and independently validated proof hits remain hits. A complete
candidate pool split into frozen pages can still establish an initial-page miss;
pagination alone does not indicate unvisited work. Current delivered-slot measurement
v2 binds the native discovery and coverage observations and retains the pure
`delivered_slot_union` as a separate diagnostic. Semantic-chain measurement v2 and
source-only measurement v2 use the native-residual-aware union for their primary
outcome. Historical measurement records retain their original bytes and contracts.
One occupied root contributes once. This union does not
replace either earlier metric or certify complete answer support. Frozen comparisons
bind the summary, census, selected questions, preparation, publication, replay and
initial-exposure commitment, and reuse complete native response admission for budget
and provider-call evidence. Missing, corrupt or incomplete evidence retains the
frozen denominator as unknown; an incomplete source census cannot establish a miss.

One measurement admission validates each actual proof slot at most once and derives
both earlier metrics and the union from that assessment. Fresh archive readmission
binds independent publication records and repeats native admission; serialized
validated flags and proof ranks are not authority. Its returned `evaluator_usage`
records proof slots checked, work units and conservative logical allocation charges,
including unverified or exhausted attempts. These costs are separate from native
retrieval and the proof's original execution receipt; allocation sums are not RSS
or a peak-memory estimate. Semantic-chain measurement rows and frozen comparison
rows retain this fresh cost. Historical records without it remain missing, while
a newly evaluated source-only row has zero proof-verification cost. The frozen
source-only arm still requires zero published interpretations.

Bench orchestration also has an explicitly selected `longmemeval-native-semantic-v3`
arm. It freezes the complete original source census, retained interpretation cache
bytes and publication associations, query context/clock, workspace/scopes, native
delivery contract and resource policy. Its order declaration derives from Core's
native order, and measurement requires the delivered order to match that
freeze. Native measurement uses `longmemeval-native-semantic-measurement-v3`;
historical artifacts retain their original declarations. Existing publication and
generic semantic-chain owners perform preparation, snapshot reopen, discovery,
correspondence receive, public recall and initial exposure.
The opt-in Bench task consumer API in
[`semantic-chain/consumer`](../../apps/bench-runner/src/runs/semantic-chain/consumer/input.ts)
admits one retained native replay before preparing the exact original question,
question clock and complete public recall envelope. Archive-only source bodies,
gold and evaluator reviews are not consumer inputs. An independently selected
question-only control withholds the envelope explicitly. Its fixed generic
instruction permits supported partial or unresolved answers and preserves source
qualifications; it carries no task-specific answer oracle.
`pinSemanticChainConsumerAuthority` binds the current implementation, native
replay and request identities, quote and a separate execution root. The existing
provider-request owner also supplies the effective deadline retained in preparation,
authority and the run report: the output-token-derived timeout with a 900,000 ms
interactive floor. Callers cannot replace this derived deadline in retained scope.
The existing write lease, attempt ledger and provider-request pipeline own execution: at most
one attempt per selected arm, with retained native HTTP/raw evidence and no
automatic retry. `executeSemanticChainConsumer` in recovery mode only settles
retained evidence. A reserved attempt without raw remains unknown, and completed
reinvocation cannot dispatch again. A `complete_response` establishes physical
completion and answer-schema validity only. The answer's `task_completion` is a
fallible consumer claim; fidelity remains unassessed. This API neither publishes
memory nor establishes cross-task utility or benchmark acceptance.
`prepareOrdinaryRecallConsumer` also admits a selected, trusted local
`ordinary-recall-local-capture-v1` archive. It binds the prepared operator,
episode and call reservations, physical MCP request/reply transcript, trusted
handler context, source snapshot, first-exposure receipts and closed process.
The current Protocol 17.0.0 reader accepts producer packages 14.1.0, 15.0.0,
16.0.0 and 17.0.0 with `conditional-field-source-only-v1` semantics. The
semantic-library capacity and query-schema changes leave this public source-only contract
unchanged. Producer provenance
remains immutable and separate from the current
verification and consumer execution revisions. Arbitrary ancestor commits and
caller-authored replacement envelopes do not establish this compatibility.
The consumer receives the original question and ordered public envelopes,
including a successful prefix followed by a terminal public error. Complete
source delivery, partial delivery, failed exposure and an unclosed/unknown
observation remain distinct. Authority requires a closed capture and successful
source exposure; optional internal execution diagnostics may remain unobserved.
Nonzero process exits with retained shutdown evidence remain failed; forced or
signalled processes remain unknown even when public bytes and shutdown records
were retained. Both remain unclosed for consumer authority, while inspection
preserves any successful public prefix. Failed startup can retain a shutdown
record with no started daemon or public calls.
An unreturned public call may retain zero or one trusted handler context while
the outer observation principal remains unset. Inspection validates retained
contexts without inventing a public envelope or populating that summary.
Private snapshot reads verify emitted bytes and disclosures without supplying
hidden source material to the model. The existing consumer provider binding,
quote, separate output root, ledger and raw recovery own all subsequent effects.
Historical semantic-library consumer preparations retain their original shape.
An opt-in offline lazy-qualification stage records one native `prepare_query`
observation before any public recall and freezes the first ten distinct current
raw source records in access order, or fewer when the pool is smaller. It keeps
the complete source census and emits only selected, owned cache misses for the
existing extraction authority; failed, pending, unknown, unsupported, invalid and
incompletely observed states are not misses. An open or resource-limited first
observation retains its fixed prefix and residual without replacing a source.
For retained native sources, the request inventory assigns each exact source
occurrence to its H key. Identical text with different role or attribution can
require distinct keys; multiple exact occurrences can share one key. Ready empty
sources retain their deterministic key, while unsupported sources have none.
Recovery reuses the source-record timestamp contract and preserves event and
recorded time strings, including minute precision, through the frozen window
and final publication. Unknown event time remains null. Final H child classification uses the same role,
attribution and generation proposal reconstruction as cache admission.
Finalization publishes the full census to a distinct sealed
SQLite snapshot. Newly admitted interpretations may bind only the frozen
source/version window; compatible associations that predate it remain available
outside the window. It re-prepares the query and correspondence workset under
the final revision, then permits one retained first public exposure through the
existing native selector and proof path. The delivered five may include raw
sources outside the qualification window, and some interpreted window members
may remain undelivered; neither changes the frozen extraction scope. Both native
pool receipts, selected attempt counts, producer usage and separate host work
are retained. Attempt counts come from durable reservations; newly received raw
bytes, pre-window pending work and unresolved usage are separate. A copied ledger
lineage without unique call provenance remains unknown. A durable native replay
can complete an interrupted stage wrapper under the frozen identity; a reserved
native row with no durable outcome cannot be re-exposed. This stage does not
alter ordinary recall defaults or scoring.
The current plan
requires an explicit Protocol access policy in the frozen configuration and forwards it unchanged during preparation
and replay. The native arm pins `query-conditioned-v1`; the source-only arm pins
`canonical-v1`. Historical source-only artifacts keep their explicit offline
readmission owner; the current chain reader does not fall back to an older plan.
For an offline single-question LongMemEval native freeze, the lazy binder admits
the original complete source census, initial question publication and settled query,
and the full retained Step source preflight before constructing the existing lazy
config. Its isolated evaluator joins gold only for an admitted durable first
exposure and writes outside producer and cache roots. A sealed final stage with no
durable first exposure remains one selected answerable unknown, distinguishing an
unreserved exposure from an unresolved native or stage reservation, with no recall or
gold join. A verified positive source hit survives partial answer-session mapping;
only a negative requires complete mapping. Unselected development questions remain
in the inventory but are not scored, and this bridge does not authorize a formal arm.
For fixed development20 and reused-readiness50 lazy populations, Bench freezes the
ordered metadata membership, existing selection contract, explicit prior exposure,
per-member native config identity, resource references and physically separate
producer/evaluator roots before running a named member. It does not load the dataset
or grant extraction at population freeze. Each member advances through the existing
single-question native stages; no population command fills a provider cache. A
durable cutoff captures stage, first-exposure and Q/H/C attempt references before
isolated scoring. The population result keeps every frozen answerable member in
H/M/U, including an early failure or unknown effect, while abstention remains
separate. Only a readmitted durable first exposure uses the existing lazy gold
join and metric. Native reservations and raw usage are projected per physical root
and reserved ordinal, so a copied continuation or shared cache attempt is counted
once in the observed scope. Missing scopes or usage keep the population total
unknown, and this development result does not authorize a formal arm.
Each query gets its own bounded native
candidate opportunity; one combined proposal workset uses the existing authority
and attempt ledger for global spend. Preparation retains the native access receipt
and stops once all observed interpretation descriptors have been received. A source
trace continuation alone is not another correspondence opportunity or an open
census: the receipt's offsets and omitted counts preserve the undisplayed rows.
Actual unvisited interpretations retain an unknown count; observed descriptors left
behind a page cap remain separately visible in the receipt and keep discovery open.
Replay restores the sealed snapshot and repeats the same native preparation before
immediately consuming its latest query handle. It compares the frozen descriptors
and every observed access-receipt field except the connection-local `pool_id`;
the recalled page must then bind that fresh preparation's exact pool ID. This is
replay verification under the existing snapshot and implementation guards, not
a general cross-library pool equivalence rule. Unavailable preparation, an absent
handle and an observed pool mismatch remain distinct unavailable reasons.
The repeated preparation's trace/work and elapsed time are recorded separately;
total native elapsed time includes it. Matching a capped observed prefix does not
close an unvisited residual or enlarge the frozen candidate opportunity.
Every indexed public delivery carries a Core-derived `request_identity` over the
resolved original query, admitted query semantics, semantic correspondences,
workspace, clock, authorized scopes, any prepared source restriction, access policy
and resource/output limits.
Process-local handles are excluded; continuation leases retain their separate
request-capability identity. The existing native delivery-ID owner commits that
resolved request identity together with the index; the first-exposure record must
match this delivery. Archive measurement and withdrawal share one
readmission entry: it verifies current frozen query/correspondence cache state,
exact retained row and first-exposure reservation, request identity, and native
preparation trace before using a response. It also rechecks delivered source roots,
bodies, currentness and scope against the sealed SQLite snapshot. Blocked or
unavailable rows cannot contribute a delivery. Invalid rows remain unavailable
with the eligible denominator intact; a coherent page from another request does
not become a hit by receiving a new archive envelope.
Missing interpretations never delete sources,
and unavailable queries remain in the measurement denominator. Validated delivered
proofs establish engineering mechanism exercise only. This arm changes neither
native selection policy nor ordinary recall defaults.

Current-source access selects the greatest exact UTC instant, then record identity,
before checking body retention or authorized scope. Protocol's UTC order key preserves
minute precision and every admitted fractional digit; SQLite's expression index is
the mechanical access path over the existing source records, including erased rows.
Per-source lookups and source-ID keyset seeks skip obsolete versions without a
second current-source table. Discovery visits at most 512 distinct source IDs using
one-row indexed pages and retains the independently current, authorized prefix.
Budget exhaustion, unavailable data and unvisited sources remain open/truncated;
they cannot establish a complete census or resurrect an older revision.
Source-interpretation candidate diagnostics include only
authorized current sources. Library continuation leases bind the first clock,
request budget, caller/session, scope and database revision; changing any bound
input requires a fresh request. The lease freezes selected pages, complete witness
packages and source windows; continuation neither re-executes nor re-selects them.
The public request uses the same versioned continuation schema. Exhaustion while
planning later pages preserves reserved slots and leaves the unplanned remainder
open; it does not promise a cursor over every observed source.
An unfit proof package can yield a lawful source-only candidate before selection.
Later encoding cannot demote a selected proof or clip its necessary support.
Public payload coverage and index payload completeness both report shortened
or unavailable previews. Raw-source preview allocation reserves each potential occupied slot,
using the existing default Recall token
estimator rather than a UTF-16 character count. Estimates are not measured model
tokens; the complete encoded response still obeys the independent hard UTF-8 byte
limit. Truncation preserves complete source characters. A hydrated empty source
is distinct from unavailable text, and omission markers retain their actual token
estimate even when a caller supplies too little preview allowance. A prefix is
not certification that the source's supporting assertion or scope was delivered.

Core's `sourceSemanticSupportWindow` prepares an atomic contiguous UTF-8 interval
from already verified source locations and source handles supplied by a selected
proof's origin owner. It reuses Protocol accounting's evidence reachability,
including represented governing context and related gap support. Availability
is relative to that admitted interpretation; an omitted language qualifier
remains a fidelity issue. Unknown dependencies, missing locations, display limits
and processing exhaustion stay distinct. Missing locations permit a complete
retained-source fallback only within the same display and resource limits;
window availability does not imply the original source is complete. This owner
feeds native package selection and the public encoder. Dependencies come from
the executed binding closures and observation origins, never returned-value text
or the consumed-leaf summary. Baseline packaging offers each independently executed
proof intact and, when its source window fits, one combined package. After all
roots' baseline packages are prepared, the same producer may add one source-only
hull per root when every executed branch has an exact located support window and
the complete hull fits 4096 bytes. Missing locations, whole-source fallbacks,
interrupted enumeration and oversized hulls do not produce this alternative.
It reuses the hydrated window, preserves the admitted source tuple, and carries
unknown source qualification without proof metadata; interstitial text is not
additional proof support. Optional materialization is metered, and exhaustion
retains constructed baseline packages while reporting incomplete preparation.
This expands the candidate set, not O1 or root occupancy; it does not promise
unchanged selected content or total selection cost. It does not add independent
lexical/vector localization or arbitrary-tail source reads.
After reserving all baseline pages, default library delivery may use the remaining selection ledger
to consider same-root pairs whose execution-owned evidence inputs complement each
other. Pairs reuse an already hydrated combined window of at most 4096 bytes; they
do not narrow, clip, or re-execute either proof. Only a strict improvement under
the existing input-coverage selector with an exactly fitting public envelope can
replace a reserved package. Page roots, order, counts and offsets stay unchanged;
optional-search exhaustion preserves every reserved page. Source-access ordering
and explicitly selected experimental selectors do not run this improvement.
This bounded search neither enumerates arbitrary proof subsets nor promises all
pairs, pairs without a fitting combined source window, or globally optimal coverage.
An oversized proof does not suppress an independently deliverable proof from the
same source. The existing selector reserves one package per root, so same-root
alternatives are not promised on later pages. All delivered bindings for a root
share one contiguous window covering the selected complete computations' represented
dependencies. Verification re-executes each exact Q/H/C computation: selecting
fewer bindings cannot shrink its required extent, and an indispensable AND proof
that exceeds the window remains undeliverable. Delivery spans leave the original
execution target and proof identities intact; verification compares complete root
identity and checks that the span contains the same required locations. It does
not independently certify source text absent from the evaluator's trusted inputs.

Measurement retains requested budget separately from the fixed five-slot
page policy and requires the delivered source-interpretation, query-semantics, semantic-correspondence, and conditional-computation package and closed proof graph for
proof-conditioned scoring; source retrieval remains independently scoreable.

Results expose actual accepting bindings and returned variables, per-answer
explanation roots, the existing derivation forest, and exact observation-to-leaf
attribution. `consumed_leaves` is only a summary, not a replacement for the proof
forest. A source or query gap is not filled by a structural match. In particular,
query gaps retain `query_complete=false`; fixed conditional-computation completion does
not certify source-interpretation, query-semantics, or semantic-correspondence fidelity or exhaust possible interpretations.

Query-semantics gaps use query-owned support: each gap carries at least one
`{kind:"query_text",excerpt}` copied from the original question. Core checks those
excerpts and the query schema checks affected variable, frame or domain handles.
Source-interpretation mention handles cannot locate a query-semantics gap because query semantics has no source-interpretation mention catalog.
Legacy nonempty query-semantics gaps using source-interpretation support or empty support are invalid; they are not
silently upgraded. Queries with no gaps retain their canonical bytes and identity.

For interpreted producer responses, source-interpretation draft gaps and query-semantics body gaps own the
executable qualifiers. `outcome.gaps` must echo that body's gaps exactly;
disagreement is invalid rather than repaired or silently discarded. Semantic correspondence has no
gap channel, so an interpreted semantic correspondence requires empty outcome gaps. Partial source interpretation and query semantics
remain valid with matching, structurally valid gaps. Protocol owns this binding
rule and bounded validation diagnostics; raw response identity remains intact.
SOUL `proposeQuerySemantics` and `proposeCorrespondenceSemantics` expose the native
`system_prompt` beside the strict request body. Without an injected response,
they prepare these inputs with `unexercised` and zero provider attempts. With
an injected response, the same preparation metadata accompanies success or
failure. Preparation does not dispatch a provider or admit model fidelity.

Work, logical memory, native I/O and process RSS remain separately labeled.
Preparation, compilation, solving, projection and proof materialization share
remaining budgets. Incomplete observation/solver/index/proof or a page/output
cap must not become complete-empty. When the output cap cannot retain proof and
qualifiers, conclusions are removed rather than delivered without assumptions.
The generic evidence-capsule text-size bound still applies before durable source-interpretation
publication; successful source parsing alone does not establish publication.

A nonempty source with no executable proposition may carry a located, unreviewed
`no_executable_proposition` disposition. It is distinct from abstention,
no eligible source, an admitted source whose current body is `unavailable`,
invalid output, transport failure and unexercised work.
Batch retains the request-bound raw response; MCP can return the source-bound
disposition without minting an empty source interpretation or a memory object. The host operations
remain provider-free. Authored/native regressions establish engineering
behavior, not real-model extraction quality or benchmark utility.

Proposal workset v3 freezes the normalized provider endpoint. Preflight/authority
v5, cache v3 and proposal raw-attempt v1 bind the resolved transport and exact
HTTP request, including schema guidance and thinking settings. Fill checks the
actual config before reserving an attempt. Source-extraction raw-attempt v2 is
unchanged. Historical proposal bytes are retained, never relabeled or reused as
current evidence. Reissuing a receipt resumes the stable execution lineage in
the same cache; timestamps and companion keys do not renew request opportunities.
Existing ledger census and ceiling mismatches fail closed. A different attempt
cannot settle an unresolved reservation; legacy lineages require explicit settled
continuation before using the same cache. This repair does not grant new budget.

Provider-request and interactive source recovery derive HTTP retry eligibility
from the retained status through the engine gateway policy: 429 and 5xx may use
remaining authorized attempts; other HTTP statuses, including 401 and 403, are
terminal. Retained `failure_retryable=false` remains closed. A historical true
flag cannot override terminal physical status, including at transport-continuation
admission. Recovery preserves the original raw bytes and settled classification;
it does not repair history or grant another attempt. Missing raw remains unknown,
aborted and completed parse/schema failures remain terminal, and existing bounded
retry treatment of timeout, network and response-body transport failures is unchanged.

Native chat query revision worksets may name a `retained_parent` on each revised
item when only the original system guidance changed. The bench parent resolver requires
the same canonical request, response schema, model, profile, route and output
cap to reproduce that parent's retained key and exact wire digest. Native
shard, raw-response and reservation readers then verify its complete settled
physical response. The reference is lookup context, not evidence of success;
it remains in the child workset and in the evaluator input exclusion inventory.
The isolated child uses current guidance and its own request identity. Without
an explicit reference, revision preparation retains same-generation lookup.
Gemini's projected schema does not establish full-schema equality from wire
identity and therefore does not support this explicit historical reference.
Historical output is revision context, never relabeled current producer output.

Proposal publication verifies retained bytes and their exact reserved ordinal/key
before writing a shard. Offline preparation and chain readers also require raw,
reservation, and successful-admission closure; parsing a shard alone never makes
it executable. Shared attempt-ledger v5 retains an additive `settled_attempts`
history on settlement. Historical records without that field keep their identity;
aggregate counts cannot supply missing settled ownership. Existing unresolved
reservations can still recover through explicit fill. Reads never settle them:
no raw is `unknown`, retained but unsettled output is `pending`, and neither is
unattempted or a terminal failure. Completed incomplete output, rejected output,
transport failure, abstention, and interpreted output remain distinct. Missing
usage is accounting uncertainty and does not make completed output unknown.

Contradictory native-chat reported usage is completed accounting-invalid output,
never pending or ordinary absent usage. The exact settlement keeps the original
reported-value digest and an additive invalid-accounting marker; trusted token
totals exclude those values. Aggregate unavailable/unknown metering includes
invalid attempts, with a separate invalid subtype. Recovery verifies the marker
against immutable raw, profile and authorized output cap, and cannot admit or
redispatch the rejected attempt. Marker-absent historical ledger digests remain
unchanged. Full-evidence HTTP readers cancel at their finite received-byte bound;
retained incomplete prefixes cannot establish successful completion.

Source Interpretation interactive recovery and both proposal producers share the
raw/reservation outcome check before publication. Retained output cannot
contradict an already settled transport failure. Source admission rejection of
a completed response is bound to that response's digest and remains replayable
as quarantine; its settled rejection is not reopened by changed completion
metadata or a new admission attempt. It does not imply a failed HTTP response.
Live source output uses the same retained-raw path as recovery.
