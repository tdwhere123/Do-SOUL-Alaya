# Architecture Handbook

Alaya is a local-first memory plane for CLI agents. This file owns packages,
surfaces, writers and recovery boundaries. The numbered
[invariants](invariants.md) take precedence; [Recall](recall.md) owns live
query, observation, conditional proof and delivery mechanics.

## SOUL Model

| Layer | Authority | Examples |
| --- | --- | --- |
| Memory ontology | Governed durable records | `EvidenceCapsule`, `MemoryEntry`, `ClaimForm`, immutable `RelationAssertion` |
| Structure registry | Rebuildable routing, arbitration and visibility | `PathRelation`, conflict and manifestation projections |
| Runtime control | Per-turn assembly and effects | `RecallQuery`, `ActivationCandidate`, `ContextPack`, trust summaries |

Objects are faceted stable semantic units. Paths are learnable conditional
relations; recall, prediction and reminder are their runtime manifestations,
not independent durable truth. Source evidence owns observation time;
`RelationAssertion` owns immutable relation truth; `PathRelation` projects its
current/as-of eligible edges. Durable authority means governed records and
resolution history, not infallible interpretation or world knowledge.
Authorized source access does not require a completed Q/H/C interpretation;
conditional use remains explicitly fallible. See
[Recall's interpretation boundary](recall.md#fallible-interpretation-and-task-use)
and invariant §12.

## Four Axes

- **Object:** faceted semantic units, not bare atoms.
- **Path:** conditional relation structures and learnable transfer.
- **Evidence:** support, provenance and plasticity evidence.
- **Governance:** conflict, eligibility and maximum per-turn effects.

An object or state is authoritative on only its own axis; a derived view may
reference it but must not silently replace it.

## Temporal Relation Contract

Evidence provides source observation/event time, never `created_at` as a
surrogate. Active assertions require one typed interval: bounded `[from,to)`,
open `[from,+infinity)` or explicitly permitted timeless. Unknown validity
stays in proposal, deferred or quarantine state. A nomination is a candidate;
deterministic normalization and governance decide admission.

Accepted admission atomically appends EventLog history, applies the immutable
assertion and derives its projection or an explicit no-active-projection
outcome. Typed contradiction, retraction, expiry, supersession and retirement
append resolution history and rederive/invalidate projection in the same
transaction, before audit and notification. Replay of identical accepted
history is deterministic and idempotent; concurrent resolutions must preserve
one ordered history. `PathRelation` has no independent truth ledger.

### Temporal Migration, Cutover, and Rollback

Offline migration works on a copy, retaining the original and reconciling
counts/digests. Unprovable rows enter reasoned quarantine, not active recall.
Rebuild for named `as_of` uses the accepted EventLog history. Cutover selects
only a reconciled assertion/EventLog/projection schema-and-data tuple;
startup rejects old, unknown or mixed revisions. Rollback selects a verified
retained tuple or rebuilds its missing projection before serving, otherwise
fails closed. Neither migration nor rollback manufactures time, rewrites
assertion history or activates quarantine. This is a protocol/EventLog major
under invariant §25, not an online mixed-schema reader.

The offline CLI dispatches before normal database bootstrap and holds maintenance
leases on physical resource paths. A journal-owned durable selection is the
recovery commit point: recovery verifies that exact selected tuple and completes
the journal forward, preserving writes accepted after a restart. Interruptions
before selection compensate instead. Explicit rollback verifies the retained
source witness before publishing its pointer. Selected database filenames have
a durable establishment marker; it never grants selection or readiness, and a
missing established database cannot silently become a fresh initialization.
Candidate, receipt, pointer and journal publication syncs file contents and
their containing directory; a sync failure is an error, not durable success.

## Recall algorithm

The ordinary path is the conditional field entered by `RecallService.recall`
(or its worker and MCP/CLI adapters): `compileConditionalFieldQuery` →
`observeField` → `projectAcceptingIndex`. SourceRecord and retained-capsule
root kinds are native SourceIndex discovery targets, not alternative selectors.
Historic prefix, flood, SliceKey, family-max, Gamma and comparison readers are
not a second live execution mode. Association and qualification are described
in [Recall](recall.md#conditional-meaning); connectivity alone proves neither
relevance nor a source-grounded result.

## Package Shape

```text
packages/protocol          Zod domain, EventLog, public contracts (zod only)
packages/graph-algorithms  dependency-free pure helpers
packages/cjk-segmentation  Node-only native segmenter (protocol, @node-rs/jieba)
packages/storage           SQLite migrations, mechanical repositories/readers
packages/core              business transitions, Recall, governance, EventPublisher
packages/soul              SOUL kernel, Garden, heuristics through protocol ports
packages/engine-gateway    provider attempt/transport and MCP bridge
packages/eval              evaluation schemas and metric helpers
apps/core-daemon           composition root, workers, stdio MCP, daemon HTTP/CLI
apps/inspector             local memory-management UI
apps/bench-runner          offline measurement and artifact readers
```

Packages never import `apps/*`. Core must not import engine-gateway, and
provider-edge SDK types do not leave that gateway without protocol
normalization. Protocol has no workspace-package dependencies. The daemon
wires the services, private SourceIndex producer, snapshots and worker
lifetimes; storage supplies mechanical transactions, not business decisions.
Provider consumers request operations but the gateway owns transport retry,
response consumption, completion and usage classification. A parseable cache
shard is not a completed attempt: exact request/route, raw response,
reservation and settled witness must agree before readmission. Cache-only
replay does not infer a new grant from credentials or a model name.

## Surface Shape

- **MCP:** stdio agent attach. Daemon HTTP serves its API and Inspector;
  outbound loopback MCP client activity is not an Alaya HTTP MCP server.
- **CLI:** `bin/alaya.mjs` command surface, including `alaya tools call`
  fallback, shares the memory-tool contract with MCP.
- **Memory Inspector:** local memory-management and runtime-parameter UI,
  not a chat or agent-turn frontend. It uses daemon HTTP with its own session.
  Durable writes still pass through governance.
- **Host slash boot trigger:** a host-native launcher for
  `alaya inspect --open` if supported by that host/version, not an MCP tool
  or agent flow.

There is no daemon SSE/WebSocket event stream. Persistent HTTP request tokens
are operator-owned: changing `ALAYA_REQUEST_TOKEN` and restarting rotates the
credential; when absent, normal HTTP startup fails closed and managed temporary
startup passes a process-local token to its Inspector child. Remote non-loopback
bind is break-glass, not secured by a desktop header or a single token for
multi-host deployment. Provider configuration and secrets use the install
route, not Inspector direct durable-memory writes. Review identity is
server-bound only with configured reviewer token and identity; otherwise it
is an attestation (invariant §21b).

Source-bearing responses use current Protocol `SourceDisclosure` compact
encoding with the qualification projected at read time; archive named-object
readers are not current ingress. See [disclosure](recall.md#source-disclosure).
Public MCP, EventLog and runtime config surfaces have the SemVer obligations
in invariant §25. No internal adapter alone publishes a new public API.

## Runtime Write Model

EventPublisher-owned transitions append EventLog and mutate DB in one SQLite
transaction, then notify via in-process `RuntimeNotifier`; audit precedes
observable broadcast. Storage owns transaction/CAS mechanics, Core and daemon
own runtime truth and effects. A committed mutation is not rolled back by
postcommit notification failure: keep the durable result, invalidate affected
caches and report propagation diagnostics. Field formation,
projection-generation and causal-usage receipts instead persist first and
append EventLog as a separate audit step; a missing append does not erase an
already committed receipt.

An authorized source erase may redact proven source-derived claim
canonicalization and slot-creation payload fields in the same transaction as
the erase barrier and projection cleanup. The original EventLog envelope,
including event identity, type, revision and time, remains unchanged. Redacted
fields are null and carry a typed source-erase marker identifying the barrier;
they are unavailable history, not original values. Independent review and
resolution text is retained. An independent current slot winner keeps its own
subject and support; an erased winner is removed from the current projection.
Startup reapplies existing source barriers to repair dependencies that remain
attributable. Older unindexed interpretation capsules whose source link was
destroyed by a prior erase cannot be attributed to a particular barrier from
their tombstone alone; current consumers must fail closed on invalid dependencies.

Predecessor-bound source replacement is a Core audited capability, not MCP,
CLI or Inspector ingress. It captures request authority once and compares
workspace, logical source, predecessor identity/version/digest inside the
owning top-level transaction; the new revision has later `recorded_at`.
Precommit rejection makes no write; ambiguous commit cannot be represented as
rollback. Postcommit projection-unready, deferred checkpoint, incomplete audit
or notification failure remain different outcomes. A deferred checkpoint is
not a failed projection. A durable predecessor/replacement pair is a source
revision, not reconciliation of independent contradictory reports or semantic
truth. Erasure uses the governed effect and source-closure barrier; source,
interpretation and index projections cannot bypass that transaction.

## Daemon Startup Ordering

1. Open SQLite and migrate before serving; confidential DB and credentials
   stay local. A copied encrypted credential is not portable across users or
   machines without its originating key.
2. Construct Protocol/Core services and a fully wired `EventPublisher` /
   `RuntimeNotifier`; connect governed source readers and Recall. Missing
   notifier is a wiring error, not an implicit no-op.
3. Start Garden only after its services; construct gateway and private
   SourceIndex producer with its local binding and owned lifecycle.
4. Start stdio MCP and daemon HTTP only after dependencies are ready; wire
   CLI fallback. Early tool calls fail closed.

The parent prepares the temporal projection before query-only worker reads;
workers cannot append EventLog or materialize it. Query embedding preparation
runs before the snapshot and stays private to the worker, never caller-supplied
MCP/CLI vectors. SourceIndex producer binding is local-only; absent or API
provider configuration is unbound. It performs bounded capture/backfill and
activation against the selected generation; `root_complete` alone is not
ready. Unbind retires generations and fences old writes. ONNX model artifacts
must already be provisioned, with no implicit network download. Stopping a
background pass or timing out local waiting does not cancel shared inference;
occupancy and cleanup are owned until actual settlement/close. A failed cleanup
cannot advertise a clean retirement or ready index. No mechanism check proves
natural-data benefit.

Shutdown first refuses new requests and drains in-flight handlers. HTTP close
must actually complete; a deadline may close the transport but does not
cancel tracked handlers or release SQLite before they finish. A close error or
timeout is not a successful teardown. Background work and storage release in
reverse dependency order after live handlers settle.

## Signal Ingestion

A-track explicit `soul.emit_*` signals and B-track post-turn Garden extraction
produce candidates, not active truth. `soul.recall` does not enqueue
extraction; its `recent_turn` is ignored. `soul.report_context_usage` may
enqueue `POST_TURN_EXTRACT` from `turn_digest`. Source publication binds
current source, scope and audit before notifying; a failed later optional
memory formation does not delete the source capsule (invariant §20a).
Producer text, extraction cache and normalization never certify source or
model fidelity. Exact source and request identities, complete source corpus,
role attribution, receipts and resource limits belong to their respective
Protocol/SOUL/Core owners. Explicit revisions need fresh authority; failed or
unknown provider attempts stay distinct from unattempted work.

Queued post-turn text is eligible for listing, claiming, compilation and
completion only while its exact admitted source and projection dependencies
remain retained and current in the same workspace. The shared SQLite queue
checks those facts; the daemon owns the unsuccessful completion audit and
quarantine transition. Legacy work with unavailable provenance retains its
private payload and failure history, but exposes no turn text and cannot call
an extraction provider. Maintenance checks at most 100 active tasks per pass
with a workspace-scoped cursor, so quarantine may take multiple calls or
ticks; exact-task claim and completion checks always fail closed. Canonical
source rendering lives in Protocol; SOUL retains its public renderer export
for its grounding and daemon source-publication consumers.

## Low-Trust Draft and Typed-Resolution Chain

Garden's `SignalService.evaluateTriage` and `MaterializationRouter` can create
an eligible `MemoryEntry`, but may only emit a `draft` `ClaimForm`. Merely
carrying evidence refs does not verify them. Runtime governance admits only
`active`, `contested` or `winner` claims. Two reviewer-bound routes can resolve
this state, both audited with the configured reviewer-identity trust mode:

1. **Inline `soul.resolve`:** `confirm`, `reject`, `correct`, `stale`,
   `defer`, `not_relevant`. The claim lifecycle decision and EventLog row share
   a storage CAS transaction; concurrent conflicting decisions cannot both
   win. Slot election follows the committed activation. A confirm reports
   `election_status: failed` if that later election fails, or `pending` while
   another process owns it or its completion audit cannot be recorded. SQLite
   lease ownership and the claim's live state are checked inside each election
   mutation and the completion-audit transaction; expired owners are fenced.
   Repeating the same delivery, reviewer
   and resolution can resume it without another activation audit; a completed
   election audit returns the existing outcome without rerunning election.
   `usage_recording_status` separately reports the post-commit causal
   usage batch. Only an applied allowed confirm can record positive causal usage.
2. **Out-of-band Proposal:** `soul.propose_memory_update` plus
   `soul.review_memory_proposal`; accepted memory updates and privacy erasure
   pass their typed governance and proof/effect barriers. Rejection is not an
   erase or a durable memory change.

Garden task completion reports extraction and emission completion. When a
candidate signal fails materialization, the completion audit and external
completion response expose `failed_candidate_signals_count`; the signal's own
audit retains its detailed outcome. An absent count on older records is unknown.

Inspector originates a review request, never directly persists a promotion.
A warning names its target; agents should not infer it from array position.
`soul.interpretation` invalidation is also inline typed resolution, but only
for one exact unreviewed H and authorized current source. Its EventLog/CAS
archives H without erasing source/history or promoting another interpretation.

## Governance Route Families

| Need | Route | Effect |
| --- | --- | --- |
| Risk before decision | Scoring pressure | Candidate metadata, not a durable decision |
| Must warn during answer | Recall-time `staged_warnings[]` | Warning only |
| Can wait for reviewer | Health/Proposal queue | Review request |
| Typed decision now | Inline resolution | Guarded EventLog and CAS mutation |

Use an existing family before proposing a new MCP verb, storage table or
EventLog family. Agent `GovernancePolicy` classification can mark warnings
`ask_now`, `apply_silently`, `track_only` or `inspect_later`; it does not
create an alternative durable write path. Control-plane objects may bias
execution but cannot silently become MemoryEntry or assertion truth.

## Trust Model

Installed and configured establish setup, not delivery. Delivered means
Alaya returned context; used/skipped require a usage report, and unverifiable
means neither can be proved. Mixed evidence remains mixed. A usage report is a
soft signal, not automatic governance promotion. See invariant §20 and the
[Recall feedback boundary](recall.md#governance-accounting-and-recovery).
