# Recall Algorithm

This page is the in-repo authority for the recall contract and the current live
implementation state (invariant §32). It is not a benchmark-promotion gate and
does not turn a local plan or historical score into product truth.

Current documentation identity: package `0.3.11`, G21 cache-only 100Q
of S14 ranking-preserving Gamma gain (2026-08-24). Earlier pins — architecture `baa6e35b` (gates
1–6), integration base `b329325`, review evidence `263c6600`
(2026-08-19), handbook prose `ae95e313`, last committed code before this
repair `5782391d` — remain historical context. Live owners are the
modules named under Current live path. Recall any@5 is **NOT PROMOTED**:
the last comparable KPI evidence pin is `3af4fd9` (E1 arm: any@5 81/94,
full-gold@5 43/94); G21 cache-only 100Q on this live path is a gate
MISS (E1 63/94, E0 48–49/94); the ancestor
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
`honest_thinner_r_obj` (representation); the E1-only three are a
different owner, `gamma_displaced_fused_head`. S12 and S13 are not a
G21, retune, or promotion licence. This is a documentation pass
against live code, not a KPI claim.

2026-08-24 S14 closeout: Dual-13 is honest no-fix. Fused-head skip is
one general repair on the production binding-aware walk: when
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

The mathematics is the Unified Governed Associative Field (UGAF) read path.
Hopfield, Lyapunov, and attractor language is a design lens, not proved runtime
physics.

## Contract (UGAF)

Recall is one governed associative field, not a stack of independent rankers:

```text
q, S_t -> Q_q -> Omega(H_q, C_seal) -> A(X_q) -> G_L(~X_q)
       -> M(Z_q) -> Select_Gamma -> D_q
```

| Piece | Meaning | Must not |
| --- | --- | --- |
| \(S_t\) | Durable evidence and memory plane | Surface, score, or projection becomes truth |
| \(H_q\) | Typed candidate field with monotone growth | Mid-pipeline top-B authority |
| \(C_q^{seal}\) | Per-channel depth and unseen-frontier proof | Digest claiming closure without a bound |
| \(A_i(q)\) | Attributed multi-channel activation | Global scalar that erases provenance |
| \(G_L\) | Bounded typed path transfer | Second ranker or unbounded flood |
| \(\operatorname{Select}_\Gamma\) | One budgeted marginal-gain walk; order is admission | Reorder after the selected set exists |
| \(D_q\) | Unique evidence pack within entry and token budgets | Later membership change or hidden destructive cut |

Before `Select_Gamma`, an operator may add a grounded candidate, attach
evidence, transfer activation, enforce governance, or materialize a rebuildable
view. It may not silently remove a previously eligible member. `Select_Gamma`
is the one destructive budget cut and its admission order is delivery order.

The `Select_Gamma` marginal-gain objective is defined against the query
condition: gain measures incremental coverage of the query's own answer
set and obligation facets (2026-08-22 contract ruling). The field has no
intrinsic preference for source or dimension diversity; source
multiplicity may only modulate a candidate's activation strength, never
act as an admission objective. Implementation state (2026-08-24): the
production walk objective is binding-aware. `runSelectGammaSession` in
`delivery/fine-assessment-selection.ts` calls
`bindFineAssessmentBindingCover` (`select-gamma/binding-cover/production.ts`),
which binds `bindProductionFacilityWalkObjective` over
`materializeConfiguredCoverageSelection`; the same binding-cover objective
drives `selectGammaWalk` admission and is what `prepareSelectGammaProof`
consumes. Query-conditioned facility coverage therefore drives live admission
and has a production proof consumer. This closure is not a licence for a
second walk or post-selection reorder, and it is not a KPI claim.

For a query q, the planned obligation set O_q includes entity, relation, time,
logical-object, independent-evidence, and answer-shape atoms. Gamma gain is
base relevance plus the incremental coverage of unmet atoms in O_q. Source
multiplicity can strengthen activation, but cannot be an admission objective.
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
  -> one binding-aware Select_Gamma walk
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

## Current live path

The integrated path now present on HEAD is:

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
  -> effective object scoring
  -> family-max RRF fusion (ranking scalar is R_obj)
  -> integrated Slice/path/evidence flood (diagnostics and Gamma cover;
     does not enter the ranking scalar)
  -> deep-head relevance (rescores the pool only when embedding is observed)
  -> Select_Gamma with the binding-aware coverage objective under
     eligibility, object-identity dedupe (source hard-dedupe off),
     lineage receipt, dimension, max-entry, and token constraints
     (positive cover: quality plus Values_v/obligation increment;
     known-zero increment: fused_score minus rho so embedding/facility
     quality cannot invert R_obj; unavailable cover: the same rank-only
     fused_score minus rho fallback, not a proof of zero cover)
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
- final admission and order: `selectFineAssessmentCandidates` and
  `selectGammaWalk`;
- binding-value and facility coverage objective:
  `bindFineAssessmentBindingCover` in
  `select-gamma/binding-cover/production.ts`;
- exact capture/replay: `delivery/selection-boundary/`.

## Connectedness matrix

| UGAF mechanism | Current state | Boundary |
| --- | --- | --- |
| One query time and generation | Live | Preparation captures one `effective_as_of`, pins one active generation, and fails closed when the pin or generation is unavailable. |
| Field candidate membership | Live | Attributed evidence keys are resolved through evidence-bound memory lookup and admitted on the `activation` plane. This can add candidates outside lexical recall. |
| Graph and `PathRelation` expansion | Live | Soft-association `PathRelation` rows introduce path-expansion candidates through `findByAnchors`. The parent temporal+associative merge stays fail-closed until a verified temporal generation exists for the query as-of. |
| Slice/fiber compatibility | Live | Query and source routing keys are matched by `selectSliceCompatibilityV2`; rejected slices withhold fuel. Missing slice material is explicit pass-through, not a fabricated match. |
| Typed path transfer | Live when attributed inflow exists | `resolvePathAxis` consumes `pathInflowByTarget`; unavailable/storage-error/no-inflow states remain explicit and do not count as fuel. |
| Evidence activation | Live | Evidence support vectors and candidate-linked semantic receipts feed fine assessment. Missing support is an explicit no-op. |
| Open-semantic candidate attribution | Live | Accepted source-bound F3 identities enter `query_task_factors` and can introduce field members as `proposed_routing_only`. Result bindings are carried into Gamma coverage through binding-coverage receipts, and Garden `kind_projection` drafts feed production kind-constraint alignment (`kind-projection/production.ts`). F3 and kind remain rebuildable routing, not durable truth. |
| Embedding supplement | Live | Embedding may inject candidates and rescore an eligible pool when embedding is observed. It never authorizes durable truth, and embedding-off deep-head must not replace fused order. |
| Integrated flood | Live | Flood requires Slice, path, and evidence fuel. The ranking scalar is family-max R_obj; flood and evidence residuals are diagnostic and must not invert a higher object score. Missing slice material is explicit pass-through, not a fabricated match. Evidence residual scale is an in-code identity constant, not the deleted beta knob. |
| `Select_Gamma` | Live and sole final admission owner | Decision order is materialized as delivery order and asserted after materialization. Packet observations and optional synthesis do not change membership or order. Binding-aware gain is tri-state: positive incremental cover is quality plus cover; known-zero cover is `R_obj` (`fused_score`) minus rho so embedding/facility quality cannot invert ranking; unavailable cover is that same rank-only fallback, not a proof of zero cover. Production source hard-dedupe is off (object-identity dedupe only). G17a and G17b are closed. S14 ranking-preserve is the known-zero numeric, not a second walk. |
| Selection-boundary replay | Live | Generation, condition, inputs, receipts, selected keys, order, and visible digest are captured for deterministic replay. |
| Retrieval-field stop certificate | Live post-Gamma receipt | It binds field captures/refinement receipts to final selection. There is no pre-Gamma visibility stop receipt. |
| Legal `slice_key` visibility | Live | Ordinary generation exposes every legal `slice_key`. Persisted L2 `opened` and `unseen_frontier_upper_bound` are inert written fields (`true`/`0`) and do not withhold membership. `activation_budget` belongs only to attributed activation. |

## Algorithm-closure boundary

The integrated implementation must not be described as a degenerate projection
or as unimplemented. Planted live-path proof now covers:

1. **F3-only membership.** Formed query captures add accepted semantic
   identities to `query_task_factors`. Source formation emits both the grounded
   surface and the identity as F3 factors. Proposed routing keys can open field
   membership without becoming grounded truth.
2. **Ordinary legal `slice_key` visibility.** `selectPinnedProjectionCandidates`
   matches every legal `artifacts.slice_keys` owner, then runs attributed
   activation. Closed persisted `opened` values cannot withhold membership.

Ordinary SQLite/daemon planted proof now exists for field-only, path-only,
F3-only, and governance revoke. Post-`Select_Gamma` order is proved on the live
selector. In-process query-only worker-read re-resolves already selected
evidence ids and does not re-run pin/select. Selection-boundary replay remains
the exact-order owner when an observer is attached.

This closure covers field membership, selector ordering, and — since the
G17a/G17b closures — the query-conditioned coverage objective with its
production consumer and selection receipts. It is an implementation
claim, not a KPI promotion.

Do not add a second field, selector, query condition, or recall path.

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
Planted falsifier; no miss-ID branch; no G21. S15 recovered the three
KPI E1-only census misses.
G21 100Q then MISSed (E1 63/94); that is not a KPI.

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
| `ALAYA_RECALL_CONF_RHO_PATH`, `ALAYA_RECALL_CONF_RHO_EVIDENCE`, `ALAYA_RECALL_CONF_W_PATH`, flood caps | Parsed advanced runtime parameters. Do not tune them against an unclosed candidate/frontier proof. |
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
last comparable KPI measurement: E1 any@5 81/94, full-gold@5 43/94. It is
diagnostic evidence, not a promotion. Later code — including `5782391d`
and this S14 ranking-preserving gain — has a G21 cache-only 100Q gate
MISS (E1 63/94), not a pin replacement, and the ancestor
`85faef95` missed its diagnostic gates. S12 and S13 dump-only
classification of the remaining E0/E1 miss partition is closed. S14
landed ranking-preserving Gamma gain; it is not a KPI, G21, or retune
licence. G21, retuning, and benchmark promotion are not authorized by
this document.

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
