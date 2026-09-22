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
id. Query compilation preserves supported ordinary-language meaning
and exposes interpretation holes. Missing knowledge is not a zero association
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
Catalog preparation is capped at 64 assertions, 65,536 UTF-16 code units and
32,768 segments, with a 1 MB new-request envelope limit. The Protocol segment
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
Cache admission, audited publication, and semantic fidelity are distinct gates. This is an additive qualified result
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


## Opt-in open source semantics

The `soul.interpretation` channel retains its source-local source interpretation, source-independent
query semantics, explicit semantic correspondence, and selected conditional computation. It does not replace ordinary `soul.recall` or
Garden v1. Protocol 9.0.0 uses `source-interpretation-v4`, `source-semantic-query-v3`,
`source-semantic-correspondence-v3`, response envelope v5, reasoning v5, cache v3,
library v3, public/worker recall protocol 3, and `source-semantic-k-v3`,
`source-semantic-normalizer-v5` and `source-semantic-lowering-v6`. Each complete
source-frame group is a jointly constrained compile alternative; slots must not
float off that group's predicate frame. An older open source interpretation is not relabeled or silently promoted; recreate its interpretation explicitly.
The profile-bound source-interpretation-v2 route and its recorded bytes remain
separate regression contracts.

Query meaning v2 uses `conditions` for conjunction and optional
`evidence_inputs: [{conditions}]` for the facts needed by the original requested
operation. Query request/response v4 use the same recursive meaning schema as
local receive admission; depth and byte limits remain local requirements. Nested
`forall` is rejected; explicit top-level universal evaluation remains supported.
The host derives original-Q frame views and execution groups. A view retains
governing context and sibling operands. It never introduces another Q or A identity.
Direct answer conditions preserve every original restriction even when inputs
are also declared. An unrepresented answer relation remains explicit.

Reasoning `binding_results` distinguish `answer` from `evidence`; evidence
always has `query_complete: false`. Both use the same execution, projection and
proof verifier. Each occupied source root retains all delivered binding witnesses
and their required explanation forests. `semantic_proof` means verified conditional
evidence, not necessarily a complete answer. The shared query-support projection
reports original-answer and per-input coverage. It never performs the requested
operation, joins identities across sources, or infers distinctness from local IDs
or equal names. Incomplete execution phases remain resource-exhausted/partial.
Archive-only source-evidence protocol 1/library v1 retains its recorded identities,
page and order through the offline admission owner.

New source-interpretation extraction uses the producer-only `source-semantic-proposal-v4` contract
with `host-owned-expression-schema-v1` at canonical domination depth 16. Optional
quantified and measurement fields remain in that recorded projection; omit empty
tables when the source does not support them. The producer owns predicate/role
readings, co-reference, semantic scope, speech acts, domain membership/closure
and measurement context. Compact catalog anchors and inline mentions are enough
for an unreused local referent. A compact source-proposal alias is required only for
co-reference, an occurrence reference, same-parent reuse, or a quantifier
binding. Source-label equality is not identity. Nested expressions remain the
scope owner; the host does not reconstruct lost scope from English labels or map
a missing act to assertion. Protocol assigns canonical IDs and compiles mentions,
slot/binding pairs, reciprocal context owners, assertion membership, quantifier
binders and canonical outcome gaps. A plain occurrence reference does not embed
its target. Unowned or conflicting scopes are rejected; the compiler never
guesses assertion permission, pronoun antecedents or domain facts. Compilation
and normalization share one resource ledger. Structural admission and located
gaps cannot certify language completeness. The canonical source interpretation and response-envelope
shapes remain unchanged. Recorded v1/v2/v3 proposals select their original
prompt/schema explicitly for replay. Marker-absent normalizer-v3 requests retain
an explicit historical replay path; new publication requires normalizer-v5.
Request/schema identities distinguish the producer wire. Canonical-envelope
archives retain native request/response replay with their original prompt. Their
normalizer-v3 manifests remain ineligible for current cache reuse; replay does
not upgrade or publish an old interpretation.

New compact expression requests bind `host-owned-expression-schema-v1`. Protocol
derives its generation schema from the same compact shapes, with shared acyclic
definitions spanning the canonical domination-depth limit. Recorded v3 requests
keep `bounded-expression-schema-v1` or the recursive decoder. SOUL selects the
schema for structured generation; reference validation and semantic admission
still run locally after host expansion into the unchanged compiler. Decoder
acceptance does not prove semantic fidelity or source coverage.
Recorded requests without this marker keep their original recursive schema.
Gemini decoding guidance has its own provider projection: those recursive schemas
use JSON mode without a decoder schema, while the complete source schema is
attached as system guidance. Local Protocol admission still requires all fields, expression
operands and arguments. Recursive Gemini cache identities include the source
schema, explicit absence of a decoder schema and exact appended guidance; acyclic
historical keys and transmitted bytes remain unchanged. Provider acceptance and
syntactic guidance do not certify language fidelity.

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

Open extraction may explicitly select `complete-source` packing. Its request
records that scope and binds all indexed units of the supplied source corpus
in order, including both message roles. SOUL checks this membership against the
original source on receipt. Existing catalog limits (64 units, bounded text and
segments) apply; oversize input fails preparation without implicit partitioning.
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

`soul.interpretation` `recall` is the opt-in library path shared by native callers
and the benchmark. Original query and authorized scope enter once. Host operations
remain provider-free; query semantics and semantic correspondence are supplied by explicit producers or a prepared
cache. Discovery pages current source records and published source interpretations beyond a single
16-row descriptor page, records the eligible population, visited pages, candidate
prefix and open residuals, and does not treat query hints as semantic membership.
`prepare_query` and library `recall` share Core's `source-semantic-access` owner.
The `query-conditioned-v1` policy scores original query against observed source
text, then uses independently verified query/source predicate readings to break
access ties. `canonical-v1` is the explicit diagnostic control over the same
metered observations. Both order the whole observed pool before descriptor pages
or native correspondence opportunities. Scores are lexical access signals; role
and modality foils may tie or outrank a relevant interpretation without acquiring
assertion authority. A source without an interpretation remains a raw candidate.
There is no query seek across unvisited sources or interpretation pages.

The access receipt retains identities, cached scores, source byte extents and
open residuals, without duplicating interpretation bodies. It reports the total
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
Observation leaves capacity for descriptor/lease or library finalization; an
unread body tail or budget-limited pool remains open. These are conservative
logical charges, not a wall-clock guarantee or an RSS bound.
Compatible source interpretation, query semantics, and semantic correspondence compile independently through the existing field; there is no
cross-interpretation join. Delivery uses canonical `sortIndexEntries` with source-root occupancy
(`source_gold_root_identity`) and a membership page of at most 10. Equal grades
use canonical identity ties; this is not learned relevance. Proof-bearing slots
keep source-interpretation, query-semantics, semantic-correspondence, and conditional-computation closure. Delivery and first-exposure `object_kind` is
`semantic_proof` on those slots and `source_evidence` on a source excerpt
without a closed proof. Mixed Any@K joins only `object_kind: source_evidence`;
proof-conditioned Any@K joins closed proof ranks; the two metrics must not
collapse. A source excerpt without a closed proof is source evidence, not
assertion truth or source-interpretation or semantic-correspondence success. Over-budget proof-bearing conclusions are
omitted rather than delivered after stripping assumptions. First exposure is the
initial membership page recorded by the existing `FirstExposureSession` owner.
This path does not replace ordinary `soul.recall`.

The separately named source-bearing union metric scores the same initial occupied
slots across source evidence and validated semantic proofs. The entire delivered
slot sequence must bind to the native index before either source or proof
scoring: count, order, kinds and product coordinates must match the native delivery
owner. Protocol owns the complete delivery identity: protocol 2, library v2,
membership purpose and the ten-slot page budget. Worker and public readers derive
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

Bench orchestration also has an explicitly selected `longmemeval-native-semantic-v1`
arm. It freezes the complete original source census, retained interpretation cache
bytes and publication associations, query context/clock, workspace/scopes, native
delivery contract and resource policy. Existing publication and generic semantic-chain
owners perform preparation, snapshot reopen, discovery, correspondence receive,
public recall and initial exposure. Plan v4 requires an explicit Protocol access
policy in the frozen configuration and forwards it unchanged during preparation
and replay. The native arm pins `query-conditioned-v1`; the source-only arm pins
`canonical-v1`. Historical source-only artifacts keep their explicit offline
readmission owner; the current chain reader does not fall back to an older plan.
Each query gets its own bounded native
candidate opportunity; one combined proposal workset uses the existing authority
and attempt ledger for global spend. Preparation retains the native access receipt
and stops once all observed interpretation descriptors have been received. A source
trace continuation alone is not another correspondence opportunity or an open
census: the receipt's offsets and omitted counts preserve the undisplayed rows.
Actual unvisited interpretations retain an unknown count; observed descriptors left
behind a page cap remain separately visible in the receipt and keep discovery open.
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
input requires a fresh request. Proof demotion preserves occupied positions.
Public payload coverage and index payload completeness both report shortened
or unavailable previews. Library preview allocation reserves each occupied slot
before redistributing unused allowance, using the existing default Recall token
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
window availability does not imply the original source is complete. This helper
is not yet connected to native selection or the public preview encoder.

Measurement retains requested budget separately from the fixed ten-slot
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
