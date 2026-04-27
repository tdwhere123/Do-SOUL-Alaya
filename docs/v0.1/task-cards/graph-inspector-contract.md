# ALA-R11 - Graph Inspector Contract

## Goal

冻结 Phase 2 点状连接图的数据契约：graph/topology 是 read-only derived view，
来自 runtime/API 与 active PathRelation，不拥有 durable truth，也不提供
graph mutation。

## Source References

- `docs/v0.1/extraction-ledger.md` - Graph Inspector 是 `alaya-adapted`，Phase
  2 点状连接图，runtime/API 提供数据，Inspector 不拥有 truth。
- `docs/handbook/invariants.md` - Inspector state 不是 durable truth；Inspector
  是 Phase 2 事项。
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/graph.ts:8` -
  source graph node/edge enums and bounded depth/limit defaults。
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/soul-topology.ts:19`
  - topology exploration result shape。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/routes/soul-graph.ts:22`
  - read-only graph route。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/routes/soul.ts:62` -
  topology route appends audit after exploration。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/services/soul-topology-audit-service.ts:23`
  - topology audit event payload。
- `/home/tdwhere/vibe/do-what-new/packages/ui-sdk/src/client.ts:871` - graph
  client request contract。
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/topology-service.ts:49`
  - topology derives from active PathRelation reads。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/runtime-status.md:266` -
  topology is derived from active PathRelation with optional stored-history
  overlay and audit-only query events。

## Source Classification

- `source-backed`: typed graph/topology response shapes, bounded depth/limit
  parsing, active `PathRelation` topology derivation, read-only route posture,
  and audit-only topology query event are source-backed where applicable。
- `alaya-adapted`: Alaya rewrites these surfaces as a Phase 2 Inspector data
  contract over its own runtime/API, overlays, truncation metadata, and audit
  semantics。
- `alaya-default`: Inspector is Phase 2 contract readiness only; no visual UI,
  graph library choice, or graph mutation is accepted in v0.1。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R2 ontology record contracts and ALA-R3 active `PathRelation` topology
  derivation.
- ALA-R7 session/provider/degradation metadata if overlays expose trust posture.

## Parallel With

- ALA-R10 benchmark/report work after graph/topology data is explicitly
  read-only and derived.
- Not parallel with visual Inspector delivery, which remains outside v0.1.

## Write Ownership

- Planned graph API contracts, topology query params, evidence/path/governance/
  session/provider/degradation overlays, truncation/totals metadata, read audit
  events, and focused tests.
- Do not own visual UI, graph library choice, graph mutation, or Inspector
  projection state as durable truth.

## Acceptance

- graph/topology endpoints are read-only。
- data derives from runtime/API and active PathRelation。
- Inspector cannot create/update/delete durable truth。
- bounded query params prevent unbounded graph reads。
- overlays can answer trust/debug questions without becoming truth。
- read audit records query intent/result metadata without changing memory state。

## Verification

Planned implementation verification only:

- graph contract tests。
- bounded query tests。
- read-only mutation regression tests。
- overlay snapshot tests。
- audit event tests。

## Review Lens

- derived-view boundary。
- graph contract stability。
- audit-without-mutation semantics。
- future UI readiness。

## Stop Conditions

- If graph code introduces independent graph storage as truth, stop and redesign。
- If Inspector UI needs durable state to satisfy this card, return
  `NEEDS_CONTEXT`。

## Implementation Subcards

### ALA-R11.1 - Graph/topology API contract

#### Scope

Define graph and topology request/response contracts, scope inputs, node/edge
kinds, query bounds, totals, truncation flags, and error semantics。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/graph.ts:8` -
  source graph schema and bounded depth/limit defaults。
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/soul-topology.ts:19`
  - topology exploration result shape。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/routes/soul-graph.ts:22`
  - read-only graph route。
- `/home/tdwhere/vibe/do-what-new/packages/ui-sdk/src/client.ts:871` - client
  request contract source material。

#### Acceptance

- API exposes stable graph/topology schemas with typed nodes, typed edges,
  bounded depth/limit, totals, and truncation metadata。
- Scope is explicit and cannot silently blend User and Project planes。
- Query validation rejects unbounded or invalid reads。
- Contract is independent Alaya API language, not a direct `@do-what/*`
  runtime dependency。

#### Verification

Planned tests cover schema parsing, query bounds, invalid scope rejection,
truncation/totals, and client contract snapshots。

#### Review Lens

Check schema stability, scope separation, and bounded-read guarantees。

#### Stop Conditions

Stop if graph/topology contract requires importing do-what-new runtime code。

### ALA-R11.2 - Overlay and truncation metadata

#### Scope

Define derived overlay metadata for evidence, path strength, governance state,
session usage, provider/degradation posture, snapshot/trend data, and truncation
reasoning。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/topology-service.ts:49`
  - topology derives from active PathRelation and optional history trend。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/runtime-status.md:266` -
  stored history is optional overlay, structural topology is active
  PathRelation。
- `docs/handbook/invariants.md` - projection and Inspector state are not
  durable truth。

#### Acceptance

- Overlay metadata is derived and explicitly labeled by source plane and
  confidence/degradation state。
- Truncation includes node/edge totals, applied limits, and reason codes。
- Trend/snapshot overlays can be omitted or degraded without changing structural
  topology truth。
- Overlay values cannot be written back as Memory Ontology or PathRelation by
  this surface。

#### Verification

Planned tests cover overlay snapshots, omitted trend data, truncation reason
codes, degraded provider overlay, and no-promotion regression checks。

#### Review Lens

Check that overlays explain trust/debug posture without becoming a second
truth store。

#### Stop Conditions

Stop if overlay generation needs to persist Inspector-owned state as durable
truth。

### ALA-R11.3 - Read audit without mutation

#### Scope

Define audit records for graph/topology reads while proving that audit append is
separate from PathRelation, Memory Ontology, and governance mutation。

#### Source References

- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/routes/soul.ts:62` -
  topology read appends an audit event after exploration。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/services/soul-topology-audit-service.ts:23`
  - topology audit event payload source material。
- `docs/handbook/invariants.md` - durable memory/governance changes must be
  explicit and auditable。

#### Acceptance

- Read audit records actor/scope/query bounds/overlay flags/result counts and
  degradation/truncation metadata。
- Audit append does not mutate MemoryEntry, EvidenceCapsule, ClaimForm,
  SynthesisCapsule, or PathRelation。
- Failed or rejected reads record safe diagnostics only where policy allows。
- Audit records are usable for operator trust and benchmark proof。

#### Verification

Planned tests cover audit payload shape, mutation guards, failed-read auditing,
and no-change assertions on ontology/path repositories。

#### Review Lens

Check that auditability is preserved without turning reads into writes。

#### Stop Conditions

Stop if the only way to audit a read is to mutate graph/path/memory state。

### ALA-R11.4 - Future Inspector readiness review

#### Scope

Define the Phase 2 readiness review that decides whether the data contract is
ready for a visual Inspector implementation without making UI a v0.1 blocker。

#### Source References

- `docs/v0.1/extraction-ledger.md` - Inspector is Phase 2, point-connected graph,
  and cannot own durable truth。
- `docs/handbook/invariants.md` - current stage does not treat Inspector
  projection state as durable truth。
- `docs/v0.1/task-cards/README.md` - R11 precedes R12 and provides data-contract
  readiness only。

#### Acceptance

- Readiness review confirms graph/topology contracts, overlays, truncation,
  audit, and no-mutation proofs。
- Review explicitly states that v0.1 requires contract readiness, not visual UI
  delivery。
- Future UI work can consume the contract without needing new durable truth
  ownership。
- Any graph library choice remains out of this card。

#### Verification

Planned review checklist covers contract completeness, no-mutation evidence,
Phase 2 boundary, and downstream UI-consumption notes。

#### Review Lens

Check whether the contract is sufficient for future Inspector UI without
expanding v0.1 scope。

#### Stop Conditions

Stop if a reviewer tries to make visual Inspector delivery a v0.1 acceptance
criterion。
