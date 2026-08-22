# Recall Algorithm

This page is the in-repo authority for the recall contract and the current live
implementation state (invariant §32). It is not a benchmark-promotion gate and
does not turn a local plan or historical score into product truth.

Current documentation identity: package `0.3.11`. Architecture
implementation pin is `baa6e35b` (`Close recall architecture authority
gaps`). That commit encodes gates 1–6. Live documentation identity is
this commit (`Pin recall documentation identity after architecture
integration`). Integration base is `b329325`. Historical review evidence
at `263c6600` (2026-08-19) remains prior documentation context. Live
owners are the modules named under Current live path. Canary identity is
this live HEAD — see `.do-it/plans/recall-any5-evidence-first.md`.
This is not a KPI-promotion claim. The earlier `10da1318` B-arm dump remains
historical benchmark evidence only.

2026-08-23 amendment (algorithm evidence pin `3af4fd9`, source baseline
`a03dc5d`): recorded the
`Select_Gamma` query-conditioned marginal-gain contract ruling and its
current implementation gaps under Contract below. This is a documentation-only
boundary correction; no live-path behavior changed.

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
act as an admission objective. Implementation state: the live gain is
`quality` plus a generic saturating `slice`/`f3` cover bonus
(`select-gamma/objective.ts`, cover kinds in
`select-gamma/bind-fine-assessment.ts`). Facility-demand and coverage modules
exist, but `prepareSelectGammaProof` still constructs the generic objective and
the current static production call graph has no caller for
`materializeConfiguredCoverageSelection`; query-conditioned facility coverage
therefore does not yet drive live admission or have a proven production proof
consumer. Closing that design-to-consumer gap is tracked work, not a licence
for a second walk or post-selection reorder.

For a query q, the planned obligation set O_q includes entity, relation, time,
logical-object, independent-evidence, and answer-shape atoms. Gamma gain is
base relevance plus the incremental coverage of unmet atoms in O_q. Source
multiplicity can strengthen activation, but cannot be an admission objective.
Cardinality/enumerative obligations are required for full-gold completeness
claims even if an initial any@5 experiment can proceed without them.

Two additional boundaries are currently open. First, the live selector applies
a hard `evidenceSourceIdentity` duplicate rejection before objective
competition; `lineage` is receipt metadata, not the admission key. This is an
implementation contradiction to the source-multiplicity ruling and is owned by
G17a until the fixed-pool on/off counterfactual and selector-parity receipt
close it. Second, the live facility state is demand-atom based and does not yet
consume distinct OSF answer values. The target consumer must carry answer
variables and binding-value coverage into the same Gamma walk.

### Binding and kind-projection boundary

OSF composition already produces result bindings, variable collections,
distinct-value counts, and evidence IDs. The current candidate attribution and
Gamma path compress that structure to activation/solution-count scalars and a
boolean `f3` cover. The planned producer-to-consumer chain is therefore:

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
  -> Select_Gamma under eligibility, current source hard-dedupe,
     lineage receipt, dimension,
     max-entry, and token constraints
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
| Open-semantic candidate attribution | Live, consumer depth open | Accepted source-bound F3 identities enter `query_task_factors` and can introduce field members as `proposed_routing_only`. Result bindings are not yet carried into candidate/Gamma coverage, and kind projection has no live category consumer. F3 remains rebuildable routing, not durable truth. |
| Embedding supplement | Live | Embedding may inject candidates and rescore an eligible pool when embedding is observed. It never authorizes durable truth, and embedding-off deep-head must not replace fused order. |
| Integrated flood | Live | Flood requires Slice, path, and evidence fuel. The ranking scalar is family-max R_obj; flood and evidence residuals are diagnostic and must not invert a higher object score. Missing slice material is explicit pass-through, not a fabricated match. Evidence residual scale is an in-code identity constant, not the deleted beta knob. |
| `Select_Gamma` | Live and sole final admission owner; objective consumer open | Decision order is materialized as delivery order and asserted after materialization. Packet observations and optional synthesis do not change membership or order. Live gain covers only `slice`/`f3`; current source hard-dedupe and missing binding-value coverage are open G17a/G17b gaps. |
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

This closure covers field membership and selector ordering, not the
query-conditioned facility objective. That objective remains open until the
identical-pool comparison and a production-consumer receipt are both present.

Do not add a second field, selector, query condition, or recall path.

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
