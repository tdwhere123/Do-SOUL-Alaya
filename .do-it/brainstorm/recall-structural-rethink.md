---
task: Recall end-to-end structural rethink
session_id: recall-root-cause-levers-2026-07-11
created: 2026-07-11
status: open
lenses_run: [product, architecture, algorithm, semantic-representation, pipeline-evidence]
tier: heavy
mode: artifact
---

## Frame

Reassess the complete recall chain after a valid non-vacuous SliceKey experiment
changed rankings but produced zero question-level gold flips, while preserving
the useful concepts and evidence from the archived wave.

## Core Viewpoints

### Product

The product goal is not to maximize graph activity or multi-gold evidence
coverage. It is to retrieve at least one valid answer-bearing memory in the top
five for a query, with explicit abstention and invalid-gold cohorts, while
meeting the sequential latency target.

The current headline mixed three different jobs:

- valid-gold answerable recall;
- official abstention correctness;
- rows whose gold/evaluation contract is invalid.

The new plan must keep these cohorts mutually exclusive and reconstructable.

### Architecture

The existing foundation remains useful:

- governed `PathRelation` truth;
- query-time edge transfer and trace;
- rebuildable SliceKey projection;
- fixed-snapshot A/A/B attribution;
- candidate and rank diagnostics.

The failed premise was treating structural propagation as the main relevance
lever. Path, SliceKey, evidence, and lexical signals currently express related
context more reliably than answer identity. The architecture lacks one
auditable query-to-candidate answer-relevance objective before delivery.

## Supplemental Lenses

### Algorithm

The current SliceKey treatment is subtractive: a compatible edge receives the
same transfer as control, while a known-disjoint edge loses transfer. It cannot
positively reward an answer-aligned edge. `R_obj` is an ordinal RRF sum rather
than a calibrated probability, so using `1 - R_obj` as a likelihood complement
is bounded and monotone but not probabilistically grounded. Multiple later
ranking stages can overwrite local flood intent.

### Semantic Representation

Projection count is not semantic precision. Query keys currently produce broad
semantic and time dimensions; memory keys additionally expose entity, time,
and valued location, but query entity/space production and object-anchor keys
are absent. Existing preference subject/predicate/object/polarity projections
do not participate.

`answers_with` is formed from symmetric high-quality token overlap and
per-node sparsification. It is an association relation, not directional answer
entailment. The selector therefore gates similarity clusters rather than
proving which endpoint answers the query.

### Pipeline Evidence

The valid 100Q result must be decomposed as:

- 6 official abstention rows: 1 correct;
- 5 evaluation/gold-invalid rows: excluded from gold-bearing recall;
- 89 valid-gold rows: 74 top-five hits, or 83.15%.

For the 89 valid-gold rows, first-gold positions are:

- top 5: 74;
- ranks 6-10: 4;
- ranks 11-25: 1;
- ranks 26-50: 2;
- ranks 51-100: 4;
- above 100: 3;
- absent: 1.

An oracle reranker over the existing top 50 can reach `81/89 = 91.0%` on this
sample. Candidate expansion and two-hop propagation are not prerequisites for
crossing 90% here.

## Requirement Shape

The next wave should be an evidence-first relevance redesign, not another
flood-weight or graph-distance wave:

1. freeze a truthful KPI cohort contract;
2. compute stage and top-K oracle ceilings from retained artifacts;
3. test whether query-conditioned answer representations separate gold from
   top lexical distractors;
4. choose a ranking or relation architecture only after the offline probe;
5. run a small sentinel and one paired 100Q only after replay evidence is
   positive.

## Product Boundary

- In scope: recall candidate/rank evidence, query-to-candidate relevance,
  Path/Slice roles, benchmark cohort truth, latency attribution.
- Out of scope: new UI, public MCP/CLI controls, new datastore, blind weight
  sweeps, two-hop implementation, 500Q before a positive 100Q gate.
- Boundary risk: optimizing evidence-set completeness instead of at-least-one
  answer recall can make diagnostics look better without improving any@5.

## Core Goal

Demonstrate, before runtime implementation, a generalizable path that can move
at least seven currently under-ranked valid-gold questions from the retained
top-50 pool into top five without regressing matched controls, while preserving
an executable path to sequential p95 at or below 1100 ms.

## Options

### Option A: Unified query-conditioned reranker

- Ladder rung: minimal custom extension over the existing top-50 pool.
- Benefits: directly targets the proven bottleneck; no candidate expansion or
  datastore migration; easiest deterministic replay.
- Costs: requires one answer-intent representation and removal or subordination
  of conflicting post-rank heuristics.
- Risks: overfitting the sentinel; model latency; incomplete predicate/value
  coverage.
- Choose when: pairwise query/candidate features can recover at least seven
  valid-gold misses with at most one matched-control regression.

### Option B: Conditioned structural features

- Ladder rung: extend existing Path/Slice contracts without replacing the
  ranking pipeline.
- Benefits: preserves the conceptual direction and uses traceable provenance;
  can encode direction, answer role, valid time, and relation confidence.
- Costs: relation formation and possibly additive schema/backfill work.
- Risks: broad association edges may remain non-discriminative; binary gating
  can suppress useful evidence without adding positive relevance.
- Choose when: a relation oracle proves that typed direct edges uniquely
  separate enough gold/distractor pairs.

### Option C: Relation-aware graph replacement

- Ladder rung: full custom algorithm replacing homogeneous NOR propagation.
- Benefits: relation-kind-specific, signed, query-anchored message passing can
  model support, contradiction, supersession, and direction.
- Costs: highest implementation, calibration, latency, and governance burden.
- Risks: topic-neighbor amplification and correlated-evidence double counting;
  two-hop complexity before direct-edge semantics are trustworthy.
- Choose when: an offline direct/two-hop oracle shows unique typed paths for at
  least the required recovery count and simpler reranking cannot do so.

## Architecture Foundation

- Core bottom layer: valid cohort contract, fixed candidate/rank artifacts,
  stage-oracle evaluator, query/candidate answer-intent signature.
- Ownership/contract: one final relevance objective owns top-K ordering;
  Path/Slice/evidence expose features and provenance rather than independent
  competing sort policies.
- Stage closure: establish offline separability and latency budgets before any
  new runtime algorithm or schema.

## Extension Modules

- conditioned Path evidence and relation confidence;
- signed supersession/contradiction transitions;
- bounded graph propagation after direct-edge evidence;
- materialized routing index only after measured read-time cost;
- candidate expansion only for the proven absent or beyond-pool cohort.

## Grill Handoff

### Must Resolve In Grill

- Should the next primary architecture be a unified top-50 query-conditioned
  reranker, a conditioned Path-first design, or a dual-track evidence phase
  that lets offline separability choose between them?
- May memory HQ and existing structured preference/entity/time projections be
  used as rebuildable answer-intent inputs while remaining non-authoritative?
- What exact cohort denominator defines the 90% product gate: valid-gold rows
  only, with abstention and invalid-gold reported separately?

### Can Decide During Planning

- sentinel size and stratification;
- exact internal signature field names;
- whether the first scorer is deterministic or model-assisted;
- profiler instrumentation boundaries;
- artifact retention after oracle extraction.

## Tensions

- The previous conceptual direction correctly separated durable paths,
  runtime transfer, and derived routing, but implementation treated structural
  association as answer relevance.
- Graph structure offers durable explanatory value, while the shortest path to
  the measured KPI is a last-mile reranker over candidates already present.
- A richer representation may improve precision, but adding ontology before
  offline separability is proven would repeat the previous projection-count
  mistake.
