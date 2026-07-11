---
task: Recall end-to-end structural rethink
session_id: recall-root-cause-levers-2026-07-11
created: 2026-07-11
status: open
brainstorm: recall-structural-rethink
---

## Items tested

- [x] **The apparent 86.4% to 75% change proves an 11.4-point algorithm regression.**
  - kind: fact
  - status: refuted
  - evidence: the historical 500Q scores 86.4% overall but 83/100 on the
    current stratified IDs; five further points come from old 6/6 abstention
    hits versus the current 1/6 contract. The remaining answerable difference
    is 77/94 versus 74/94 and is not paired because historical seeds/topology
    were not frozen.

- [x] **The current gold-bearing score is 74/94.**
  - kind: fact
  - status: refuted
  - evidence: current KPI classifies five non-abstention rows as
    `evaluation_or_gold_issue`; the valid-gold cohort is 74/89 = 83.15%.

- [x] **Candidate generation or two-hop propagation is required to cross 90% on the retained 100Q sample.**
  - kind: fact
  - status: refuted
  - evidence: seven valid-gold misses have their first gold within ranks 6-50;
    an existing-top50 oracle reaches 81/89 = 91.0%.

- [x] **The SliceKey experiment was vacuous.**
  - kind: fact
  - status: refuted
  - evidence: 97,809/404,281 active paths had endpoint projection, 51 top-10
    lists and 13 top-five sets changed, but valid-gold gained/lost remained zero.

- [x] **Projection coverage proves semantic discriminative power.**
  - kind: fact
  - status: refuted
  - evidence: 12 diagnosed misses have overlapping gold/distractor facets and
    only two are facet-separable; top distractors are lexical topic neighbors.

- [x] **The previous Path/Slice concepts should be deleted.**
  - kind: fact
  - status: refuted
  - evidence: governed Path truth, edge trace, derived SliceKey, and fixed
    snapshot attribution remain useful foundations; only their role as the
    primary answer-relevance objective is unsupported.

- [ ] **The next primary route should be chosen before offline separability evidence.**
  - kind: decision
  - status: needs_user_decision
  - evidence: options are unified reranker, conditioned Path-first, or a
    dual-track offline evidence phase. Recommended default is dual-track
    evidence with the reranker as the baseline and Path oracle as the
    breakthrough branch; implementation begins only after one route proves
    sufficient headroom.

- [ ] **The 90% gate should use valid-gold rows as its denominator.**
  - kind: decision
  - status: needs_user_decision
  - evidence: recommended default is valid-gold any@5, with official
    abstention accuracy and invalid-gold count reported separately; combining
    the three cohorts makes the score non-actionable.

- [ ] **Rebuildable memory HQ and structured projections may feed answer intent.**
  - kind: decision
  - status: needs_user_decision
  - evidence: recommended default is yes, as non-authoritative derived inputs;
    durable truth and governance remain unchanged.

## Anchored terms

- **Valid-gold any@5**: question-level top-five hit rate over rows with a
  valid, evaluable gold identity; abstention and invalid-gold rows are separate.
- **Answer-intent signature**: rebuildable query/candidate features describing
  subject, predicate, typed value/entity, answer role, polarity, valid time,
  and semantic domain; not durable ontology truth by itself.
- **Conditioned Path evidence**: a Path-derived feature whose direction,
  relation role, query trigger, confidence, and provenance are explicit; not
  an unconditional score propagation license.
