# Recall Algorithm

This page is the in-repo authority for the recall contract and the current live
implementation state (invariant §32). It is not a benchmark-promotion gate and
does not turn a local plan or historical score into product truth.

Current documentation anchor: package `0.3.11`, committed HEAD `892ebde0` on
2026-08-17. The earlier `10da1318` B-arm dump remains historical benchmark
evidence only; it no longer describes the implementation on HEAD.

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
  -> family-max RRF fusion
  -> integrated Slice/path/evidence flood refinement
  -> deep-head relevance
  -> Select_Gamma under eligibility, source, lineage, dimension,
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

| UGAF mechanism | Current state on `892ebde0` | Boundary |
| --- | --- | --- |
| One query time and generation | Live | Preparation captures one `effective_as_of`, pins one active generation, and fails closed when the pin or generation is unavailable. |
| Field candidate membership | Live | Attributed evidence keys are resolved through evidence-bound memory lookup and admitted on the `activation` plane. This can add candidates outside lexical recall. |
| Graph and `PathRelation` expansion | Live | Active, recall-eligible paths can introduce graph-expansion candidates. Direction, lifecycle, sign, and governance are rechecked. |
| Slice/fiber compatibility | Live | Query and source routing keys are matched by `selectSliceCompatibilityV2`; rejected slices withhold fuel. Missing slice material is explicit pass-through, not a fabricated match. |
| Typed path transfer | Live when attributed inflow exists | `resolvePathAxis` consumes `pathInflowByTarget`; unavailable/storage-error/no-inflow states remain explicit and do not count as fuel. |
| Evidence activation | Live | Evidence support vectors and candidate-linked semantic receipts feed fine assessment. Missing support is an explicit no-op. |
| Open-semantic candidate attribution | Live for existing candidates | Accepted semantic solutions are source/evidence attributed and can affect activation. F3-only field membership still needs the closure proof below. |
| Embedding supplement | Live | Embedding may inject candidates and rescore an eligible pool. It never authorizes durable truth. |
| Integrated flood | Live | Flood requires Slice, path, and evidence fuel; the pass-through object score cannot be demoted. Evidence residual scale is an in-code identity constant, not the deleted beta knob. |
| `Select_Gamma` | Live and sole final admission owner | Decision order is materialized as delivery order and asserted after materialization. Packet observations and optional synthesis do not change membership or order. |
| Selection-boundary replay | Live | Generation, condition, inputs, receipts, selected keys, order, and visible digest are captured for deterministic replay. |
| Retrieval-field stop certificate | Live receipt | It binds field captures/refinement receipts to final selection. It must not be confused with projection-bundle frontier control. |
| Projection-bundle progressive opening | Contract present; control proof pending | The current selector computes candidate matches before producing the opened-bundle/stop result. P217 must prove that closed or budget-exhausted bundles cannot leak candidates. |

## Algorithm-closure boundary

The integrated implementation must not be described as a degenerate projection
or as unimplemented. It also must not yet be described as fully closed. Two
specific live-path questions remain:

1. **F3-only membership.** `querySemanticFactorFormationCapture` extends recall
   probes, while the pinned field `QueryConditionReceipt.query_task_factors`
   currently derives from raw query text. A planted candidate reachable only by
   a grounded F3 semantic identity must prove whether that identity can enter
   field candidate membership.
2. **Progressive opening as control.** A planted closed bundle must remain
   invisible until opened, and a budget-exhausted frontier must remain invisible
   with an explicit incomplete result. A stop receipt created after unrestricted
   matching is not closure proof.

The P217 completion gate also requires ordinary SQLite/daemon proof for
field-only, path-only, governance-rejected, direct-read, worker-read, and exact
replay cases. A helper test with a fixed candidate map proves a formula, not
candidate discovery.

If a planted case already passes, preserve the evidence and do not rewrite that
mechanism. If it fails, repair the smallest existing owner; do not create a
second field, selector, query condition, or recall path.

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
| `ALAYA_RECALL_ANSWERS_WITH` | Not parsed by Core. `recallAnswersWithEnabled()` is always true; benchmark provenance may still stamp the historical name. |
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

## Related authority

| Need | File |
| --- | --- |
| Numbered truth, governance, and EventLog rules | [`invariants.md`](invariants.md) |
| Packages, surfaces, write model, and ownership | [`architecture.md`](architecture.md) |
| Current dated readiness posture | [`runtime-snapshot.md`](runtime-snapshot.md) |
| Open engineering issues outside recall closure | [`backlog.md`](backlog.md) |
| Dated full-dataset KPI archives | [`../bench-history/README.md`](../bench-history/README.md) |
