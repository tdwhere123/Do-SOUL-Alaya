# Changelog

All notable changes to Do-SOUL Alaya are recorded here. This file is
the chronological index. Historical per-release trees under
docs/archive were deleted on 2026-08-24 (commit 2b23da6f2).

Current recall algorithm (UGAF target vs live degenerate projection) is
`docs/handbook/recall.md`. Do not treat a historical release section
below as the live ranking recipe.

## Unreleased — protocol 6.4.0

This section is **not a release tag**. App packages remain `0.3.11`
until a matching `## vX.Y.Z` section is opened. Do not tag `Unreleased`.
A GitHub release tag must match the latest published `## vX.Y.Z`
heading (currently `## v0.3.11` below). Protocol 6.4.0 can move
independently of the app semver. `@do-soul/alaya-engine-gateway` is
`0.3.12` for the additive `soul.interpretation` tool surface.

Protocol 6.4.0 adds nested source-semantic expressions. Producers declare scope
through nesting and entities where used; the shared compiler generates canonical
identities and lowers through the existing content compiler. Explicit co-reference,
same-parent content reuse and non-governing references remain distinct semantic
choices. SOUL selects schemas, prompts and revision validation by the recorded
producer contract, preserving v2 raw replay. Canonical H and consumer admission
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
canonical H validation. References and embedded content remain distinct;
orphaned or conflicting scope is rejected rather than asserted. Compilation
and normalization share one resource ledger. Recorded graph proposals retain
their exact request-selected schema and prompt for replay. Canonical H, MCP,
EventLog and config schemas are unchanged; structural admission still does
not certify language completeness.

Protocol 6.0.0 versions source semantics as H v4, Q/A v2, envelope 5,
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
H extraction now uses `source-semantic-proposal-v1`: Protocol derives redundant
embedding self-references and outcome gap copies. Normalizer-v4 records
structurally unaccounted source assertions/evidence and incomplete bindings as
located gaps; Core enforces the same rule during publication and SQLite reopen.
Accounting expansion consumes the resource budget and preserves exhaustion as
a distinct outcome. Historical normalizer-v3 requests and stored H remain
explicit replay/read paths; Core's internal normalized-H publication entrance
requires v4, while MCP propose continues to accept canonical drafts. Canonical H v4 and
response-envelope shapes are unchanged. This provider-free repair does not
certify language completeness or change historical paid extraction verdicts.

Protocol 5.2.0 adds optional bounded path/code/reference diagnostics to invalid
source-semantic outcomes. Interpreted producer envelopes must echo the body's
gaps; H and Q no longer discard conflicting outcome-only gaps, and A rejects
gaps it cannot represent. Matching partial interpretations remain supported.
The producer prompt distinguishes catalog selectors from graph mention handles
and includes a schema-checked neutral example. Batch quarantine retains the
diagnostic and raw response identity. Historical raw responses are not repaired
or relabeled, and new producer prompts use the existing request/cache identity
owner. This engineering repair does not establish actual-model quality.
Q/A proposal preparation now returns its native system prompt as separate
metadata; strict request bodies and MCP schemas are unchanged. Unconsumed
module exports remain private, and unused request type aliases are removed.
H producer guidance now distinguishes argument node targets from mention
evidence and gap locations, with a neutral partial example that anchors an
uninterpreted clause without inventing a frame. Existing reference validation
and historical raw rejection remain unchanged; this does not certify model
source fidelity.

Protocol 5.1.0 is an additive minor under handbook invariant §25. The
opt-in `soul.interpretation` channel adds qualified answer bindings,
per-answer proof forests, located `no_executable_proposition`
dispositions, host-only `unavailable` source reads, optional
`authorized_scopes` admission on the four host operations, and paged
full-H preparation. Structural/normalizer/lowering versions are 2;
version-1 open hypotheses require new explicit preparation, not
relabeling. Operator ownership, named query referents, variable sorts,
non-tree query incidences and fixed-C completion are enforced before
qualified delivery. Source references are revalidated on publish and
reopen. Bounded preparation leases retain candidate/Q/scope identity;
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
