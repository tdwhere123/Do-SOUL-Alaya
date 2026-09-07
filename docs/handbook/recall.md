# Recall Algorithm

This page is the in-repo authority for the recall contract and the current live
implementation state (invariant §32). It is not a benchmark-promotion gate and
does not turn a local plan or historical score into product truth.

### Live versus historical receipts

Do not keep both targets in force as selectable runtime modes. LIVE is this
HEAD: ordinary Recall is the conditional field. Historical `prefixSK` /
`selectGammaWalk` / budget-aware-q text below is a receipt, not a live
selector.

- **LIVE:** `soul.recall` / CLI `alaya tools call soul.recall` →
  `RecallService.recall` → `executeRecall` → `runConditionalFieldRecall`
  (or worker `conditionalField.recall`) → `compileConditionalFieldQuery`
  → `observeField` → `projectAcceptingIndex` → MCP `index` plus same-order
  `results`. Association domain `assoc.bottleneck.milligrade.v1`. Public
  completeness includes `interpretation_coverage` separately from
  `observed_coverage`. Ordinary Recall does not enqueue Garden extract and
  does not call a missing embedding provider. `report_context_usage` may
  enqueue post-turn extract (dual-track). `ranking_authority` /
  `delivery_path` are ignored-on-target (D01). Retired prefix/fusion modules
  remain on disk until D00; they are not reachable from `executeRecall`.
- **Historical (not live):** `prefixSK(S_infty, K)`, optional
  `selectGammaWalk`, and the C01 budget-aware-q / RRF candidate. Those
  sections below stay as immutable receipts. Do not implement from flood /
  SliceKey / "four strategies" prose.

Current documentation identity: package `0.3.11`, the 2026-08-25
relevance-authority and budgeted-capture shadow adjudications plus the sharded
execution plan over G21/S11-S19 evidence. Earlier pins —
architecture `baa6e35b` (gates
1–6), integration base `b329325`, review evidence `263c6600`
(2026-08-19), handbook prose `ae95e313`, last committed code before this
repair `5782391d` — remain historical context. Live owners are the
modules named under Current live path. Recall any@5 is **NOT PROMOTED**:
the last comparable any@5 evidence pin is `3af4fd9` (E1 arm: any@5 81/94;
full-gold@5 43/94 is historical diagnostic reference only, not a gate). G21
cache-only 100Q on this live path is a gate MISS (E1 63/94, E0 48–49/94); the ancestor
`85faef95` missed its diagnostic gates. The earlier `10da1318` B-arm dump
remains historical benchmark evidence only.

2026-08-23 amendment (algorithm evidence pin `3af4fd9`, source baseline
`a03dc5d`): recorded the
`Select_Gamma` query-conditioned marginal-gain contract ruling and its
then-current implementation gaps under Contract below. This was a
documentation-only boundary correction; no live-path behavior changed.

2026-08-24 amendment (documentation identity `ae95e313`): recorded the
G17a/G17b closures, the S11 near-top audit closure, the withdrawal of
complete-form extraction, and the `06af8c83` exclusion of capsule
`evidence_semantic` from independent-embedding Gamma quality.

2026-08-24 docs closeout (against code HEAD `5782391d`): aligned
`architecture.md` with those G17a/G17b closures. S11 remains closed.
2026-08-24 S12 dump-only closeout: the remaining E0 misses are
classified — `d23cf73b` is coverage displacement of a legal fused top-5
gold; all 32 waist questions are honest fused-order family-max walls.
2026-08-24 S13 dump-only closeout: Dual-13 remaining misses are
`honest_thinner_r_obj` under the current family-max scalar; the E1-only three
are a different owner, `gamma_displaced_fused_head`. S12 and S13 are not a
G21, retune, or promotion licence. This is a documentation pass
against live code, not a KPI claim.

2026-08-24 S14 closeout: Dual-13 had no local family-max patch. Fused-head
skip is one general repair on the production binding-aware walk: when
Values_v/obligation increment is 0, gain is `R_obj` (`fused_score`)
minus rho. Embedding and facility quality cannot invert a higher
`R_obj`. Not a KPI claim. G21 later ran and MISSed; pin retained.

2026-08-24 S15 closeout: cache-only 1Q then 3Q of the three KPI E1-only
census misses on the sealed G8 cache, snapshot `6858bca9…`, and the E1
embedding overlay. Golds recovered at final≤5; fused ranks unchanged;
`physical_calls=0`. Not a pin replacement.

2026-08-24 G21 closeout: cache-only 100Q on `32a3250e` is a gate MISS.
E1 any@5 63/94 and full-gold@5 27/94; E0 48/94 control and 49/94
treatment, 21/94 full-gold@5; `physical_calls=0`. Versus ancestor E1
78/94: +4 / −19. Pin `3af4fd9` retained. Not a retune licence.

2026-08-25 S17 dump-only closeout: S11/S12 fused occupiers that win on
`structural` or `temporal_facet` do not violate that stream's own
applicability contract. Zero `producer_ineligible` votes. No producer
repair, no weight change, no generic SliceKey rule. Dual-13 stays
honest no-fix. G21 stays MISS. Pin `3af4fd9` retained.

2026-08-25 S18 read-only closeout: full-gold runtime completeness is
three product semantics (enumerative/aggregate, independent-evidence
diversity, dataset-only extra golds). Evaluator gold count is not a
runtime expected count. No completeness atom and no S16 objective
change. G21 E1 partition independently matches 27/94, 2 absent, 65
all-present-not-delivered.

2026-08-25 relevance-authority ruling: family-max additive RRF is a
**noncompliant scalarization**, not the final UGAF decision algebra. It
suppresses correlated producer duplicates, then discards magnitude and adds
uncalibrated family ballots. Candidate admission also self-rewards through
`structural`, and missing/not-applicable/unavailable states collapse to zero.
Permitted object/factor embedding observations enter fusion and downstream
deep-head/facility/Gamma relevance. The live implementation therefore has one
final selector but more than one query-object relevance authority.

The later location adjudication selected route B: `effectiveScore` is not a
latent canonical relevance estimator and family-max `fused_score` is not target
authority. `effectiveScore` mixes query-independent priors, pool-level state,
and repeated query evidence; embedding has no additive magnitude there. The
target path begins again from original attributed observations and later
retires the `existing_score` recycle lane. S19's sparse rank/Pareto probe is
closed and non-discriminating; it supports aggregation failure but proves
neither a shared scalar nor the replacement's reachability. No weight, RRF,
Gamma, flood, retrieval, cache, or miss-ID repair follows from this ruling.

The mathematics is the Unified Governed Associative Field (UGAF) read path.
Hopfield, Lyapunov, and attractor language is a design lens, not proved runtime
physics.

The historical **query-proof preview** (Psi / compiled Gamma / `prefixSK`)
is a receipt and test/offline vocabulary. It is **not** live and is **not**
the C01 implementation target. C01 TARGET replaces mandatory all-K prefix,
proof-only Psi/Gamma ranking, singleton-CQ gating of ordinary retrieval,
and runtime self-replay. Preview algebra does not authorize cutover:

```text
A(q) -> demand/applicability graph
O(v,q) -> attributed observations with explicit state and provenance
Psi_q(v,u) -> strict safe dominance / incomparable / uncertain
Frontiers(Psi) -> pointwise dominance structure
Gamma_q(v | S, CQ_q) -> query-owned set-dependent marginal strata
Decide_Q(Psi_q, Gamma_q, exact tie, identity) -> one prefixSK walk
```

First-version `Psi` is a strict safe-dominance partial order. A cycle is a
contract failure; general outranking and SCC recovery are deferred. Frontier
index is pointwise structure, never Gamma gain or mandatory F1-before-F2
selection. A lower-frontier candidate may enter only for positive gain on a
compiled Gamma atom that every eligible higher-frontier candidate is proved not
to cover. `Gamma_q` owns only S-dependent answer-binding/position,
required-proposition, and compiler-required certified-independent support
novelty. Same-lineage or
possibly correlated evidence may cover a new binding or required proposition
but cannot mint independence novelty. One canonical walk owns every K, so
`S_K` is a prefix of `S_(K+1)`. V1 has no semantic prior: after exact
query-owned equality and no unresolved trade-off, the tie
policy belongs to the query and deterministic identity is only serialization.

E1 is a monotonic field extension: `H_E0` is a subset of `H_E1`. Its separately
receipted embedding admission cannot evict E0 candidates and creates no
preference. Shared candidates use the same preference/capture algebra and E1
adds one embedding observation. Exact safe-dominance and capture rules remain
unselected until the active plan's boundary audits and capture algebra contract
close; behavior-neutral query-proof preview must precede any delivery cutover.

## Contract (UGAF)

**LIVE / historical query-proof vocabulary.** TARGET selection is in
`## Target algorithm (candidate)` below. This section describes the live
field and the superseded prefix/proof preview.

Recall is one governed associative field, not a stack of independent rankers:

```text
q, S_t -> Q_q -> Omega(H_q, C_seal) -> A(X_q) -> G_L(~X_q)
       -> O_q -> Psi_q -> F_q -> Gamma_q -> prefixSK -> D_q
```

| Piece | Meaning | Must not |
| --- | --- | --- |
| \(S_t\) | Durable evidence and memory plane | Surface, score, or projection becomes truth |
| \(H_q\) | Typed candidate field with monotone growth | Mid-pipeline top-B authority |
| \(C_q^{seal}\) | Per-channel depth and unseen-frontier proof | Digest claiming closure without a bound |
| \(A_i(q)\) | Attributed multi-channel activation | Global scalar that erases provenance |
| \(G_L\) | Bounded typed path transfer | Second ranker or unbounded flood |
| \(O_q\) | Attributed observations with applicability, state, correlation, and uncertainty | Membership or query-independent state impersonates evidence |
| \(\Psi_q\) | Strict safe-dominance relation | Cardinal family sum, general outranking, or cycle recovery |
| \(F_q\) | Pointwise dominance frontiers | Frontier index becomes gain or mandatory selection order |
| \(\Gamma_q\) | Query-compiled set-dependent marginal strata | Pointwise signal, prior, or identity becomes gain |
| `prefixSK` | One budgeted destructive walk; order is delivery | K-specific rerun or reorder after selection |
| \(D_q\) | Unique evidence pack within entry and token budgets | Later membership change or hidden destructive cut |

Before `prefixSK`, an operator may add a grounded candidate, attach
evidence, transfer activation, enforce governance, or materialize a rebuildable
view. It may not silently remove a previously eligible member. Canonical
`prefixSK` is the one destructive budget cut and its admission order is
delivery order; `selectGammaWalk` names only the optional outer legacy delivery
implementation, not the future query-proof rollback target.

The target `Gamma_q` objective is defined against the query condition: gain
measures incremental answer-binding/position, required-proposition, and
compiler-required certified-independence coverage. The first two increments remain legal for
same-lineage evidence when it covers a new compiled query unit; only the third
requires certified independence, and that coordinate remains structural zero
when `CQ_q` carries no independent-support obligation. The field has no
intrinsic preference for source identity diversity. Pointwise frontier index,
embedding/facility/temporal evidence, admission source, and prior do not enter
gain or cross-frontier admission. Scoring and cross-frontier admission use the
same compiled Gamma atoms and standings. The `Gamma_q` tuple is lexicographic:
positive gain in an uncovered higher stratum cannot be preceded by lower-stratum-only or
zero gain among resource-feasible candidates. V1 has no semantic
prior; only a query-owned exact tie may precede identity. Coverage availability
must not switch pointwise preference. Legacy
implementation state
(2026-08-24): the
production walk objective is binding-aware. `runSelectGammaSession` in
`delivery/fine-assessment-selection.ts` calls
`bindFineAssessmentBindingCover` (`select-gamma/binding-cover/production.ts`),
which binds `bindProductionFacilityWalkObjective` over
`materializeConfiguredCoverageSelection`; the same binding-cover objective
drives `selectGammaWalk` admission and is what `prepareSelectGammaProof`
consumes. Query-conditioned facility coverage therefore drives live admission
and has a production proof consumer. This closure is not a licence for a
second walk or post-selection reorder, and it is not a KPI claim.
The 2026-08-25 audit additionally found that facility base relevance consumes
the independent embedding map when present, while zero/unavailable cover
consumes `fused_score`. That piecewise A-type relevance source is current
runtime behavior and a diagnosed contract violation, not target semantics.

For a query q, the current implementation's facility vocabulary still includes
entity, relation, time, logical-object, independent-evidence, and answer-shape
facets. Those live coordinates do not define the target tuple. Target `Gamma_q`
gain is only the query-compiled lexicographic strata: answer binding/position,
required-proposition support, and compiler-required certified-independent
support. Live facility/`Values_v`/content-id remainder is current implementation
behavior, not target scoring or cross-frontier admission. Pointwise safe-dominance/frontier
structure constrains and explains capture but is not added as
`FrontierPriority`. Source identity is not an admission-diversity key.
Cardinality/enumerative obligations are required for full-gold completeness
claims even if an initial any@5 experiment can proceed without them.

Two previously open boundaries are closed (2026-08-24). G17a: production
admission runs with source hard-dedupe off
(`PRODUCTION_SELECT_GAMMA_SOURCE_HARD_DEDUPE = false` in
`select-gamma/admission/identity.ts`), so duplicate rejection is
object-key only and source multiplicity is never an admission key; the
selection receipt records the active policy. G17b: distinct OSF answer
values are consumed — answer variables and binding-value coverage enter
the one Gamma walk through `bindFineAssessmentBindingCover` and
`bindProductionFacilityWalkObjective`, with per-candidate
binding-coverage receipts and a selected binding-set receipt.

### Binding and kind-projection boundary

OSF composition already produces result bindings, variable collections,
distinct-value counts, and evidence IDs. The producer-to-consumer chain
is live on the current HEAD:

```text
OSF result binding
  -> candidate binding-coverage receipt
  -> query answer variables and obligation facets
  -> legacy binding-aware selectGammaWalk
  -> selected binding-set receipt
```

For answer variable v, the marginal term is the increase in distinct
`Values_v`, alongside relevance and ordinary obligation coverage. Redundancy
is bounded by content and lineage; source multiplicity is not a diversity
quota.

Kind/category evidence is a separate, rebuildable projection. Before any
large cache rebuild, a fixture must prove
`answer_kind_constraint -> kind_projection -> spotify binding`, preserve
`spotify` as the referent, and reject an invalid projection without rejecting
the base grounded graph. The projection is tied to the base graph digest and
factor id and has its own producer, digest, and rejection receipt. It is not a
plain optional field whose schema failure can invalidate the strict base OSF
graph, and it never becomes durable truth.

Do not add another fusion stream, promoter, duplicate reranker, consensus
reorder, or head-drop rule to repair benchmark coverage.

## Target algorithm (candidate)

C01 freezes one deterministic heuristic. It is not a global exact solver and
does not preserve an all-K prefix. Missing optional CQ/F3/OSF changes
supported claims, not whether ordinary retrieval may run.

```text
source/turn ingress
  -> one SQLite txn: source + EventLog + raw/lexical projection + work intent
  -> durable ack (no provider wait)
  -> bounded async enrichment
  -> admitted artifact + changed projection
Recall
  -> capture QuerySpec and ready snapshot once
  -> lexical / local embedding / typed-relation families -> one field
  -> singleton evidence units + packets from actual typed edges
  -> one budget-aware selector -> one DecisionResult
  -> claim safety and one serialization
```

Relevance (each family at most once; ranks start at 1):

```text
R(v) = sum_f 1 / r_f(v)
```

Sort by descending `R`, then stable evidence identity. `Q(S)` is lexicographic:
fully satisfied explicit grounded obligations; distinct grounded answer
bindings when enumeration is requested; sum of `1/r(v)` over unique selected
units. Greedy step maximizes marginal `Q` / incremental charged-token
ceiling. Exact ties: fewer incremental tokens, then canonical identity.
Track the best feasible single packet during the same scan; compare once;
refill from that seed at most once. Stop when no positive-gain addition
fits or the work limit is reached. Order inside the selected set uses acyclic
evidence dependency, else frozen relevance/identity.

Resource policy: independent `N_base`/`N_extension` and `R_base`/`R_extension`.
Baseline probes are lexical plus query-applicable typed relation. Extension
probes are embedding and discovery seeded by those results. Unused extension
capacity is not lent to baseline. Packet cap `M`, width `W`. Charge one UTF-8
byte as one token plus a fixed nonempty-result envelope. K counts coalesced
public memory/evidence objects. Numeric constants: C01 worklog
`v2-c01-target-contract.md`. C08 deletes LIVE `prefixSK` / `selectGammaWalk`
together with the normal-entry switch.

## Current live path

Ordinary production Recall has one owner: the conditional field. There is no
`fineAssess` delivery switch and no live `prefixSK` / `selectGammaWalk`
selector.

```text
accepted EventLog / SQLite
  → pin + bounded readers
  → compileConditionalFieldQuery
  → observeField (observers + field engine + evidence)
  → projectAcceptingIndex
  → executeRecall / worker RPC conditionalField.recall
  → MCP soul.recall encodes index.entries (same order as results)
```

Continuation identity is `query_id`, `snapshot_id`, `interpretation_id`
(clock), `as_of`, `continuation_id`. Its expiry uses the current request clock,
separately from the interpretation clock. Both direct and worker paths check
the actual source/projection identity before restoring field state.
`FIELD_RESUME` belongs to the reader process lifetime, not SQLite; a missing
retained instance invalidates its continuation. Worker RPC returns index plus
payload previews captured under its read lifetime.

Query conditions own anchor admission and persistent variable bindings.
Repeat/closure operators declare their local variables explicitly; advancing
an edge cannot overwrite a persistent service binding. Uninterpreted query
meaning and unobserved predicates remain visible as incomplete knowledge.

Accepting product states own their roles, propositions and grounded explanation
roots. Supported association context does not prove a requested common cause:
the query declares that proposition, and the public index retains its typed
meaning and claim state. Derivation alternatives retain their source dependencies
so withdrawal and bounded explanation recovery use the same accepted field.
Observer coverage, logical index progress, transport and payload completion
are separate; unfinished observation or explanation work requires recoverable
progress under the request allowance.

Witness usage reports name an exposed explanation and its query, snapshot,
interpretation and as-of identity. The existing delivery/report persistence
records and validates that exposure, including reports after restart. Object
and output reports remain at their declared granularity; reports do not revise
relation strength or establish proposition truth. The local protocol 4.0.0
candidate follows the major semantic-change rule in invariant §25 and is
unreleased.

The following prefixSK / Select_Gamma composition is historical and is **not**
the live entry. Mixed stages remain impossible because those owners are not
on `executeRecall`.

The historical prefixSK composition (not live, not on `executeRecall`) was:

```text
prepare
  capture one effective_as_of
  pin one active projection generation
  select attributed field candidates under one query condition
  resolve selected evidence identities to memory candidates

candidate field
  lexical/FTS + exact/trigram + temporal + entity
  + field projection + graph/PathRelation expansion
  + global + synthesis + embedding injection

assessment
  collect routing keys, evidence support, path inflow, governance,
  semantic activation, and field receipts
  -> effective object scoring (current prior/relevance mixture;
     legacy, not target authority)
  -> family-max RRF fusion (current fused_score/R_obj scalar;
     diagnosed noncompliant, not target preference/capture algebra)
  -> integrated Slice/path/evidence flood (diagnostics and Gamma cover;
     does not enter the ranking scalar)
  -> deep-head relevance (independently rescores the pool when embedding is
     observed and also supplies coverageRelevance; diagnosed second
     relevance authority)
  -> Select_Gamma with the binding-aware coverage objective under
     eligibility, object-identity dedupe (source hard-dedupe off),
     lineage receipt, dimension, max-entry, and token constraints
     (positive cover: quality plus Values_v/obligation increment;
     known-zero increment: fused_score minus rho so embedding/facility
     quality cannot invert R_obj; unavailable cover: the same rank-only
     fused_score minus rho fallback, not a proof of zero cover.
     decomposeGain.coverage is 0 when unavailable; rank-only parts do
     not satisfy quality+coverage=gain. Truncated composition may
     still show a positive increment; a zero increment under truncated
     is unavailable, not known-zero. Last-slot losers under rank-only
     are rank_displaced, not quality_displaced.)
  -> ordered ContextPack and selection-boundary receipt
```

The principal owners are:

- query condition and generation pinning:
  `prepareRecallRequest`, `RecallFieldQuerySession`, and
  `selectPinnedProjectionCandidates`;
- field candidate introduction: `resolveFieldProjectionMemories` and
  `buildFieldProjectionCandidate`;
- graph/path candidate introduction: `structural-expansion.ts`,
  `path-expansion.ts`, and the daemon recall path read ports;
- Slice compatibility: `resolveSliceAxis` in `flood-slice-axis.ts`;
- path/evidence flood: `computeIntegratedFloodScore` in
  `integrated-flood-scoring.ts`;
- final admission and order: canonical `prefixSK`
  (`deliverCanonicalFineAssessment`) or, on `delivery_path: "legacy"`,
  `selectFineAssessmentCandidates` and `selectGammaWalk`;
- binding-value and facility coverage objective:
  `bindFineAssessmentBindingCover` in
  `select-gamma/binding-cover/production.ts`;
- exact capture/replay: `delivery/selection-boundary/`.

## Connectedness matrix

This matrix is a **historical receipt** of the retired prefixSK / flood /
Select_Gamma stack. It is **not LIVE**. LIVE recall is the conditional-field
chain in the box at the top of this page.

| UGAF mechanism | Current state | Boundary |
| --- | --- | --- |
| One query time and generation | Historical receipt | Preparation captured one `effective_as_of`, pinned one active generation, and failed closed when the pin or generation was unavailable. |
| Field candidate membership | Historical receipt | Attributed evidence keys were resolved through evidence-bound memory lookup and admitted on the `activation` plane. This could add candidates outside lexical recall. |
| Graph and `PathRelation` expansion | Historical receipt | Soft-association `PathRelation` rows introduced path-expansion candidates through `findByAnchors`. The parent temporal+associative merge stayed fail-closed until a verified temporal generation existed for the query as-of. |
| Slice/fiber compatibility | Historical receipt | Query and source routing keys were matched by `selectSliceCompatibilityV2`; rejected slices withheld fuel. Missing slice material was explicit pass-through, not a fabricated match. |
| Typed path transfer | Historical receipt when attributed inflow existed | `resolvePathAxis` consumed `pathInflowByTarget`; unavailable/storage-error/no-inflow states remained explicit and did not count as fuel. |
| Evidence activation | Historical receipt | Evidence support vectors and candidate-linked semantic receipts fed fine assessment. Missing support was an explicit no-op. |
| Open-semantic candidate attribution | Historical receipt | Accepted source-bound F3 identities entered `query_task_factors` and could introduce field members as `proposed_routing_only`. Result bindings were carried into Gamma coverage through binding-coverage receipts, and Garden `kind_projection` drafts fed production kind-constraint alignment (`kind-projection/production.ts`). F3 and kind remain rebuildable routing, not durable truth. |
| Embedding supplement | Historical receipt, relevance role noncompliant | Embedding could inject candidates, cast the semantic family ballot, modulate graph/path contribution, independently rescore the pool, and supply facility relevance. It never authorized durable truth. The query-proof target made E1 a monotonic field extension: admission could not evict E0 or create preference, and shared candidates added one embedding observation only. |
| Integrated flood | Historical receipt | Flood required Slice, path, and evidence fuel. The ranking scalar was family-max `fused_score`; flood and evidence residuals were diagnostic. This preserved one scalar mutation path but did not validate family-max as canonical relevance. Missing slice material was explicit pass-through, not a fabricated match. Evidence residual scale was an in-code identity constant, not the deleted beta knob. |
| `Select_Gamma` | Historical receipt: optional outer legacy path; canonical default was `prefixSK` | Omitted `delivery_path` used `prefixSK(S_infty, K)`. `delivery_path: "legacy"` kept `selectGammaWalk` as the sole admission-order owner of that mode. Canonical `relevance_score` was not ranking authority (`ranking_authority: "prefix_sk"`). Legacy positive-cover gain still used embedding/facility quality plus cover; known-zero and unavailable used `fused_score` minus rho. The query-proof target permitted only query-compiled answer-binding/position, required-proposition, and compiler-required certified-independent support strata, with the same atoms governing scoring and cross-frontier admission in one prefix-monotonic walk. Production source hard-dedupe was off. |
| Selection-boundary replay | Historical receipt on `delivery_path: "legacy"`; canonical-absent | Legacy capture/replay remained. Canonical delivery used `shadowTrace` / capture prefix and did not attach `selectionBoundaryObserver`. |
| Retrieval-field stop certificate | Historical post-Gamma receipt | It bound field captures/refinement receipts to final selection. There was no pre-Gamma visibility stop receipt. |
| Legal `slice_key` visibility | Historical receipt | Ordinary generation exposed every legal `slice_key`. Persisted L2 `opened` and `unseen_frontier_upper_bound` were inert written fields (`true`/`0`) and did not withhold membership. `activation_budget` belonged only to attributed activation. |

## Algorithm-closure boundary

LIVE planted proof is the conditional-field chain in the box at the top of
this page: source/SQLite observation through `observeField` to an information
index on `soul.recall`. The F3-only / `slice_key` / `selectGammaWalk`
paragraphs below are **historical receipts** of the retired stack. They are
not live connectedness proof and must not be implemented from.

Historical receipt (not live):

1. **F3-only membership.** Formed query captures added accepted semantic
   identities to `query_task_factors`. Proposed routing keys could open field
   membership without becoming grounded truth.
2. **Ordinary legal `slice_key` visibility.** `selectPinnedProjectionCandidates`
   matched every legal `artifacts.slice_keys` owner, then ran attributed
   activation.

Those receipts remain in the archive. Do not treat them as the current entry.

This closure covers field membership, selector ordering, and — since the
G17a/G17b closures — the query-conditioned coverage objective with its
production consumer and selection receipts. It is an implementation
claim, not a KPI promotion.

It does **not** close Recall decision algebra. Neither live `effectiveScore` nor
family-max `fused_score` is TARGET authority, and deep-head/facility embedding
is another LIVE pointwise path. The C01 TARGET in `## Target algorithm (candidate)`
owns the replacement selector. Do not describe connectedness or shadow presence
as algorithmic correctness, and do not lower the fixed E0 >=85/94 and E1 >=90/94
gates.

**LIVE:** do not add a second field, selector, query condition, or recall path
while the conditional field remains the production owner. Historical
`prefixSK` / `selectGammaWalk` stay unreachable from `executeRecall` until
D00 deletes them. Dual LIVE/TARGET runtime modes are forbidden.

## S11 near-top audit (closed)

S11 asked whether near-top E0 misses (E0/E1 are the fixed diagnostic
arms of the `3af4fd9` evidence pin) were caused by the diagnostic
evidence residual inverting a higher object score. The audit of the ten
near-top E0 cases found ten of ten `honest_higher_r_obj`: the admitted
competitor genuinely carried the higher `R_obj` ranking scalar. No
residual inversion was observed, so S11 authorizes no ranking change.
Related hardening: `06af8c83` excludes capsule `evidence_semantic` from
the independent-embedding quality channel, so a foreign capsule
similarity cannot buy `Select_Gamma` quality.

## S12 waist and coverage audit (closed)

S12 asked, on the same E0-control dump as S11, whether the remaining 33
misses were a forbidden residual inside composition or a coverage
displacement of a legal fused top-5 gold. The one coverage case
(`d23cf73b`) is `coverage_displaced_fused_top5`: gold fused rank 5 was
pushed to delivered rank 7. All 32 waist questions are
`honest_waist_r_obj`: every fused-order top-5 occupier carries a
strictly higher legal family-max `R_obj` than the best gold. No fused
residual inversion was observed. S12 authorizes no ranking change, no
weight retune, and no G21 launch. G21 later measured cache-only 100Q
on `32a3250e` and MISSed.

## S13 remaining-miss partition (closed)

S13 asked, on the S11 E0-control dump plus E1 `T055902Z`, whether the
remaining misses share one owner. They do not. Dual-13 (E0 ∩ E1) is
fused-order `honest_thinner_r_obj`: gold legal family-max is strictly
below the fused-order top-5 minimum (representation split
`same_family_weaker` / `gold_missing_family` / `capsule_sparse_families`).
Embedding semantic ≈0.010–0.016 does not close 12/13. The E1-only
three (`001be529`, `6f9b354f`, `726462e0`) are
`gamma_displaced_fused_head`: gold stays in fused head with family-max
above every delivered occupier, and Gamma `selection_order` is past
budget. S13 authorizes no ranking change, no weight retune, and no G21
launch.

## S14 general repair vs point fix (closed)

S14 asked whether Dual-13 `honest_thinner_r_obj` and E1-only
`gamma_displaced_fused_head` are general producer-to-consumer defects.
Dump census on the same E0/E1 snapshots: fused-head golds whose
family-max strictly exceeds every delivered occupier miss delivery on
7/46 E1 in-class questions and 0/17 E0. Dual-13 formation did not
prove a dropped producer ballot. One general repair landed: production
`createBindingAwareWalkObjective` uses `fused_score` minus rho when
Values_v/obligation increment is 0. Unavailable cover uses that same
numeric as an explicit rank-only fallback, not as proof of zero cover.
Last-slot losers under that fallback are `rank_displaced`. Truncated
composition cannot prove known-zero. Planted falsifier; no miss-ID
branch; no G21. S15 recovered the three
KPI E1-only census misses.
G21 100Q then MISSed (E1 63/94); that is not a KPI.

## S17 query-conditioned family eligibility (closed)

S17 asked, on the same E0-control dump as S11/S12, whether fused-order
top-5 occupiers that win on `structural` or `temporal_facet` violate
that winning stream's own applicability contract. They do not. Across
42 questions (10 S11 near-top + 32 S12 waist) there are 210 fused
occupiers: 112 structural, 79 `temporal_facet`, 19 out of family. Zero
`producer_ineligible` votes. In-family winning streams are
`existing_score` (91 winning slots, not 91 top-5 questions; always-on
`clamp01(effectiveScore)`),
`temporal_recency` (60, query window or documented no-`date_terms`
recency fallback after `hasTemporalQuerySignal` lifts weight to 4),
`evidence_structural_agreement` (21, both legs present), and
`subject_alignment` (19, `mixed_unproven` because entry content and
preference-profile fields are unobserved). Question rollup: 35
`honest_strength`, 7 `mixed_unproven`, 0 `producer_ineligible`.
Family-max already collapses within-family density. Dual-13
`same_family_weaker` remains a counterexample to a universal dense-family
claim. This establishes duplicate suppression only; it does not validate
cross-family addition or missing-family semantics. S17
authorizes no producer repair, no weight change, no generic SliceKey
rule, no Dual-13 retune, and no G21. The canonical authority adjudication
supersedes the algorithm-level no-fix interpretation. Pin
`3af4fd9` retained. Latency stays NOT_VERIFIED.

## S18 full-gold runtime completeness (closed, read-only)

S18 is a read-only historical semantics card (no production change). In that
legacy-path run, full-gold@5 and any@5 shared the same delivered set and one
`Select_Gamma` objective. Evaluator gold count is **not** a runtime expected
count. Full-gold has no current hard KPI threshold: report both E0/E1 arms and
seek improvement, while treating historical E1 43/94 only as reference data
until a current source-bound baseline and grounded product completeness
contract exist.

Independent recompute of G21 E1 `2026-08-24T094913Z` matches the
partition: 94 scorable, 27 full-gold@5, 67 failures, 2 questions with
at least one absent gold (`gpt4_15e38248`, `gpt4_f2262a51`), 65 with
every gold in-pool but not all delivered, 63 multi-gold. Ancestor E1
has the same two absent ids; the 65 (versus ancestor 53) is the G21
full-gold drop 39→27 on that shared set. Cite
`.do-it/bench-runs/recall-any5-evidence-first/s18-dump/partition.json`.

Three product semantics, detected from query/evidence, never from the
gold list:

1. **Explicit aggregate or enumeration** (`count`, `sum`,
   `distinct_entities` via `compileRecallAnswerShapePlan`). Shape
   detection is live and receipt-only; it does not enter Gamma gain.
   Distinct `Values_v` is the live enumerative cover increment when OSF
   composition is `composed`. On G21 E1 composition is `unavailable`
   100/100, so Values_v does not apply. No producer currently emits an
   expected cardinality K.
2. **Independent evidence / support diversity.** Facility
   `independent_evidence` demand and Values_v diversity are the live
   path. Source multiplicity is not an admission quota (G17a). This
   100Q has zero query `evidence_ref` demands.
3. **Dataset-only multiple acceptable golds.** The runtime query
   carries no expected count. Extra evaluator golds are acceptable or
   supporting answers. This remains evaluator-only.

Cardinality/enumerative obligations named in Contract above remain
required for a full-gold *completeness claim*, and they must come from
query/evidence authority. S18 does not add a completeness atom, does
not copy gold cardinality into `O_q`, and does not change the S16
tri-state (positive / known-zero / unavailable; unavailable is
rank-only `fused_score − rho`).

## Semantic formation boundary

The model is optional semantic proposal machinery, not the source-admission or
truth authority:

```text
immutable source/span
  -> deterministic F0-F2 incidence
  -> optional source-bound F3 proposal
  -> runtime grounding and versioned soft projection
  -> governed recall field
```

Complete-form extraction is withdrawn (2026-08-24). This boundary is
immutable; no complete-form extraction stage may be added around it.

Provider failure, empty output, or invalid F3 cannot delete root evidence or
deterministic F0-F2 material. A model cannot directly write
`RelationAssertion`, `PathRelation`, `ClaimForm`, governance state, or learning
effects. The algorithm-consumer contract is proved with provider-neutral
fixtures before a final provider prompt is selected.

## Configuration names that can mislead

| Name | Current fact |
| --- | --- |
| `ALAYA_RECALL_PROJECTIONS` | Default-on read-side scoring control. It is not projection-generation authority and does not prove field connectedness. |
| `ALAYA_RECALL_CONF_RHO_PATH`, `ALAYA_RECALL_CONF_RHO_EVIDENCE`, `ALAYA_RECALL_CONF_W_PATH`, flood caps | Parsed advanced runtime parameters. Unset `ALAYA_RECALL_CONF_FLOOD_CAP` (or `1.0`) means no flood suppression. Do not tune them against an unclosed candidate/frontier proof. |
| `ALAYA_RECALL_CONF_EVIDENCE_BETA` | Deleted from the runtime contract. Legacy tests/manifests may reject or strip it; it is not a live scoring knob. |
| `ALAYA_RECALL_ANSWERS_WITH` | Not parsed by Core. answers_with / flood path fuel has no off-switch; benchmark provenance may still stamp the historical name. |
| `ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP` | Parsed for compatibility/provenance but has no production delivery consumer. It must not become a post-`Select_Gamma` reorder authority. |

## Historical benchmark evidence

The 2026-08-14 B-arm dump at `10da1318` recorded 19,431 candidates and
18,344 answerable candidates, with snapshot digest
`7cac6e0d1ebdb89761546c26516a1a6722556f0e4f617145436ff38a51500a6a`
and KPI digest
`ed061c008db5603c5f53ef3d3d84c7d20a598774751aee6c5a0a75795827642a`.
It correctly described that old commit's inactive path/Slice behavior. It must
not be used to describe current connectedness or to claim a current score gate.

The 2026-08-23 evidence pin `3af4fd9` (source baseline `a03dc5d`) is the
last comparable any@5 measurement: E1 any@5 81/94; full-gold@5 43/94 is
only its historical secondary-metric reference. It is
diagnostic evidence, not a promotion. Later code — including `5782391d`
and this S14 ranking-preserving gain — has a G21 cache-only 100Q gate
MISS (E1 63/94), not a pin replacement, and the ancestor
`85faef95` missed its diagnostic gates. S12 and S13 dump-only
classification of the remaining E0/E1 miss partition is closed. S14
landed ranking-preserving Gamma gain; it is not a KPI, G21, or retune
licence. S17 closed query-conditioned family eligibility dump-only with
no producer repair; legal votes do not validate family-max algebra. S18 closed
the full-gold runtime-semantics card
read-only: evaluator gold count is not a runtime expected count. G21,
retuning, and benchmark promotion are not authorized by this document. Active
execution starts at `.do-it/plans/recall-any5-evidence-first/README.md`; S19 is
closed and must not be rerun as a target proof.

Historical scores, caches, and fixed-candidate replays remain diagnostic
evidence. Promotion requires a current source-bound authority, real candidate
discovery, identical control/treatment substrate, and a fresh native benchmark.
The pre-`263c6600` MiMo cache lacks a sealed completion witness and is therefore
retained only as historical bytes; it cannot authorize replay, snapshot, or
score claims. A new completion-witness-bearing cache must be generated in a new
root before the credentialless 1Q -> 3Q -> 100Q diagnostic ladder can begin.

## Related authority

| Need | File |
| --- | --- |
| Numbered truth, governance, and EventLog rules | [`invariants.md`](invariants.md) |
| Packages, surfaces, write model, and ownership | [`architecture.md`](architecture.md) |
| Current dated readiness posture | [`runtime-snapshot.md`](runtime-snapshot.md) |
| Open engineering issues outside recall closure | [`backlog.md`](backlog.md) |
| Dated full-dataset KPI archives | [`../bench-history/README.md`](../bench-history/README.md) |


### Historical revision-2 repair clarifications (superseded)

This subsection records the superseded rank-fusion candidate and its original
gates. It is not the current algorithm, current repair acceptance, or authority
to activate a retained selector. The conditional-field path above owns current
Recall; its cumulative candidate review covers the repaired implementation.

Historical C01/C02 local receipts are not acceptance evidence for the current
source. The superseded candidate arithmetic compares
exact rational family fusion and marginal gain divided by incremental cost once;
an exact density tie chooses fewer tokens, then ascending unit identity sequence.
Unused baseline new-identity capacity is not lent to the extension stage.

The existing MCP request `since`, `until`, and `time_field` keep their explicit
storage-time filtering meaning. Assertion valid-time is a separate typed
operator evaluated at the captured as-of; ingestion or storage timestamps never
substitute for source validity. No new MCP request fields are introduced here.
`delivery_path` and `ranking_authority` in the existing MCP search schema are
response metadata. The internal explicit `RecallPolicy.fine_assessment.delivery_path`
values `legacy` and `canonical` are both unsupported by the target candidate;
omitted mode selects the sole target algorithm after authorized cutover.

`GlobalMemoryRecallService` is reachable through daemon global-memory runtime
wiring and the core global-memory port. Its query-result LRU must be removed
from that runtime route at C08, with source reads routed through the sole target
selector; retaining it as an optional runtime route is not a disposition.
Historical readers may decode old authority values but must never dispatch a
selector. The candidate compatibility/deletion handoff and retained historical
reader versions are recorded in
[the C01 amendment 07](../../.do-it/worklog/recall-unified-algorithm-hard-cutover-2026-09-04/v2-c01-compatibility-amendment-07.md)
and its companion census. This is an unreviewed candidate handoff; C10 still
must materialize and verify the exact binary/config/schema/data rollback tuple.

The candidate's 64-byte envelope is a framing allowance, not rendered content.
Actual rendered bytes are the concatenation of identity, newline, source text,
and newline for each immutable selected entry. The repaired W7 fixtures exercise
actual `cl100k_base` and `o200k_base` ordinary encoding with an identified local
tokenizer implementation and asset manifest, including coalesced spans, headers,
both dependency orders and concatenation merges. Host tokenizer hints remain
requests, not profile admission evidence; the character estimator and MiniLM
tokenizer do not establish that host boundary.
Existing per-dimension limits in `RecallBudgetsSchema` count distinct delivered
entries per dimension; the candidate enforces these counts on each incremental
union, including overlapping proposals. The bounded local measurements and
their acceptance envelopes are recorded in
[the measured C02 amendment 06](../../.do-it/worklog/recall-unified-algorithm-hard-cutover-2026-09-04/v2-c02-measured-contract-amendment-06.md).
They distinguish returned rows, native predicate visits, payload/driver bytes,
phase work, preparation time, elapsed time and RSS; the selector counter is not
a measurement of all physical work or a deployment latency guarantee.


The repaired candidate bounds typed support to 512 admitted edges, 64 obligations,
and four predicate steps; overflow fails explicitly. The selector indexes units
and assignment buckets once. Its inspection allowance is
`5 * (selected_count + packet_width + support_work + 1) + packet_width + 1`,
where `support_work = 12 * sum(bucket_rows * (predicate_count + 3)) + obligation_count`.
This is a conservative decision inspection allowance, not measured CPU instructions.
The default shared decision allowance is `2 * K * M * (W + 1)`; an incomplete
scan returns the preceding complete feasible state with truncation. This fixes
the previous mismatch between the abstract `2*K*M` budget and charged member
visits. Formation has its own finite edge/obligation limits and reports its
bounded construction work separately. The measured amendment binds local
latency/RSS fixtures and raw observations independently of these integer bounds.
These repaired candidate proofs do not install a runtime, certify full-dataset
performance, or approve STOP-01. W01/W02 reuse the shared owners; C08 replaces
the actual entry; C10/STOP-02 retain their compatibility and activation gates.
