---
task: Recall root-cause levers implementation
session_id: 019f4902-b75e-7202-8844-c543645a6620
created: 2026-07-10
status: open
brainstorm: none
---

## Items tested

- [x] **A new SliceKey ontology or datastore is necessary for v1.**
  - kind: fact
  - status: refuted
  - evidence: `docs/handbook/invariants.md:52-56` makes projections routing truth, while `packages/protocol/src/soul/memory-entry.ts:206-219` already persists projection version, time, facets, and canonical entities. `packages/protocol/src/soul/path-relation.ts:124-153` already supplies object-facet and time-concern anchors.
- [x] **Edge-level flood tracing needs a new runtime contract.**
  - kind: fact
  - status: confirmed
  - evidence: `packages/core/src/recall/runtime/recall-service-results.ts:12-15` reduces inflow to seed plus weight, while `packages/core/src/recall/runtime/recall-service-diagnostics.ts:86-103` exposes only an object aggregate. Path identity is therefore unrecoverable at the diagnostics consumer.
- [x] **Flood should be modeled as a durable edge object.**
  - kind: decision
  - status: chosen
  - evidence: The approved route distinguishes durable `PathRelation`, query-scoped flood transfer, and object score projection; this preserves invariants §12-16 and keeps control-plane output out of ontology.
- [x] **The first remoteness implementation should include multi-hop propagation.**
  - kind: decision
  - status: chosen
  - evidence: User selected the evidence-gated route: implement single-hop first and open bounded two-hop only when trace evidence can close the measured quality gap.
- [x] **The current fresh-seed 100Q control/treatment protocol identifies the SliceKey effect.**
  - kind: fact
  - status: refuted
  - evidence: two controls over the same semantic corpus produced `77/100` and `82/100`, with 7 flips. Raw co-relevant pairs were identical, but UUID-ordered sparsification changed kept edges in 99/100 questions and minted edges in 100/100.
- [x] **The current LongMemEval workspace identity isolates every question.**
  - kind: fact
  - status: refuted
  - evidence: `runner-question.ts` uses `question_id.slice(0, 8)`; the stratified 100 has two base/`_abs` collisions, and the 500Q dataset has 42 collision groups.
- [x] **The default single-hop transfer formula is mathematically safe.**
  - kind: fact
  - status: confirmed
  - evidence: default artifacts satisfy finite `[0,1]` inputs, `lambda=.6`, `beta=0`; recomputation of transfer, NOR, and L-gate has zero observed error. Non-default lambda/beta domains remain insufficiently bounded.
- [x] **The current abstention score can share the ordinary any@5 promotion gate.**
  - kind: fact
  - status: refuted
  - evidence: post-fusion delivery may place a larger fused score below rank 1, violating the margin formula's premise; runtime threshold `0.91` is not calibrated on the current HEAD and only six abstentions are selected.
- [x] **Multi-dimensional SliceKey compatibility should remain any-common-key OR.**
  - kind: decision
  - status: chosen
  - evidence: strong typed query dimensions (`time`, `space`, `entity`) must each have a query/source/target intersection. Semantic facets are fallback only when the query has no strong key; they cannot override a failed strong dimension.
- [x] **Object SliceKey identity means memory object ID rather than real-world subject identity.**
  - kind: decision
  - status: chosen
  - evidence: v1 routes on stable subject/entity semantics derived from canonical entities and typed projections. Memory-entry ID is not a SliceKey dimension, because distinct source and target entries cannot intersect on it.
- [x] **S4b should supplement the existing two-hop graph expansion.**
  - kind: decision
  - status: chosen
  - evidence: S4b remains blocked unless trace reachability proves it can close the measured gap. If opened, it must condition or replace the existing structural contribution rather than independently double-count the same two-hop topology.

## Anchored terms

- **PathRelation**: durable, governed conditional relation structure.
- **Flood transfer**: query-scoped propagation decision along one directed eligible edge.
- **Shore reading**: object-level aggregate projected into recall scoring and diagnostics.
- **SliceKey**: workspace-scoped, rebuildable routing key derived from typed time, space, object/entity, semantic, and path projections; never a second memory ontology.
- **Remoteness**: stopping behavior produced by input potential, edge conductance, slice compatibility, governance, and the propagation budget.
- **Latency truth**: p95 measured on a quiescent sequential `shards=1` run; parallel merged p95 is throughput telemetry only.
- **Quality A/B**: control and treatment restored independently from the exact same immutable seeded snapshot; fresh independent seeds are not paired evidence.
