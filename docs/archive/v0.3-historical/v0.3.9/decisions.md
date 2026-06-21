# v0.3.9 Load-Bearing Decisions

The three decisions below were taken with user authorisation on
2026-05-16. They shape v0.3.9's scope, code-size delta, and handbook
prose. Each decision lists the chosen path, the rejected alternatives,
and the evidence that justified the choice.

---

## D1 — Dead-abstraction action

### Decision

| Abstraction | Action | Rationale |
|---|---|---|
| `DeferredObligation` (entire service + table) | **Keep & Wire** | Category F requires `obligation` `PathAnchorRef` producer. The schema and service are already complete; the gap is only callers. Wiring cost is low (insert obligation creation at materialization-router decision boundaries + at Category A `soul_resolve.defer` outcome). Retiring would block F4. |
| `SurfaceService` | **Keep & Wire (narrow)** | Daemon currently creates the service at `apps/core-daemon/src/index.ts:431` but the variable is never traded onward, so `DriftClassification` / `GovernanceDriftLease` / `DriftAlert` are dead by transitive dependency. Narrow scope (only `surface_identities` per host: codex / mcp / claude-code) is enough to (a) honour invariant §21+§21b's surface-aware reviewer identity gate, (b) revive `governance_critical` DriftAlert publishing to Inspector. Other Surface APIs (anchor, binding mutation) stay deferred. |
| `NodeInstance` (table + repo) | **Retire** | Runtime engine single-instance is sufficient for the current attach model (one daemon, multiple MCP sessions). No user-surfaced or future-roadmap scenario requires multi-engine binding. Repo is complete but daemon never mounts it. Retirement removes one table + one repo + the schema. Future re-introduction is cheap if a multi-engine scenario emerges. |
| `SynthesisCapsule.promotion` lifecycle | **Retire promotion fully — do not reuse capsule for health inbox** | Promotion fields (`authority_round_count`, `cooldown_until`, `promotion_state`) + three service methods + the legacy synthesis-promotion proposal code path are entirely unwired. Drop them. **Do not reuse `SynthesisCapsule` for Category E health-inbox aggregation** — that conflates control-plane signals with memory ontology and creates a mis-categorisation that downstream code will have to undo. `SynthesisCapsule` schema remains for its original purpose (synthesising facts across multiple memories); revisit in v0.4 if a real synthesis trigger surfaces. |
| `HealthIssueGroup` (new control-plane projection) | **Build** | Category E's health-inbox aggregation uses a new object purpose-built for control-plane projection, not ontology. `HealthIssueGroup` groups `OrphanRadar` / `Green` / `evidence_failure` entries by `target_memory_id` × `cause_kind`. New `health_issue_groups` table; new `health-issue-group-repo.ts`. Cat-E Inspector inbox reads this projection; fatigue dedupe + grouped typed actions live here. Keeps memory ontology clean of control-plane state. |
| `UpgradeAssessmentAxis` (5 fields on `GapRecord` / `HandoffRecord`) | **Retire** | All five (`recurrence_runs`, `recurrence_surfaces`, `governance_impact`, `unresolved_age_ms`, `upgrade_candidate`) hardcoded `null` at creation; the computer that would populate them was never implemented. Removing the fields cleans up two large schemas. `GapRecord` / `HandoffRecord` themselves remain. |

Net code-size delta estimate: **−800 to −1 200 LOC** (NodeInstance repo,
promotion methods, axis fields) **plus +400 to +600 LOC** (
DeferredObligation callers, SurfaceService narrow wiring,
SynthesisCapsule health-aggregation use). Net likely small negative
(roughly −300 LOC).

### Rejected alternatives

- **Keep all five & wire fully.** Would have meant building out the
  whole behaviour that never existed (multi-engine binding,
  surface-wide anchor mutation, synthesis-promotion review queue,
  upgrade-assessment computer). 2 000+ LOC of speculative scaffolding
  with no live driver. Violates `feedback_no_backlog` (do not park
  speculative scope) and the user-stated principle "不要为了测试的分数
  而盲目做内容".

- **Retire all five.** Would have lost `obligation` PathAnchorRef
  producer (Category F dependency), surface-aware reviewer identity
  (invariant §21b), and the natural aggregation shape for health
  inbox. Code-size win (~2 000 LOC) does not justify the architectural
  regression.

- **Keep all schema, only wire what F + E need now.** Same net
  outcome on F and E, but leaves the dead-code surface present in
  `NodeInstance` / promotion / axis. Future contributors would see
  fields and assume support. The chosen split removes the misleading
  surface while keeping the live-usable schema.

### Evidence

- `.do-it/findings/v0.3.8-schema-consumer-audit-synthesis-anchor.md`
  — sections B-01 (Synthesis promotion lifecycle dead), B-03
  (DeferredObligation chain dead), B-06/07/08 (SurfaceService orphan),
  B-09 (UpgradeAssessmentAxis hardcoded null), B-11 (NodeInstance
  table dead).
- `.do-it/findings/v0.3.9-root-cause-deep-dive/03-path-driven-behavior.md`
  — Table row "Anchors": only object/object_facet are reachable;
  `obligation` / `risk_concern` / `time_concern` are latent — confirms
  F4 needs DeferredObligation.
- `docs/handbook/invariants.md:88-120` — Inspector + reviewer-identity
  invariant requires surface-aware checks.

---

## D2 — Garden deterministic triage governance status

### Decision

**Unified typed-resolution governance.** Garden's deterministic
`SignalService.evaluateTriage`
(`packages/core/src/memory/signal-service.ts:341-349`) plus
`MaterializationRouter` route to `memory_and_claim`
(`packages/soul/src/garden/materialization-router.ts:164-273`) remains
the **low-trust durable producer**, but its **only legal claim
output is `claim_status=draft`**. There is no "high-confidence +
evidence_refs auto-active" fast path — evidence_refs presence does
not equal evidence verification or user attestation, and verification
is a separate event chain (`EvidenceService.update`, Auditor) that
must complete before any claim leaves draft.

Active promotion requires a **typed resolution recorded in EventLog**
through one of two reviewer-bound routes:

1. **Inline typed resolution (`soul.resolve`)** — Category A. Agent
   receives a `staged_warning` on a draft claim during recall; invokes
   `soul.resolve` with `resolution=confirm` and a typed payload; the
   handler atomically (a) writes an audit event carrying the typed
   resolution, (b) calls `ClaimService.transitionLifecycle(draft →
   active)`, and (c) records the reviewer identity (the agent's MCP
   session identity), so the active claim is bound to a specific
   delivery + session pair.

2. **Out-of-band Proposal (`soul.propose_memory_update` + review)** —
   explicit host assertion or operator manual review through Inspector /
   CLI / MCP review. Unchanged from v0.3.8.

Both routes share the same audit trail shape and the same reviewer
identity binding. `SoulToolGovernanceAdapter` continues to gate
active runtime governance on `claim_status ∈ {active, contested,
winner}`; Garden's draft output never enters runtime governance
until a typed resolution promotes it.

**Inspector cannot directly mutate durable state.** Any Inspector
action that appears to "promote" / "retire" / "relink" a memory or
path will, behind the scenes, trigger one of the two typed-resolution
routes above and route the apply through `publishEventLogMutation`.
Inspector is the **origination surface**, not the persistence
surface; this preserves invariant §21+§21b.

**Handbook prose updated.** `docs/handbook/invariants.md:57-77` and
`docs/handbook/architecture.md` updated to describe Garden as a
**low-trust durable producer** with active promotion through a typed
resolution chain. The single "proposal route" language is dropped;
the language now distinguishes (a) low-trust draft production via
Garden, (b) high-trust promotion via `soul.resolve` typed resolution
or Proposal/HITL.

### Rejected alternatives

- **All durable writes via Proposal/HITL.** Would queue 316
  memory/evidence/claim trios per workspace through human review.
  Violates user feedback `feedback_no_slash_commands` ("能力要自动出现,
  不能要求用户记忆 /command") at scale — the operator would face
  hundreds of Proposal items per day. Also contradicts handbook
  invariant §65 ("Garden is fire-and-forget").

- **Deterministic triage as the only route, no upgrade path.**
  Leaves `claim_status: draft` as a graveyard with no operator
  promotion mechanism (current state). Fails user intent ("治理是很
  重要的. 让 agent 自己去做, 有一个很大的问题是, 记忆腐化的问题.")
  and codex 04 report finding F1.

- **Mixed governance with "high-confidence + evidence_refs → auto-active"
  fast path** (initial v0.3.9 plan, rejected by codex review). The
  presence of `evidence_refs` is a syntactic property of the signal,
  not a verification fact about the evidence capsule. Verification is
  a separate event chain (`EvidenceService.update`,
  `green_statuses.verified_at`, Auditor). Allowing materialization to
  directly produce `active` would short-circuit verification and bind
  active runtime governance to an unverified ontology row. The
  typed-resolution route above ensures every active claim has at
  least one reviewer-bound audit event before it enters governance.

### Evidence

- `.do-it/findings/v0.3.9-root-cause-deep-dive/02-memory-pipeline-callpath.md`
  §4 (signal triage materialises but quality stays weak by design).
- `.do-it/findings/v0.3.9-root-cause-deep-dive/04-governance-evidence-health.md`
  §F1 (draft ClaimForms exist but most extracted claims do not enter
  operator promotion).
- `.do-it/findings/v0.3.8-live-data-portrait.md` §B7
  (ClaimForm 289→316 all draft; user-given directives extracted but
  not active).

---

## D3 — PathRelation EventLog-first fix approach

### Decision

**Transactional `publishEventLogMutation` wrap.**
`PathRelationProposalService.propose` (`packages/core/src/path-graph/path-relation-proposal-service.ts:146-186`)
will route its `repo.create(...)` through the existing
`publishEventLogMutation` helper, emitting `path.relation_created`
(`packages/protocol/src/events/runtime-governance.ts:69-75`) in the
same SQLite transaction as the row insert.

The same pattern is applied to the graph-edge audit/insert
atomicity gap noted in
`packages/protocol/src/soul/memory-graph.ts:43-54` — `MemoryGraphEdgeRepo.ensureEdge`
will publish `memory_graph_edge.recalls_created` (or the equivalent
typed event) in the same transaction as the row insert.

### Why this shape

- **Matches `PathPlasticityService` pattern** —
  `packages/core/src/path-plasticity/service.ts:573-592` already uses
  this exact shape for reinforcement/weakening/retirement/redirection
  events. Consistency reduces reviewer load.
- **Handbook invariant compliance** —
  `docs/handbook/invariants.md:54-56` requires "evidence and governance
  changes, including path plasticity changes, must be explicit,
  structured, and auditable". Atomicity is the only correctness shape
  that survives crash-during-write scenarios.
- **No new event-bus infrastructure** — the helper already exists;
  this is a producer-side rewire, not a framework addition.

### Rejected alternatives

- **Publish event after `repo.create()`.** Simpler, but breaks the
  invariant under crash-mid-write. Event timestamp would also drift
  from row creation by several ms in normal flow, which is
  observable in EventLog ordering checks.
- **Best-effort publish (no transaction).** Same crash gap, plus
  events can silently disappear on `EventLog` write failure. Already
  rejected when `PathPlasticityService` was designed.
- **Move PathRelation creation off the consumer path entirely.**
  Bigger refactor (e.g. into a Garden background task). v0.3.9 prefers
  the in-place EventLog-first fix; the architectural question of
  "should path creation be on consumer path?" can be revisited in
  v0.4 if observability data shows latency cost.

### Evidence

- `.do-it/findings/v0.3.9-root-cause-deep-dive/01-architecture-contract-vs-runtime.md`
  §Blocking 1 (PathRelation creation is on consumer usage path and is
  not EventLog-first).
- `packages/core/src/path-plasticity/service.ts:573-592` (reference
  implementation of the desired pattern).
- `docs/handbook/invariants.md:54-56` (the invariant being violated).
