# Changelog

All notable changes to Do-SOUL Alaya are recorded here. This file is
the chronological index. Historical per-release trees under
docs/archive were deleted on 2026-08-24 (commit 2b23da6f2).

Current recall algorithm is the sole current conditional-field route in
`docs/handbook/recall.md`. Do not treat a historical release section
below as the live ranking recipe.

## Unreleased — protocol 29.0.0, engine gateway 2.0.0

This section is **not a release tag**. App packages remain `0.3.11`
until a matching `## vX.Y.Z` section is opened. Do not tag `Unreleased`.
A GitHub release tag must match the latest published `## vX.Y.Z`
heading (currently `## v0.3.11` below). Protocol and engine gateway package
versions can move independently of the app semver.
`@do-soul/alaya-engine-gateway` is `2.0.0`; app packages remain `0.3.11`.

Protocol 29.0.0 scopes lexical BM25 statistics to each active generation, identified by
`ordinary-native-field.v6` (invariant §25 major), retaining the question-time preference
and factual capture-domain ranks introduced in Protocol 28. Restricted time queries use
the same generation-owned statistics, not a per-question corpus. SQLite 028 atomically
replaces shared projection FTS with generation-owned Unicode61 and raw-trigram domains;
foreign, preparing and retired generations no longer affect active scores. The explicit
raw fallback remains database-wide. The SourceIndex owner reclaims retired payloads,
postings and metadata in bounded resumable pages, without changing active order or
invalidating pinned WAL reads. Original source bytes and vectors are unchanged. Upgrade
clients and daemon together and start fresh queries. Retain a pre-028 database for an
older-binary rollback; current-binary raw selection prepares a new generation, not the
old statistics. Frozen historical benchmark snapshots remain untouched; comparisons
require a new native baseline, not relabeling old captures. Exact 27/v4 and 28/v5 archives
remain offline-readable only. No natural-data quality improvement is claimed.

Protocol 28.0.0 adds typed question-time preference and retires the ordinary English
failed-deployment demo compiler (invariant §25 major). `ordinary-native-field.v5`
orders original in-window roots, then time-restricted lexical candidates using the
existing lexical statistics, then native fallback. All routes share the existing
16-root/128-attempt allowance; preference can displace roots, never make them
ineligible. Public `since`/`until` remain hard filters. The narrow declared producer
binds closed UTC calendar-day alternatives to the original question and interpretation
clock; no language heuristic or provider call forms them during recall. Tests needing
semantic programs now supply declared proposals. Upgrade clients and daemon together
and restart queries; old continuations cannot execute v5. Frozen captures remain
unchanged. No data migration is required; rollback uses the prior binary with fresh
handles. Mechanism checks do not establish a natural-data quality gain.

Protocol 27.0.0 identifies complete-unit page deferral as `ordinary-native-field.v4`
(invariant §25 major). A source that would receive only a page-tail fragment remains
pending when its recorded message or line fits a fresh page. The projection owner
pays for the refused wider fit and commits a shorter membership prefix. Root order,
declared budgets and explicit payload offsets are unchanged; additional pages and
framing are not free. Oversized first units and sources without recorded boundaries
retain UTF-8 progress. Upgrade clients and daemon together and start fresh queries;
v3 continuations are incompatible. Frozen captures stay unchanged, and rollback
uses the prior binary with fresh handles. This delivery change needs no source or
index migration. Development measurements are not a production quality guarantee.

Native SourceIndex excludes newly created interpretation-provenance capsules by
persisted create-time role (SQLite 027), not by matching source hashes. Independent
capsules remain distinct roots even when they cite an admitted body's digest.
Historical capsules default to independent; no heuristic backfill or retroactive
role inference is performed.

Protocol 26.0.0 removes `parseSourceRefRobust`; `ALAYA_RECALL_SOURCE_REF_ROBUST` never gated behavior and is now a retired daemon env key (ignored with the retired-key warning).

Protocol 26.0.0 makes segmented lexical text (`segmented-unicode61.v1`, exported as
`SOURCE_INDEX_DEFAULT_LEXICAL_REPRESENTATION`) the default lexical representation
(invariant §25 major: ordinary lexical candidates and their ranking change). The idle
daemon prepares it for every workspace without an explicit lexical selection, independent
of embedding availability, sharing each pass allowance with vector work (neither takes
more than half first). Until a workspace's first segmented generation publishes, recall
keeps reading the raw index; it no longer reports `lexical_generation_unpublished`. A
new source epoch's generation copies the projections of roots whose key and content
digest are unchanged and analyzes only new or changed roots. An explicit selection, such
as a `raw-unicode61.v1` rollback, is honored and never overridden. Until the segmenter is
ready, readers use the raw index with raw query tokens; the two never mix. Upgrade the daemon and clients together; no source or index rewrite is
required, and old binaries need a retained pre-migration database copy only if the
schema fence applies.

Protocol 25.0.0 makes recorded-message vector windows the default for new embedding
bindings and delivers ordinary native roots from byte zero in document order
(invariant §25 major). Vector hit locations remain navigation witnesses, never
payload bounds; explicit proof-support ranges and payload continuations retain their
own coordinates. `ordinary-native-field.v3` and library field protocol 12 identify
the changed delivery. Upgrade clients and daemon together and start fresh queries;
old live handles and result identifiers cannot execute the new policy. Existing
profiles retain their identity; preparation selects a distinct generation before
serving the new default. Explicit `utf8-byte-windows.v1` remains a supported control
and rollback selection; retired generations are never revived by relabeling them.

Ordinary source hydration bytes are page-local: source previews are re-read on every
page, so their read bytes no longer carry into the retained field. Long roots no longer
exhaust the default request memory on later pages, which failed the page commit with
an internal error. Result identifiers and delivered intervals are unchanged.

Source delivery boundaries are read for the delivered window only: one unit (message
when the root records any, else line) and only its ends inside the hydrated span,
through a new `(workspace_id, record_id, purpose, end_offset)` index (migration 026).
Previously every span of the root was read on each hydration, so one long round could
spend ~190 KB of request memory for a 4 KB preview and stall a query for dozens of
empty interrupted pages. Retention checks before commit also count the page's
releasable hydration bytes. Delivered text and intervals are unchanged.

Lexical preparation always advances: a pass funds its first pending root's analysis
within `max_body_bytes`, so a root larger than one pass allowance no longer stalls the
generation (`lexical_no_progress`). Budget-limited passes report the generation they
actually advanced.

Protocol 24.0.0 funds ordinary native acquisition from its declared attempts, roots
and active-generation window allowance, independently of the field page budget
(invariant §25 major: ordinary membership and ranking can change). Acquisition runs
once per query and reports measured work, native bytes and time in the `acquire`
receipt phase. Retained nominations still consume field memory. Historical receipts
without `acquire` remain readable as unmeasured. Vector window caps remain partial
scans; scope, currentness and erasure guards still apply. Window representation and
payload anchoring defaults are unchanged in this step. Upgrade callers and daemon
together and start new queries; do not carry pre-upgrade continuations across it.

Protocol 23.2.0 added optional SourceIndex lexical selection/generation provenance to
acquisition tokenization and its compact tuple (invariant §25 minor). Explicit
`segmented-unicode61.v1` preparation uses the pinned native CJK segmenter, independent
of embedding profiles. Migration 025 adds separate search projections and bounded
resumable lexical generations; it performs no corpus/model work or default activation.
Original source bytes, raw trigram, default raw readers, vector generations and ordinary
ranking/delivery meanings remain unchanged. Selection changes withdraw prior lexical
eligibility until the matching generation publishes. Rollback selects and prepares
`raw-unicode61.v1` anew; older binaries require a retained pre-migration database copy
under the existing incompatible-schema fence. Failed/cold segmentation cannot publish
or serve the variant. This is not uniform CJK quality or natural-English efficacy evidence.

Protocol 23.1.0 adds the opt-in `recorded-message-windows.v1` SourceIndex profile
strategy (invariant §25 minor). The shared planner protects bounded complete recorded
messages, explicitly splits oversized/unstructured intervals, and rebalances the last
two windows at legal UTF-8 boundaries. Native inventory reads are bounded and charged;
Storage recomputes the same manifest from admitted facts. Actual prepared-token limits
remain enforced without truncation. Existing raw profiles/manifests and deployed defaults
are unchanged. Selecting the new profile creates a distinct generation and retires prior
eligibility; rollback selects raw anew, never revives a retired generation. No lexical,
ranking, delivery, natural-data efficacy or default-promotion change is claimed.

Protocol 22.1.0 added optional source-bound host-occurrence descriptors and the
non-discriminator `message` span purpose (invariant §25, minor). Core captures
ordered byte-bound host facts through trusted admission context or exactly retains
an existing inventory; SQLite migration 024 preserves it separately and erasure
scrubs its payload. Product reports remain excerpts, not authenticated authors or
complete upstream messages. Explicit complete-message captures alone derive message
spans. Ordinary delivery, legacy attribution, root speaker, model bytes and factor
formation semantics are unchanged; new source revisions still invalidate dependent
indexes and preparation state. Inventory reads are opt-in and separately bounded.

Protocol 23.0.0 changes ordinary source delivery under invariant §25 (major).
`ordinary-native-field.v2` and library field protocol 11 identify recorded-boundary
alignment; old identifiers never execute the new policy. Upgrade the daemon and
clients together, discard prior live continuation handles, and issue fresh queries.
Frozen captures retain their recorded identities; archive parsing does not authorize
execution or replay. Source/index data is not rewritten or re-embedded by this
cutover. Rollback requires the previous binary and fresh handles, not relabeling a
current result. See [delivery semantics](docs/handbook/recall.md#ordinary-native-field-delivery).

Protocol 22.0.0 expands native SourceIndex nomination to retained evidence-capsule
roots under invariant §25 (major). Capsule `source_id` is explicitly null;
SourceRecords retain their historical identifiers and governed-scope requirement.
Capsule indexing reuses the retained `excerpt ?? gist`, revision and digest owner.
Unrestricted field principals may observe capsules without invented scope; named
and denied principals cannot. SQLite migration 023 fences pre-expansion generations
and makes projection invalidation root-kind-aware. Existing model-independent
lifecycle preparation is required; cold storage does not become query-time ready.
No model downloads, provider work or query-time indexing are introduced.

Protocol 21.0.0 is the ordinary ranking/delivery migration **major** under
handbook invariant §25. `native_query` becomes the live ordinary default on the
public request and `QueryView`; historical `canonical` and `associative` stay
parseable with their recorded meaning but live execution refuses them instead of
substituting a ranking. Index entries and typed observations may carry a
`RecallNavigationWitnessSchema` (ordinal discovery: view, operator, ordinal,
access ordinal, native rank, optional byte location), which is not an association
grade, claim support, product identity or the historical enumeration value.
`QueryView` binds `delivery_context`/`delivery_budget`, and field pages report
`ordinary-native-field.v1`. Library recall uses
`SourceSemanticFieldLibraryDeliverySchema` (protocol 10): the same tagged field
page with same-order results, Q/H/C evidence only on source targets, and a
replayable field continuation. Legacy library v6 / protocol 8 and private
comparison v7 / protocol 9 readers remain for recorded artifacts; the live
library adapter cutover is not part of this contract change. The public MCP recall
request and the worker recall request both accept only the field continuation
family; a frozen v6 cursor stays readable inside its recorded delivery but is
refused at live ingress. The archived source-gold library measurement contract
refuses a protocol 10 page as an `invalid_response`, never scores it with its
source-gold rules, and preserves that refusal through replay and capture
admission instead of reporting an unavailable delivery. The frozen benchmark receipt
reader retains `query_preparation` when the execution declared it, including an
explicit unavailable/not_requested state, refuses a malformed one, and never
substitutes a counter for missing evidence. This is not a release,
default promotion, measurement or acceptance of every runtime path; the
`semver-surface` fixture is pinned at `21.0.0` with its new surface hash.

Protocol 20.1.0 adds optional paired-prefix Source representation descriptors
and explicit query/passage roles under invariant §25 (minor, additive). Core's
existing embedding contract accepts the descriptor and attests paired preparation.
Omission preserves raw profile IDs, raw vectors and source bytes. Paired profiles
require explicit roles and separate index generations; no automatic reindex,
model download, model-support expansion or default switch is included. App/Core
remain on the unreleased app version; Protocol owns the versioned profile schema.

Protocol 20.0.0 declares the separately versioned Source access/profile migration
as a **major** under handbook invariant §25. Access v3, compact acquisition 2,
expanded execution v4 and library v7 / protocol 9 have independent, correlated
schema admission and owner-bound input/request identities. A runtime-bound private
comparison now connects shared handler admission, preparation, worker affinity,
acquisition, native access order and frozen library delivery. Public request
policies and default access v2, compact acquisition 1, expanded execution v3 and
library v6 / protocol 8 retain their meanings and bytes. Old schemas serve that
current default, not a generic historical decoder. The bounded producer's full
retained occurrence witness binds the existing pool/snapshot identity independently
of its displayed 16-occurrence prefix. Private captures use the shared first-exposure
owner and explicit versioned admission, never fabricated MCP calls. This is not
measurement, default promotion or release; the temporary selector is removed on
comparison promotion or termination. App/root and gateway versions are unchanged. See [current compatibility and delivery](docs/handbook/recall.md#ordinary-native-field-delivery); this entry records historical migration, not a live comparison route.

Protocol 19.1.0 added the conflict-edge deletion audit type and expands the
EventLog payload envelope to an independent 8,388,608 serialized-character
budget. This is a **minor**, additive protocol change under handbook invariant
§25, not a release; app/root packages and engine gateway versions are unchanged.
The public-schema fixture now also covers streaming bodies, governance
resolutions, trust records, and EventLog envelopes. No text or reason field is
narrowed and audit is never truncated. Aggregate overflow is a typed storage
validation refusal; unbounded arrays cannot be promised to fit a finite budget.
See [Protocol compatibility](packages/protocol/README.md#eventlog-compatibility).

Protocol 19.0.0 and engine gateway 2.0.0 declared the Source acquisition,
phase-accounting, and SourceDisclosure compact-wire **major** under handbook
invariant §25. Protocol is now `20.1.0`; gateway remains `2.0.0`.
See the [current query contract](docs/handbook/recall.md#opt-in-open-source-semantics)
and [current Source disclosure](docs/handbook/recall.md#source-disclosure).

### Neutral source-recall ownership

Source catalog/access progression and exact delivery admission now have private
neutral owners; Core retains the existing ranking and selection policies. The
library adapter retains Q/H/C admission, computation, materialization and leases.
The extraction preserves current allocations, charges, auxiliary-header reads,
exact encodings and frozen continuation membership. It does not change ordinary
`soul.recall`, add a public contract, or calibrate resource budgets.

### Private recall measurement

Private recall measurement is a bench adapter, not a public diagnostic surface:
it adds no MCP response field and changes no recall policy. A bench-only startup
option selects the compiled daemon module so runtime construction and scope
lookup share one module identity; the binding itself is inert, and only an
explicit request-scoped job records request-correlated source-semantic worker
events and logical costs. The measurement owner captures library continuations
in the same first-exposure session and invokes ordinary `soul.recall` through
its actual public entry. Delivery capture keeps slot, interval and
first-exposure evidence for the single `consumer-message-visibility-v1` scorer
over frozen answer-turn labels instead of defining @K visibility itself.
Frozen-output attribution keeps missing, partial and unavailable evidence
explicit; diagnostic membership is not proof of visible text, and logical
accounting is not a physical resource measurement. Native facts now record the
session, request, pool, lease and plan ancestry of the objects that were
actually used, so equal request numbers or pool labels never join calls, and
ledger retention and canonical-scan annotations reconcile against recorded
charges while encoding annotations describe existing work without adding debits.
Meter counts and native spend are recorded independently of the capped
32-meter detail sample; initial, current capacity, adjustment, held and spent
values stay distinct. Optional final parent/sibling-phase allowance aggregates
continue beyond that sample, with explicit omissions and no global transferable
budget claim. Complete operation quantities continue past the bounded 128-row
detail sample; request-local weak repetition tracking admits up to 16,384 objects
per kind and preserves explicit partial evidence if exhausted. The
`longmemeval-observation-costs-v1` bench summary classifies debits through
exact owner-backed reasons or native operation annotations, keeps transfers and allowances out of spending,
and separates a missing historical witness (unknown, witnessed rows stay lower
bounds) from contradictory complete counters (invalid, no spent total).
Physical SQL, IPC and peak memory remain unmeasured, frozen frames are not
backfilled, and the record changes no logical charge, refund, ranking or budget
limit.
Frozen source-index and window qualification is a symbol-keyed capability on the
existing storage constructor: no package-root export, a caller-owned read
transaction, and unchanged recall when that capability is absent. Bench capture
reads the actual canonically restored session and its WAL, bound by the restore
owner to the original sealed input; foreign or expired handles are refused.
Legacy input files are never migrated in place or interpreted as empty indexes
when current-schema tables are absent. The shared scorer emits one row per mapped gold span,
and Consumer @10 closes an absence only on an observed ten-slot prefix or an
admitted index whose occupied tail is proven exhausted. Physical SQL work,
peak memory and causal policy benefit remain unestablished.

### Retained-boundary corrections

Inspector startup identifies its actual entry module on Windows and through
symlinks, rather than relying on a forward-slash filename suffix. The child
writes `inspector_ready` only after the loopback server is listening; a bind
failure rejects without that line. Crash-WAL
regressions retain committed-write evidence with platform-specific termination
checks; Windows coverage is not skipped.

Operator paths and local surfaces fail closed. `scripts/install.sh` and
`scripts/uninstall.sh` share one path-admission guard; uninstall refuses
`$HOME`, its ancestors, system paths and bare shared roots for each path it
may delete, and removes a contained symlink rather than following it. The
Inspector config page makes embedding, Garden provider/secret, and
agent-strategy affordances read-only; provider and secret changes use
`alaya install`, and `alaya inspect` forwards the configured reviewer
token/identity for bound proposal review. The daemon workspace engine-binding
probe reports that connection testing is unavailable and credentials were not
checked instead of returning a synthetic successful binding. Daemon shutdown
uses the HTTP close callback, drains tracked handlers before stopping
background services and closing SQLite, and aborts teardown on a close error
or timeout rather than treating the transport as closed.

History and benchmark boundaries no longer compare unlike evidence.
`latest-passing*.json` cannot advance for the public LongMemEval Oracle or M
splits because neither has an applicable release gate; their archives and
`latest-run*.json` pointers remain readable. `alaya-eval diff` selects the
newest earlier run in the same split, policy, report and embedding cohort,
refusing an incompatible baseline instead of comparing slug-adjacent runs.
`run-full-bench-v0311.mjs --resume` reuses a checkpoint only when it records
the same requested run identity and its archive still contains `kpi.json`; a
missing, legacy, or mismatched checkpoint exits 1 and starts no replacement
bench.

Durable transitions keep their audit and recovery ordering. A committed
budget-bankruptcy resolution and its proposal decision share one transaction
and are terminal; recovery repairs a stale pending projection without a
second event. Slot election composes claim lifecycle CAS transitions, the
winner-changed audit, and an expected-winner slot CAS in one transaction.
Conflict-edge deletion and orphan repair append
`soul.conflict_matrix_edge.deleted` and delete the batch in the same
transaction. Post-commit notification failure does not roll back a committed
mutation: lease/override caches invalidate instead of restoring a precommit
snapshot, and the failure is recorded as a propagation diagnostic.
Pending-proposal pages report `total_count` from the matching filter, not the
page length; `since` remains a created-at lower bound, not a backward cursor.
Extension registration commits descriptor audit, descriptor and tool-spec
changes atomically instead of compensating asynchronous writes. Janitor hot
demotion rolls back both updates and audit when a selected candidate changed.

Private daemon research acquisition, joint-delivery and qualified-selection
channels, and bench `semantic-chain` / `semantic-proposal` producer orchestration
have been removed. Native measurement now belongs to `runs/recall-measurement/`;
shared read-only request/cache identity belongs to `runs/semantic-cache/`.
The public source index and native Q/H/C contracts remain intact. Nominated-window
hydration remains explicitly retained but dormant, not a new production route.
This removal does not change ordinary recall ranking, budgets or algorithms;
historical research artifacts remain available separately from executable code.

Current access receipts use `source-semantic-access-v2` with required typed compact
`phases`: version-2 tuple `[2, preparation, acquisition, observation|null]`.
Public `execution` is the `native_reasoning_only` literal or version-2 tuple
`[2, preparation, acquisition]`. Inner preparation and acquisition remain
version-1 compact tuples; each may carry one optional supplemental route at
slot `[3]` (original-first primary, distinct `access_hint`). Wire admission
checks those compact slots directly and must not construct expanded objects.
Expanded `source-semantic-execution-v3` meaning (`query_preparation`,
`acquisition`, `semantic_generation_attempts: 0`) remains authoritative only
through the Protocol helpers `sourceSemanticAccessPhases` and
`sourceSemanticExecutionPhases`; `sourceSemanticExecution` emits the literal only
on exact canonical equality with no supplemental route. Capture
(`captureSourceSemanticQueryPreparation` / `captureSourceSemanticAcquisition`)
is the semantic ingress; packing never drops profile identity, unknown
measurements, or supplemental route costs. Conditional computation stays a
separate post-snapshot coverage coordinate, not an execution field. Query
embedding runs in `SourceIndexAcquisition.prepareQuery` before the caller-owned
read snapshot (`beforeSnapshotPreparation`): original navigation first, then a
distinct hint as a shared-bind supplemental route. A failed hint cannot replace
original work. A begun snapshot degrades as `snapshot_already_begun` with no
inference, replacement or commit; an unwired binder is
`embedding_preparation_unwired`. That model/index work is not covered by the
later conditional computation's provider-free guarantee. Unknown costs remain
unknown, not zero. Prepared vectors stay on the private worker `prepared_query`
envelope, not public MCP/CLI payloads. Tool descriptions express these phase
boundaries rather than claiming the whole call is provider-free.

Live `source_disclosure` is codec version 1: a lossless positional tuple derived
from the named semantic (`encodeSourceDisclosure` / `sourceDisclosure`). Named
Protocol 14–18 objects are rejected as current ingress; `decodeHistoricalSourceDisclosure`
is an offline archive reader only. Protocol 13.x named-object history remains
historical, not the live wire.

Unscoped query-conditioned observation may run one snapshot-owned
`source-index-interleaved-prefix.v1` join: bounded BM25 lexical rows and
inspected vector windows (`ranking: exact_over_inspected_subset`, not
full-library nearest neighbor) into at most 16 root `nominations`. Compact
`observation` is `null` when unmeasured, never zeros; a measured slot is
`[work, memory_bytes, native_bytes]`. Expansion restores
`sql_internal_work: unknown` and the fixed `phase_accounting` literals
`completion: included_in_worker_work_not_separately_measured`,
`native_cpu: unknown`, and `deadline: soft_quarantine_until_exit`. Those
accounting fields are not retained on the receipt. Short preparation form
elides only exact canonical not-run work; `null`, `unknown`, `not_run`, and
vector `valid_empty` stay distinct from zero, absence, or `ready`. Soft worker
deadlines bound caller latency only; `terminate` is a request, and a slot stays
owned through quarantine until actual exit. Packing, expansion and pool-identity
traversal charge the request ledger without refunds; `pool_id` hashes the
expanded preimage while the receipt retains compact `phases`. Holding a
canonical-observation quote does not prove that every previous envelope still
fits. A private daemon Source-index producer is wired into background start/stop
and is separate from Garden `EMBEDDING_BACKFILL`. Local model artifacts must already
be provisioned; the producer does not download them. Mechanism-level cached-model
checks do not establish default useful recall or natural-corpus effects. The existing Source-index lifecycle now has explicit unbind/recovery:
configuration absence atomically revokes active eligibility and fences old selection
revisions without marking a build failed. Shared generation-status eligibility
serves storage and query preparation. Producer waits do not cancel shared inference;
native occupancy remains quarantined until settlement or provider close.

Current-request `execution` may be the `native_reasoning_only` literal only for
exact canonical not-requested/not-run phases (`operation_does_not_prepare` /
`operation_does_not_acquire`, `semantic_generation_attempts: 0`, no supplemental
route). It does not imply zero native work and is never inferred from
generation-attempt count alone. Any other reason, resource evidence, supplemental
route or unknown measurement stays a compact non-literal execution tuple. Frozen access `phases` are observation
provenance, not this delivery's execution. Page-reservation encoding prices the
first page with caller `initialExecution` (default native-only) and later reserved
pages as native-only; public delivery of any frozen page attaches current-call
`execution` from the worker meter without new source access, solver replay or
re-selection. Public
`provider_attempts` is removed: derive external attempts from execution,
preserving unknown (`null`) measurements, including via
`sourceSemanticExecutionExternalAttempts` without expanding complete phases.
Reason delivery first fits the complete v5 result and premises. Only an oversized
envelope may instead carry `no_conclusion`: original `outcome`, available
H/Q/C/computation identities and restrictions, disclosure including `proof_use`,
coverage and measured work, without result, bindings or premises
(`coverage.payload: truncated` when clipped). Its tuple holds
`[outcome, [H, Q, C, computation], optional query gaps]`; `null` identity means
unavailable, not uncomputed work. Recovery expands it through
`sourceSemanticReasonControl` and must not treat omitted premises as never
computed or invent attention. Mandatory evidence that cannot fit still fails
closed. Bounded final-proof deferral still uses the existing page selector; it
prices a tentative later page against the actual current-execution envelope and
does not add relevance, proof authority or recall gain.

Cross-major migration: consumers must read compact `access.phases` / `execution`
and compact `source_disclosure` together with current receipt versions, expanding
only through the Protocol helpers. Historical access v1, version-1 phase
envelopes, expanded live objects, named Protocol 14–18 disclosures, earlier 13.x
named objects, or missing execution evidence must not be relabeled as a current
measured result. Archive
bytes remain unchanged; rebuild current measurements through their native producer
rather than patching old receipts. Query vectors stay in the private worker
envelope, not public responses. Independent review, runtime/codec tests and
small-budget verification remain open. This migration does not establish default
background indexing, ready vector coverage, or natural-corpus recall gains, and
performs no release or provider execution.

Protocol 18.1.0 includes source representation in unproved-delivery source
identity. Verification uses the same source-record hash as receipts, so a
substituted source id or a relabeled representation is a different record.
Historical unproved rows without representation keep their previous identities.
The 18.0.0 representation identity rule remains the major under invariant §25;
this package increment records the unproved-delivery identity close.

Protocol 18.0.0 makes source representation explicit. Post-turn capture retains
exact supplied message excerpts with their roles, while Garden keeps its existing
canonical extraction projection bound to those originals. Optional representation
metadata participates in new source identities; records without it preserve
their old identities and remain immutable. Current reads disclose missing
historical representation as `unknown` and canonical material as
`canonical_projection`. Full delivery of retained bytes no longer implies a
complete original body. Projection reads depend on the referenced source records
remaining available and current under the existing scope rules.

This changes public delivery qualification and is a major under invariant §25.
Consumers must accept the additional material kinds and projection provenance,
and distinguish `content_complete` from `original_complete`. Existing records
are not relabeled or backfilled; old archived responses retain their original
bytes and producer versions. The ordinary source-only archive reader also
accepts current version 18 while recording the reader version independently.
This source-capture migration performs no release or provider execution.

Protocol 17.0.0 restricts query alternative `purpose: "counterexample"` to
universal (`evaluation.kind: "forall"`) bodies. One Protocol purpose rule owns
both canonical admission and the flat, nested meaning and referent generation
schemas. Ordinary, operation and comparison bodies accept omitted purpose or
`support`; valid universal counterexamples remain supported. Narrowing the
publicly exported meaning/carrier validators used by the SOUL producer is a
major under invariant §25, despite native admission already rejecting
non-universal counterexamples. The MCP schema snapshot is unchanged. Exact
same-body negation, references and connectivity remain native checks; the
restriction does not establish producer fidelity.

Protocol 16.0.0 publishes the shared query body and comparison constraints in
generation and public MCP schemas. Pairwise comparisons require `right` and
comparator-matched `strict`; extrema omit `right`. These newly required/removed
fields and narrowed values make this a major under invariant §25, even though
canonical native admission already rejected the illegal combinations. Query
body modes preserve ordinary answer/operation inputs, nonempty universal bodies
and empty comparison bodies; finite evaluation cannot carry evidence inputs.

Cross-major migration: consumers generating or validating query semantics must
adopt the [current query contract](docs/handbook/recall.md#opt-in-open-source-semantics)
and its comparison alternatives and purpose/evaluation combinations. Valid
canonical query identities and wire contract IDs remain unchanged; changed
generation schema/prompt bytes receive their own request/cache identities.
Historical requests, failed attempts and
source records are not rewritten or granted retry authority. The ordinary
source-only Recall archive reader explicitly supports producer packages
14.1.0, 15.0.0, 16.0.0 and 17.0.0 while recording its current reader version separately.
This candidate does not register 15.0.1 as a historical capture format or perform
a release, provider run or semantic-fidelity acceptance.

Protocol 15.0.0 raises source-reference catalog capacity from 64 to 128 source
units and checks aggregate text and segment bounds before copying nested catalog
input. The exported parser now rejects catalogs previously accepted by its shape
but refused by reference resolution, so the combined change is major under
invariant §25. The 65,536 UTF-16-unit and 32,768-segment bounds, graph limits,
request budgets and resource-exhaustion outcomes stay unchanged. Historical
assertion-capacity reasons with limit 64 remain readable; current refusals use
128. Historical records grant no retry or publication authority. Existing valid
catalog, request and interpretation identities are preserved. No release is
performed here.

The same unreleased surface includes additive source-producer API under
invariant §25: SOUL exports `SourceSemanticSourceRoleSchema` for the Bench
retained-source admission consumer, and existing unit/request APIs accept an
optional known single-source author. This permanent shared validator owns the
supported user/assistant roles; native admission does not duplicate them.
The optional SOUL request-body `source_role` participates in request/revision
identity while absent fields preserve legacy bytes and keys. The opaque public
request envelope, producer response and reference catalog schemas do not change.
App/SOUL packages remain `0.3.11`; this additive API is included in the current
unreleased major without a separate release step. Retained v2 admission
explicitly refuses absent/null or system speakers, and quoted role markers
cannot override a known source author.

Protocol 14.1.0 adds optional `prepare_query.access_hint` and the explicit
`soul.interpretation` invalidation operation/event under invariant §25 (minor,
additive fields and action). A hint changes one metered navigation query while
preserving original-query semantics and frozen continuations. Invalidation
archives an exact source interpretation through a scoped, audited transaction;
history, source text and independent interpretations remain available. A failed
replacement cannot reactivate invalidated support. Engine gateway 1.2.0 documents
these operations; the host tool advertises its state-changing invalidation.
Neither change adds provider calls to Recall or promotes a new default policy.

The same unreleased 14.1.0 includes additive query-producer API under invariant
§25: Protocol exports `SourceSemanticQueryPresentationSchema` and
`SourceSemanticQueryPresentation`; SOUL exports `sourceSemanticQueryPresentation`,
`sourceSemanticQuerySystemPrompt`, and `SOURCE_SEMANTIC_QUERY_NESTED_RESPONSE_CONTRACT`.
Explicit `nested-meaning-v1` selects request v10/response v9 and sends the current
meaning grammar to the existing host compiler. Omitted or `flat-carrier-v1`
selection preserves request v9/response v8 and their request identities. MCP,
EventLog, runtime config, canonical query semantics and the default stay unchanged.

Protocol 14.0.0 changes semantic-library `slot_qualifiers` under invariant §25
(major: a source slot can expose multiple independent proof qualifiers). Consumers
must join each qualifier using its explicit `index` and full Q/H/C/computation
identity, not array position or one qualifier per occupied root. Each qualifier
owns only its proof's witnesses and partial support. Source occupancy remains
one slot per root; exact-C withdrawal leaves other independent proofs intact.
Existing single-proof/source-only shapes still parse, but consumers must adopt
the new multiplicity before using this version. No release is performed here.

The same unreleased protocol surface adds five pure shared exports:
`projectSourceSemanticQuerySupport`, `sourceGoldRootIdentity`,
`proofForLibraryEntry`, `sourceSemanticProofQualifier`, and
`proofForLibraryQualifier`. This additive API change is included in the existing
14.0.0 major under invariant §25. Core production and delivery admission reuse
this authority rather than independently defining proof-slot binding and support.
It adds no MCP payload field, persisted format, or live-provider operation.

Native scoped C requests additionally bind a query-branch demand and explicit
assessed/unassessed coverage, with separate H and total-C budgets. This producer
metadata grants no proof authority. Full-catalog request identities stay stable;
scoped results cannot satisfy another task or a full-catalog cache lookup.

Engine gateway 1.1.0 exposes the existing resolved provider URL guard. Native chat
Bench HTTP delegates use it before source and Q/C attempt reservation; local URL,
DNS or missing-credential refusal leaves the key unattempted. Offline delegates,
cached replay and Gemini dispatch retain their behavior. The actual fetch keeps
its DNS guard, so a later DNS change can still consume an attempt. Readiness
now uses the gateway's existing cancellation/deadline lifecycle: pending
DNS releases the fill lease on caller cancellation or its finite request budget,
without reservation or provider raw. Readiness and later transport each receive
their own budget; this does not establish an end-to-end deadline. Request/schema
bytes and semantic cache key definitions remain unchanged.

### Historical development notes (not current)

The following notes record earlier unreleased development versions, not
current package, library, or query identities. Live ordinary recall is the
conditional-field route. Live semantic-library identity is protocol 7 /
library v6; current query serialization is request v9 / response v8.
Present-tense version names below are chronological facts from those
development steps; they are not the live contract.

Protocol 13.12.0 adds an opt-in source generation task for a single original-query
family. Complete original source text and the unchanged source catalog are supplied
in both full and scoped responsibility modes. Strict model responses cannot set
host task metadata; admission binds it to the draft, H identity and native descriptor.
Scoped H explicitly leaves other meaning unassessed. Structural gaps and native
Q/C execution remain unchanged; task declarations do not certify semantic fidelity.
Absent-task request bytes, prompts and H identities remain unchanged.

Protocol 13.13.0 adds optional sibling `generation_task` on public MCP
`soul.interpretation` `propose` under invariant §25 (minor: additive optional
request field). Nested model drafts stay strict. After source-handle validation
the daemon binds the declaration through `SourceSemanticHostBoundDraft` before
existing publication. The field does not certify generation history or completeness.
Task-absent propose behavior is unchanged.

Protocol 13.11.0 shares existing producer envelope admission policy with H v8/v9
and Q/C generation schemas. Interpreted outcomes require their payload; H negative
outcomes forbid content, while Q/C retain optional negative payloads. Exactly four
host-only outcomes are excluded from generated responses. Supported `anyOf` branches
preserve these guards through Gemini projection, with native admission unchanged.
Schema-bound request/cache identities change; Q wording and v9 opt-in remain unchanged.

Protocol 13.10.0 also adds an opt-in source proposal v9 presentation with inline
entity-use constructors and one model identity token. It preserves local mention
groups, derives metered evidence rows through the existing table/selection
lowerers, and binds request, guidance, schema, cache and native receive identity.
Default v8 requests and admission remain unchanged; model effectiveness is unverified.

Protocol 13.10.0 adds the opt-in `intern-agents-a1-json-schema-v1` semantic
profile and shared semantic profile set under invariant §25 (minor: additive
exports). It preserves full guidance and adds a strict named schema format to
existing native Q/H/C requests and their bound authority/cache identities.
Existing guidance/defaults and diagnostic-only profiles remain unchanged;
Gemini Batch remains unavailable for Intern. Natural schema acceptance and
semantic success are unverified.

Protocol 13.9.0 adds two explicit Intern protocol-probe profiles under invariant
§25 (minor: additive exports). They preserve current guidance and add only a JSON
Object or strict named JSON Schema format request. Provider acceptance and
enforcement remain unverified. These diagnostic profiles retain native HTTP,
usage and finite-bound evidence, and cannot be selected for semantic Q/H/C.
The existing guidance profile, defaults and historical request identities remain unchanged.

Protocol 13.8.0 adds an explicit Agents-A1 Discovery JSON guidance profile under
invariant §25 (minor: additive exports). Gateway sends the complete named schema
as guidance with finite `max_tokens`, retains physical HTTP evidence and keeps
reasoning separate from final content. Bench binds the exact Discovery route,
model, wire, one-attempt limits and a dated limited-time zero ink price into
existing preflight, authority and cache owners. Missing usage remains unknown.
Ordinary defaults, historical provider profiles and semantic admission are unchanged.

Native full-evidence responses now enforce the finite HTTP read-byte ceiling and
cancel oversized bodies before parsing. Contradictory native usage settles the
exact completed attempt as non-admissible accounting-invalid evidence, retaining
the reported-value witness without trusting its counts. Missing and invalid usage
remain unavailable metering; invalid attempts have an explicit subtype and cannot
reopen dispatch or pass successful-admission closure.

Protocol 13.7.0 adds an explicit Step 5 Preview JSON Mode profile and the shared
wire-format lookup under invariant §25 (minor: additive exports). Gateway places
the complete named schema in system guidance while requesting JSON Object output.
The actual body is bound into existing request/cache/receipt identities. This
provider projection does not change semantic schema, admission or defaults, and
never activates in response to a failed attempt.

Protocol 13.6.0 adds an explicit Step 5 Preview low-effort JSON Schema profile
and the shared profile-to-model lookup under invariant §25 (minor: additive
exports). Request, catalog and quote admission reject cross-model profile reuse.
Bench supports its separately priced ordinary OpenAPI route. Existing Step 3.5
defaults, historical quote bytes and MCP payload schemas remain unchanged.

Protocol 13.5.0 adds the shared Step semantic request profile bindings under
invariant §25 (minor: additive exports). Gateway, Eval and Bench use this one
authority for explicit low and high reasoning profiles on `step-3.5-flash-2603`.
Low remains the default; each profile retains its own request, cache and receipt
identity. Existing MCP payload schemas remain unchanged.

Protocol 13.4.0 adds optional typed source observation time to source
disclosures under invariant §25 (minor: additive field). Current projections
distinguish a checked time, a checked source with no time, unavailable metadata,
and unbound material. Existing payloads remain parseable and library identity
versions stay unchanged; source time does not assert when a described event occurred.
Native library delivery includes this optional field only after reserving
complete source support. An absent field means undisclosed, not absent source
metadata.

Protocol 13.3.0 adds optional bounded, current-source zero-binding computation
control to the `soul.interpretation` library delivery under invariant §25
(minor: additive field). It carries Q/H/C/computation identity and keyed
attention through native first exposure without declaring answer support.

Protocol 13.2.0 adds optional product and phase coordinates to bounded
`soul.interpretation` attention entries under invariant §25 (minor: additive
fields). An exhausted source pair now identifies its reached partial binding;
unreached or ambiguous obligations remain branch-scoped and unknown.

Protocol 13.1.0 adds optional native semantic source preview extents and bounded
reasoning attention to the `soul.interpretation` MCP request/result under invariant
§25 (minor: additive fields). Exact source tuples bind preview limits; missing C
has an explicit preparation state. Existing requests and results remain valid.
The previous Unreleased heading still named protocol 11.0.0 after the package and
SemVer sidecar had advanced to 13.0.0; the older 11.0.0 history below is retained.

Protocol 11.0.0 changes `soul.interpretation` prepare-query and recall delivery
under invariant §25 (major: a required public semantic-availability status and
guarded original-question fallback). An absent or unadmitted semantic query now
returns authorized raw source evidence with an explicit unavailable reason;
conditional proof remains unexercised. Public and worker requests accept an
explicit unavailable producer declaration only without a semantic object. Native
library result v5 / protocol 6 and semantic-chain plan v6 / replay v3 bind the
new admission state and prevent earlier continuation or replay identities from
silently changing meaning. Historical artifacts keep their original bytes.

Native semantic access interleaves source observation, header discovery and whole
interpretation verification within its bounded observation envelope. Scheduling
reuses retained headers and associates each newly observed source hint once per
request. Final source scores reconcile by verified record identity before the
whole observed pool is ordered and frozen; exhausted observation remains open.

Protocol 10.0.0 requires `request_identity` on native semantic library deliveries
under invariant §25 (major: newly required public response field). Library
protocol 5 binds the resolved original query, query semantics, correspondences,
workspace, interpretation clock, authorized scopes, prepared source restriction, budget, output byte limit,
and access policy through one Core identity owner. Outcome-only responses remain
valid without a delivery identity. Process-local continuation bindings retain
their existing contract; index result v4 and historical artifacts keep their
original identities. Current consumers reject deliveries missing this binding.

Native semantic library delivery uses result v4 / protocol 5 under the
pending Protocol 10.0.0 release. Five root slots select complete support packages
from actual conditional-computation bindings, with bounded demand-coverage exchange
and raw-source fallback. Exact source windows preserve represented dependencies;
the same encoder enforces token and full-envelope byte limits before selection.
Existing leases freeze pages and reservations. Historical source-only archives
retain their original identities and page policies.

Semantic proposal workset v3, preflight/authority v5, cache v3 and proposal
raw-attempt v1 bind the resolved HTTP endpoint, physical model and exact encoded
request. Preflight and authority also bind the executable revision and physical
execution root through the existing extraction root owner. Reissued receipts share
a durable execution lineage; unknown reservations retain their original attempt
ownership across revised receipts. Historical raw evidence remains unchanged.
The per-key attempt ceiling stays one or two (default two).

Current native library measurement retains discovery and coverage observations.
Unvisited or unfinished native work keeps negative primary outcomes unknown;
observed valid hits remain hits. Pure delivered-slot outcomes remain available as
diagnostics, and complete pools can still establish initial-page misses when later
frozen pages exist. Historical measurement artifacts retain their original contracts.

Protocol 9.0.0 removes the separate finite query generation schema and depth
export. SOUL generation and admission share the recursive meaning grammar,
which excludes unsupported nested universal binders while retaining top-level
universal evaluation. Existing receive depth and byte limits remain authoritative;
native generation uses the existing recursive JSON guidance and cache identity.
Source normalization v5 also lowers range-valued reporters, domain members and
exclusions, and measurement subjects through the shared entity-mention path.
Catalog grounding and invalid-range rejection remain unchanged; previous raw
responses and receipts retain their original identity and outcome.

Protocol adds `sourceSemanticEvidenceClosure` for Core's bounded source-support
window preparation, reusing the accounting and structural reference owners.
Core preserves represented governing context and exact assertion intervals,
with explicit missing-location and budget outcomes. This additive utility is
included in the pending Protocol 9.0.0 release; MCP, EventLog and config schemas
were unchanged in that utility change; native delivery now consumes these windows
under the versioned library contract above.

Library previews share the existing Recall token estimator and reserve display
space for every occupied root before distributing the remaining allowance.
Native preview reads use the existing UTF-8 hydration owner with a 4096-byte
limit. Partial native previews remain partial in both public coverage and index
completeness; the encoded-response byte limit still applies independently.

Query meaning v3 and canonical query v3 retain conjunctive answer conditions and
independent evidence inputs in one original query identity. Query request/response
v5 feed the same bounded recursive grammar. Reporter support comes from the
original question or a declared reference, independently of arbitrary local handles. Reasoning v5 delivers discriminated
answer/evidence bindings through one execution and proof authority; evidence does
not execute a requested operation or claim original-answer completion. Library
v4/protocol 5 preserves every delivered witness within one occupied source root,
verifies siblings, and reports shared answer/input support with unknown cross-source
compatibility and distinctness. Unfinished phases remain resource-exhausted/partial.
Archive-only source-evidence v1 identities, pages and order remain unchanged.

Opt-in interpretation preparation and recall now share query-conditioned native
candidate access and a budget-bound frozen pool. An explicit canonical policy
retains the diagnostic control. Bounded receipt pages preserve unvisited and
partial-body states without repeating native reads; these additive public fields
are included in the pending Protocol 9.0.0 release.

Protocol 8.0.0 additionally requires complete current library deliveries to identify
protocol 2 and library v2, membership purpose and the ten-slot page budget. Worker
and public schemas derive these fields from one delivery contract. Outcome-only
recall responses carry no partial delivery fields. This public narrowing is a
major change; library wire versions and query identities are unchanged. Gateway
1.0.0 is unchanged because tool names and descriptions did not change. Historical
source-only v1 comparison has an explicit offline readmission entry that retains
its original result, query and first-exposure identity; current readers reject it.

Protocol 7.0.0 and Gateway 1.0.0 recorded the breaking opt-in interpretation migration:
public source interpretation, query semantics, semantic correspondence and conditional
computation fields and obsolete producer exports are replaced by their current
responsibility names and envelope contracts below. This authorized replacement
does not retain deprecated aliases or dual readers; consumers must migrate
together. MCP schema and tool-description snapshots and their SemVer sidecars
pin the new public surface.

Opt-in producer APIs add source selection, query meaning, and semantic correspondence selection
schemas/materializers in Protocol and their request/response builders in SOUL.
These producer exports serve SOUL and the bench runner. The opt-in semantic
interfaces now use responsibility names throughout; EventLog and runtime config
are unchanged. Query and correspondence readers accept only their current
meaning and endpoint-selection envelopes, without legacy graph readers.
Query meaning preserves named comparison operands and rejects unsupported nested
universal binders. Retained provider failures keep their original classification,
completion evidence, and raw response; terminal proposal publication resumes
idempotently. Source publication requires an explicit association to a frozen
source/version and retained request, without claiming historical generation origin.

Under invariant §25, the opt-in migration versions its serialized interfaces:
response envelope v5, reasoning v4, library v2, public/worker recall protocol 2,
semantic correspondence v3, proposal workset/cache/authority/preflight v2,
provider raw-attempt v2, chain replay/withdrawal v2, development freeze v2,
publication report schema 2,
relation namespace v5 and lowering v5. Existing generic engine `hypothesis_id`
continues to identify an engine hypothesis; semantic results expose
`conditional_computation_id`. Historical raw responses and measurements are
unchanged. The opt-in `soul.interpretation`
`recall` accepts prepared query semantics and semantic correspondences and returns source-root occupancy pages, complete
conditional proof packages binding source interpretation, query semantics and semantic correspondence, explicit coverage and the actual request
budget. Ordinary `soul.recall` and its defaults are unchanged. Continuations
bind the initial clock, caller/session, scopes, budgets and current database
revision; stale generations fail closed. Payload demotion preserves occupied
positions and cannot retain a semantic proof without its conditions.

Source discovery withholds identities when its bounded historical scan is
incomplete or unavailable. Libraries beyond that bound need indexed current
source enumeration before any broad usefulness claim. Source retrieval remains
scoreable when proof-conditioned measurement is unavailable. No provider calls,
benchmark execution or default cutover are authorized by this contract change.

## Historical unreleased development notes — protocol 6.6.0

The following notes record earlier development versions, not current package versions.
This section is **not a release tag**. App packages remain `0.3.11`
until a matching `## vX.Y.Z` section is opened. Do not tag `Unreleased`.
A GitHub release tag must match the latest published `## vX.Y.Z`
heading (currently `## v0.3.11` below). Protocol 6.6.0 can move
independently of the app semver. `@do-soul/alaya-engine-gateway` is
`0.3.12` for the additive `soul.interpretation` tool surface.

Protocol 6.6.0 adds opt-in `complete-source` extraction packing for open
semantics. SOUL binds every source unit in its original order into one bounded
request, so transport partitions do not remove discourse context. Oversized
sources fail preparation instead of being silently split. Recorded partial
requests retain their original scope and limits; closed extraction generations
reject this packing. Input completeness does not certify semantic coverage or
relax interpretation and resource limits.

Batch extraction adds explicit, exact-job observation recovery after local
poll bounds. A repaired observer can retain the original submitted authority
and plan without dispatching or importing under a changed execution revision.
Ordinary polling stays bounded and unobserved remote work retains unknown cost.

Protocol 6.5.0 adds a bounded generation schema derived from the same semantic
expression shapes and canonical depth limit. Shared acyclic definitions carry
the complete legal nesting envelope to structured decoders. SOUL pins this
generation contract in new requests; recorded marker-absent requests retain
their recursive schema and original Gemini JSON-mode identity. Strict semantic
admission, source review and consumer evaluation remain independent requirements.

Protocol 6.4.0 adds nested source-semantic expressions. Producers declare scope
through nesting and entities where used; the shared compiler generates canonical
identities and lowers through the existing content compiler. Explicit co-reference,
same-parent content reuse and non-governing references remain distinct semantic
choices. SOUL selects schemas, prompts and revision validation by the recorded
producer contract, preserving v2 raw replay. Canonical source interpretation and consumer admission
remain unchanged; this interface does not certify semantic completeness.

The native Gemini codec uses JSON mode for recursive schemas and carries the full
expression schema as system guidance, preserving strict local admission.
Recursive request cache identities bind the source schema, absent decoder schema
and exact appended guidance; historical acyclic identities remain unchanged.
Batch and interactive transport share this projection owner.

SOUL's additive completed-response revision contract distinguishes transport
completion from JSON validity. Explicitly complete invalid JSON can enter a fresh,
bounded revision with immutable raw and rederived syntax diagnostics; truncated,
unknown and empty responses remain rejected. Historical revision bytes, source
lineage, the three-revision cap and strict replacement admission are preserved.

Protocol 6.3.0 exposes the shared bounded diagnostics schema and preserves exact
producer alias/ownership paths. SOUL adds explicit source-bound revision
preparation with immutable prior raw, verified parent requests and at most three
revisions. Structural feedback is revalidated; source-review comments remain
reviewer interpretations. Batch revisions use new request identities and native
authority/attempt receipts, preserving prior quarantines and strict admission.

Protocol 6.2.0 adds the source-semantic content proposal and deterministic
compiler under invariant §25. Producers choose predicates, roles, co-reference,
scope, speech acts and domain evidence. The host generates mention identities,
slot/binding pairs, reciprocal ownership and quantifier binders before existing
canonical source interpretation validation. References and embedded content remain distinct;
orphaned or conflicting scope is rejected rather than asserted. Compilation
and normalization share one resource ledger. Recorded graph proposals retain
their exact request-selected schema and prompt for replay. Canonical source interpretation, MCP,
EventLog and config schemas are unchanged; structural admission still does
not certify language completeness.

Protocol 6.0.0 versions source semantics as source interpretation v4, query semantics and semantic correspondence v2, envelope 5,
and reasoning/cache v3. Explicit finite domains, universal templates,
conditional membership assumptions, and exact decimal measurements lower
through the existing conditional-field engine. Proofs retain instantiated
coordinates and source leaves; exhaustive answers require a closed asserted
domain. Open domains permit evidence-bound instances without exhaustive claims.
Numeric comparisons require matching metric, unit, context, and population;
extrema preserve ties and unknown operands. Nested universal binders and
additional comparison frame constraints are rejected explicitly. Legacy
interpretations are not relabeled or promoted to the new contract.

Bench extraction samples now support any natively inspected dataset window,
including small diagnostic corpora. Canonical population windows retain their
target-selection requirement. Exact request membership, one Batch job, one
attempt per selected key, spend reservations and strict result admission remain
enforced by the existing authority and attempt-ledger owners.

Protocol 6.1.0 is additive under handbook invariant §25: it exports the producer
proposal contract/schema/materializer, shared accounting validator and explicit
legacy normalizer version. MCP, EventLog and config schemas remain unchanged.
Source-interpretation extraction now uses `source-semantic-proposal-v1`: Protocol derives redundant
embedding self-references and outcome gap copies. Normalizer-v4 records
structurally unaccounted source assertions/evidence and incomplete bindings as
located gaps; Core enforces the same rule during publication and SQLite reopen.
Accounting expansion consumes the resource budget and preserves exhaustion as
a distinct outcome. Historical normalizer-v3 requests and stored source interpretations remain
explicit replay/read paths; Core's internal normalized-source-interpretation publication entrance
requires v4, while MCP propose continues to accept canonical drafts. Canonical source interpretation v4 and
response-envelope shapes are unchanged. This provider-free repair does not
certify language completeness or change historical paid extraction verdicts.

Protocol 5.2.0 adds optional bounded path/code/reference diagnostics to invalid
source-semantic outcomes. Interpreted producer envelopes must echo the body's
gaps; source interpretation and query semantics no longer discard conflicting outcome-only gaps, and semantic correspondence rejects
gaps it cannot represent. Matching partial interpretations remain supported.
The producer prompt distinguishes catalog selectors from graph mention handles
and includes a schema-checked neutral example. Batch quarantine retains the
diagnostic and raw response identity. Historical raw responses are not repaired
or relabeled, and new producer prompts use the existing request/cache identity
owner. This engineering repair does not establish actual-model quality.
Query-semantics and semantic-correspondence proposal preparation now returns its native system prompt as separate
metadata; strict request bodies and MCP schemas are unchanged. Unconsumed
module exports remain private, and unused request type aliases are removed.
Source-interpretation producer guidance now distinguishes argument node targets from mention
evidence and gap locations, with a neutral partial example that anchors an
uninterpreted clause without inventing a frame. Existing reference validation
and historical raw rejection remain unchanged; this does not certify model
source fidelity.

Protocol 5.1.0 is an additive minor under handbook invariant §25. The
opt-in `soul.interpretation` channel adds qualified answer bindings,
per-answer proof forests, located `no_executable_proposition`
dispositions, host-only `unavailable` source reads, optional
`authorized_scopes` admission on the four host operations, and paged
full-source-interpretation preparation. Structural/normalizer/lowering versions are 2;
version-1 open hypotheses require new explicit preparation, not
relabeling. Operator ownership, named query referents, variable sorts,
non-tree query incidences and fixed conditional computation completion are enforced before
qualified delivery. Source references are revalidated on publish and
reopen. Bounded preparation leases retain candidate/query-semantics/scope identity;
one-shot results do not replay another run's coverage. Ordinary Recall,
Garden v1 and profile-bound v2 contracts are unchanged. Real-model
quality and default activation remain unexercised.

Protocol 5.0.0 is a major under handbook invariant §25: the advertised
MCP/EventLog capture-execution fail-closed reason
`psi_cycle_contract_failure` is renamed to `cycle_contract_failure`.
Historical payloads still parse. New JSON Schema no longer lists the
old token.

Protocol 4.15.0 is an additive minor under handbook invariant §25.
MCP/CLI expose `soul.interpretation` with four host operations
(`prepare_source`, `propose`, `prepare_query`, `reason`). Host operations
are provider-free; `propose` is an idempotent unreviewed-evidence write
and does not create memory or relations. `soul.report_context_usage` is
not an interpretation delivery loop. Existing Recall/Garden tool names
and field names remain parseable.

Protocol 4.14.0 is an additive minor under handbook invariant §25.
MCP-reachable `InformationIndex` / `IndexEntry` / `ProductStateKey`
admit optional `interpretation_node`, and `Transition.validity` admits
interpretation-premise validity beside world relation validity. Default
MCP encoding still refuses interpretation entries without the qualified
result capability; existing search field names remain parseable.

Protocol 4.13.0 is an additive minor under handbook invariant §25.
Optional `SoulSignalTriagedPayloadSchema.deferral` records write-path
reconciliation deferral (`lease_busy` | `prewrite_unavailable`) on the
EventLog triage payload. Existing triage fields remain parseable;
unavailable still must not ADD.

`SoulMemorySearchResponse.ranking_authority` stays parseable in app 0.3.x.
Live ranking ignores it. Do not delete the field in this series; removal
waits for a protocol major after the compatibility ledger expires.

Retired local cross-encoder env keys (`ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK`,
`ALAYA_LOCAL_CROSS_ENCODER_MODEL`, `ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR`) are
ignored. Daemon startup emits the shared unregistered/retired env warning.
Unset them; they no longer change ranking. A later release will drop the
warning once operators have migrated. Do not add a throw tombstone for this
deleted feature.

Protocol 4.12.0 is an additive minor under handbook invariant §25.
MCP-reachable `MemoryDimensionSchema` admits `observation`. Optional
`QueryHole.description` preserves unresolved query text, and optional
`source_lookup_reasons` exposes bounded proposal diagnostics on Recall
candidates and MCP/CLI search results. Request and response field names
are otherwise unchanged; these fields do not change source eligibility,
association grades, or delivery ordering. Ordinary extraction retains its
exact per-turn source before compilation, publishes through
transaction-current Core admission, and uses source interpretations
across live cache and enrichment paths. Native hint lookup meters scans,
hydration, and bytes and preserves unfinished work across continuation.
Local mechanism checks do not establish semantic usefulness; the R02
quality gate remains on hold.

Native CJK segmentation (`@node-rs/jieba`) moves off `@do-soul/alaya-protocol`
onto Node-only `@do-soul/alaya-cjk-segmentation`. Protocol keeps interrogative
fallback atoms, the CJK-candidate predicate, and a once-only bind seam on
`node/source-frame` (not the browser root). Core and storage consume the helper
directly and no longer re-export it. This restores invariant 1 (protocol
depends only on `zod`). Inspector SPA and Inspector server do not depend on
the helper. Workspace-internal; not a §25 MCP/EventLog/config change.

TypeScript 7.0.2 is the workspace `tsc` (native compiler). The repository
structure guard keeps the TypeScript 6 Compiler API via `@typescript/typescript6`
because 7.0 has no programmatic API. Compile-time performance is not claimed
from this change; measure `tsc` on a representative host. Vitest 5 stays deferred.

Protocol 4.11.0 preserved source temporal meaning across extraction and
replay and added the internal source-interpretation signal variant.
Garden MCP emit still rejects `interpretation_contract`; interpretation
signals are not a public MCP write shape.

Bench adds provider-free `source-snapshot prepare` and `inspect` operations.
Original messages enter native source records through mandatory atomic Core
admission and receipt-first audit, then a deferred projection checkpoint and a
separate source-record artifact. Existing post-extraction snapshot gates remain
unchanged. Empty source previews are displayed explicitly without changing raw
source bytes. Core exposes the intended admission service and native span-view
builder to the Bench consumer; non-protocol package versions remain 0.3.11.

Protocol 4.9.0 adds `groundEvidenceFactFrameObligation` for shared Core formation
and Protocol verification. Ordered grounding, argument positions, wire schemas,
receipt/operator identities and existing receipt bytes are unchanged. Recall
now admits failed-deployment events through one bounded tri-state owner and
retains unresolved seed premises until their current observation is settled.

Protocol 4.10.0 adds the Node-only `node/source-frame` entry for shared source
obligation grammar used by Core formation and Storage qualification. This is an
additive minor under invariant §25; the existing Core normalizer API continues
to export the same implementation. Native CJK segmentation stays outside the
Protocol browser root. Historical receipts retain their frame-to-graph meaning
and bytes, while current qualification rejects lost leading qualifiers,
modality, trailing source tokens, and unsupported dependent scope. Extraction
catalog version 3 requires demonstrated fragment independence, including
adjacent dependent continuations. MCP, EventLog and config schemas are unchanged.

Source `@do-soul/alaya-protocol` is **5.0.0** (`packages/protocol/package.json`).
`AlayaStatusSchema.mcp.catalog_health` is an additive optional field.
GitHub `releases/latest` is a published tarball and is **not** this source tree;
pin `ALAYA_VERSION` or install from a checkout. Local ONNX embeddings
(`@huggingface/transformers`) are an optional extra, not a default install.

`SoulMemorySearchResponse.strategy_mix` is removed from the protocol 4.8.0
payload and rejected by the strict response schema; it is not a
deprecated parseable sibling field.
`SoulMemorySearchResponse.delivery_path`,
`SoulMemorySearchResponse.ranking_authority`, and
`SoulMemorySearchRequest.recent_turn` are deprecated and remain parseable.
The target emits `index` and never executes a legacy selector or enqueues
extraction from Recall. Under invariant §25, deprecated parseable fields
remain until a published minor deprecation interval has elapsed; they stay
parseable in protocol 4.8.0.

Active constraints remain a separate governed response, read within the same
snapshot and request allowance. `active_constraints_count` is nullable when
bounded or historical observation cannot establish an exact total;
`active_constraints_completeness` states that limitation. This is part of the
protocol 4.8.0 semantic cutover, not an additional published version.
Source evidence pointers and supplied governance warnings remain visible at
their supported granularity. Hint-only output omits source bodies and pointers.

The isolated Recall candidate follows the major semantic-cutover classification
in `docs/handbook/invariants.md` §25. Query-conditioned index delivery replaces
the former ranking contract. This candidate also carries grounded explanations,
explicit interpretation and proposition identity, and optional witness usage
reports verified against recorded delivery exposure. Existing object/output
usage reports and historical records retain their supported meaning.

The version and public-schema snapshots describe the local candidate only.
Migration packaging, activation, and release remain separate work; no public
symbol is removed by this repair. Non-protocol workspace packages stay aligned
at `0.3.11`.

## v0.3.11 — 2026-06-04 (implementation checkpoint; not a published 500q-gated release)

**Status:** implementation checkpoint, not a published 500q-gated release.
The LongMemEval / LoCoMo 500q KPI gate is **PENDING a larger host** (the local
7.6 GB WSL2 box OOMs at 500q). v0.3.11 is not a published 500q-gated tag.
**R@5 -> 90% is not claimed as achieved** — the recall fan-in is implemented
and code-reviewed, but the R@5 number is unmeasured locally and deferred to
the R5 gate. The v0.3.11 closeout report lived in the historical archive
removed on 2026-08-24 (commit 2b23da6f2).

### Garden compute — zero-cloud by default

- **`host_worker` is now the Garden compute product default** (zero-cloud): when
  no Garden secret is configured the daemon resolves `host_worker`, and the
  attached CLI agent (Codex / Claude Code / similar) is the compute. A configured
  secret is read as an explicit `official_api` opt-in. `alaya doctor` prints the
  live mode and warns when extract work is sitting unclaimed.
- **B-2 edge classification is now a host-worker `EDGE_CLASSIFY` Garden task**,
  deferred out of synchronous enrichment into a claimable task; the MCP
  `garden.complete_task` envelope accepts an edge-verdict result.
- **Eventual-consistency fallback**: recall right after memory creation keeps the
  deterministic rule heuristic as the immediate path when host-worker
  classification has not yet completed; pending/stale `EDGE_CLASSIFY` tasks
  surface as diagnostics.
- **Cloud edge-LLM is default-OFF** (strict opt-in behind
  `ALAYA_EDGE_PRODUCER_LLM_ENABLED`; the provider URL no longer defaults to a
  cloud endpoint). A no-network K4.5 regression asserts no Alaya cloud call by
  default — **K4.5 zero-cloud holds by default**.
- Removed the dead `local_model` + `custom_api` compute providers.

### Recall — durable fan-in (R@5 mechanism, unproven number)

- **Retired the temporary `session_cohort_fanin` heuristic**; durable ACCEPTED
  positive `memory_entry <-> memory_entry` co-occurrence hub edges (member ->
  representative) are now the fan-in carrier. Direct hub effects score through
  `path_expansion`; `graph_expansion` only covers leftover/multi-hop reach.
- Structural reserve is gold-blind relevance-gated and honors suppression; the
  representative-selection guard nominates one query/evidence-relevant
  representative and refuses membership-only promotion.

### Bench fidelity

- Bench harnesses mint same-session co-recall `recalls`-tier edges at seed time
  and **EARN** sparse co-recall paths through the production `onCoUsage` gate, so
  archives contain accepted, recall-eligible positive PathRelations rather than
  sub-auto-accept pending proposals.
- Fixed seed-materialization batch loss (`candidate_absent` + 1963 dropped) via
  per-signal failure isolation + a persisted drop reason.

### Forgetting-compression lifecycle

- **`judged_useless`-delete arm is LIVE and data-loss-safe**: reversible memory
  dormancy (dormant demotion + tombstone GC enqueued on a timer); recall/list/FTS
  exclude DORMANT rows; lazy time/idle decay computed at recall read (bounded, no
  full-table scan); autonomous terminal removal deletes only sourceless,
  never-reinforced rows (evidence == 0 AND reinforcement == 0), with a
  delete-authority disposition gate + capsule TOCTOU re-verify (B1 data-loss fix).
- **Compress arm is ARMED** behind the same delete-authority gate: synthesis
  accept populates `source_memory_refs`; only fully-consolidated members whose
  `evidence_refs` are a subset of a live capsule's evidence can earn the
  `compressed` disposition; pinned / hazard / canon / consolidated memories are
  never compress-deleted. The capsule preserves shared evidence plus a
  deterministic gist summary, not the member `content` byte-for-byte. Backlog
  `#BL-049` is closed by this activation.
- **Production synthesis review accept -> capsule create** is now wired (a
  `synthesis_create` branch with a deterministic no-LLM summary, atomic
  accept-with-events) — the memory-compression entry point.

### Edge / path governance

- **Edge-proposal expiry** is a live feature: `expires_at` defaults to
  `created_at + TTL` and `sweepExpired` flips outlived pending proposals to
  `expired` with an audit reason (B5).
- Auto-extractor emits a bounded `contradicts_refs` ref-hint producer (B7).
- **Path-relation failures surface to the Health Inbox** as a
  `path_relation_failure` health cause (D-EDGEAUDIT). Inspector web UI
  label/filter for the new cause is deferred (backlog `#BL-055`).

### Truth-boundary docs

- Aligned the truth-boundary docs + tests to the two-entry graph model and
  corrected the LLM-verdict `recall_allowed` birth band (B3).

### Debt cleanup

- Replaced shipped "not implemented" CLI surfaces with honest behavior.
- Retired stale phase/history/deferral comments from source.

### Deferred / closed backlog

Closed in the closeout fix-loop: `#BL-049` compress-arm activation and `#BL-050`
ingest-reconciliation default-ON. Still deferred with close conditions:
`#BL-051` abstention re-test on 500q data; `#BL-052` LongMemEval CI sample-floor
scale-up; `#BL-053` edge `llm_supports` LOCAL pair-classifier; `#BL-054`
lease-pierce governance-cache hot-path hook; `#BL-055` Inspector label/filter for
`path_relation_failure`.

## Earlier releases

Earlier release detail lived in docs/archive trees that were deleted on
2026-08-24 (commit 2b23da6f2). Highlights:

- **v0.3.9** (2026-05-17) — three-layer trust-loop closure: Garden's only legal
  claim output is `claim_status = draft`; new `soul.resolve` MCP verb; additive
  `staged_warnings[]`; PathRelation stability/governance classes feeding
  `ManifestationResolver`; Inspector Health Inbox; `SynthesisCapsule.promotion`
  retired.
- **v0.3.0** (2026-05-13) — OS keychain secret refs (`#BL-009`); host-autonomy
  witness for `soul.recall` + `soul.report_context_usage` (`#BL-038`).
- **v0.1.0** (2026-05-05) — first release closeout after the do-what-new port.
