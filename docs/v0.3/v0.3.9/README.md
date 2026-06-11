# v0.3.9 — Trustworthy Memory Loop Closure (Three-Layer Repair)

## Status

Plan-stage on 2026-05-16. v0.3.9 is the structural-repair release that
closes the three-layer breakages diagnosed by the v0.3.8 live-data
portrait (`.do-it/findings/v0.3.8-live-data-portrait.md`) and the
codex root-cause deep-dive (`.do-it/findings/v0.3.9-root-cause-deep-dive/`
— five separate reports: `01-architecture-contract-vs-runtime` through
`05-live-data-and-doc-truth`).

This release does **not** chase a benchmark number. The diagnosis already
established that LongMemEval-S R@5 is lexical-friendly (79% of recalls
satisfied by lexical-only, 32% return 0 pointers, 45% return the max 5)
and that synthetic R@K does not represent Alaya's real use shape.
v0.3.9 targets the trust-loop closure observed in the operator's own
live SQLite snapshot, not external bench gains.

## Diagnosis (three-layer breakage)

| Layer | Diagnosis | Live evidence |
|---|---|---|
| **L1 Memory ontology generated heavily but quality weak** | All 316 durable memories from `garden_compile` deterministic triage; 312 `fact` + 4 `constraint` (8-enum collapse); 316/316 evidence `inferred` + `questionable`; 316/316 claims `draft` | live DB query 2026-05-16 |
| **L2 Structure registry has schema and partial recall consumption, but real path learning has not started** | 1 bootstrap `PathRelation` only; 92 `RECALLS` graph edges; 0 staged edges (supersedes/contradicts/exception_to/incompatible_with); 0 conflict matrix; 0 synthesis capsule; 0 strong_ref; 0 slot; 21 446 `green.revoked` events against `green_statuses=0` (silent UPDATE) | live DB query + codex 04+05 |
| **L3 Runtime control usage/governance feedback too narrow** | 169 deliveries, 101 usage proofs, 47 used; `report_context_usage` requires ≥2 used object ids before cross-link and PathRelation propose; 12 791 `orphan_radar.reported` with no consumer; Inspector queue is a flat raw list | live DB + codex 02+04 |

Five repeating anti-patterns confirmed across four schema layers
(see `v0.3.8-live-data-portrait.md` §K.5):

1. **Enum complete, producer single** — `MemoryEntry.dimension` (8→fact),
   `EvidenceCapsule.evidence_kind` (7→inferred), `CandidateMemorySignal.signal_kind`
   (multi→2), `karma_events` (5→2), `MemoryGraphEdge.edge_type` (7→RECALLS),
   `ClaimForm.precedence_basis`, `PathRelation.governance_class` (4→hint_only).
2. **Evolution fields producer-write defaults** — `PathRelation.stability_class`
   hardcoded `"stable"`, `effect_vector` defaults, `contradiction_count` /
   `support_events_count` zero, `evidence_health_state` default `questionable`.
3. **Computed-then-discarded** — `governance_critical` DriftAlert logged but
   no Inspector route, `ProposalOption.unresolved_after_apply` written but
   unread, `EvidenceCapsule.semantic_anchor` / `event_anchor` written JSON
   but no deserializer, PathGraphSnapshot 11 fields unread. (Note:
   `direction_bias` is **not** discarded — `packages/core/src/recall/recall-service.ts:2038`
   reads it in path expansion, and `path-plasticity-runtime.ts:398-418` uses
   it for plasticity. Earlier classification was incorrect.)
4. **21k+ pure sink** — `orphan_radar.reported`, `green.revoked`,
   `evidence_failure`.
5. **Entire abstractions dead-coded** — `NodeInstance`, `SurfaceService`,
   `DeferredObligation`, `SynthesisCapsule` promotion lifecycle,
   `GapRecord/HandoffRecord.UpgradeAssessmentAxis`.

## Three load-bearing decisions

Recorded with rationale in `decisions.md`.

### D1 — Dead-abstraction action (Category H)

| Abstraction | Action |
|---|---|
| `DeferredObligation` | **Keep & Wire** — required as Category F's `obligation` PathAnchorRef producer |
| `SurfaceService` | **Keep & Wire (narrow)** — daemon must register `surface_identities` per host (codex/mcp/claude-code); other surface APIs deferred |
| `NodeInstance` | **Retire** — runtime engine single-instance already sufficient, no future multi-binding scenario surfaced |
| `SynthesisCapsule.promotion lifecycle` | **Retire promotion fully** — drop `authority_round_count`, `cooldown_until`, `promotion_state` fields + three service methods + the legacy synthesis-promotion proposal code path. Do **not** reuse `SynthesisCapsule` for health-inbox aggregation (that conflates control-plane signals with memory ontology). `SynthesisCapsule` itself stays for its original synthesis-of-facts purpose but is unused in v0.3.9; revisit in v0.4 if a real synthesis trigger appears. Health inbox uses a new control-plane projection `HealthIssueGroup` (Category E.0) |
| `HealthIssueGroup` (new) | **Build** — control-plane projection (not memory ontology). Groups `OrphanRadar` / `Green` / `evidence_failure` entries by `target_memory_id` × `cause_kind`; new `health_issue_groups` table. Cat-E Inspector inbox reads this. Allows fatigue dedupe + grouped typed actions without polluting ontology |
| `UpgradeAssessmentAxis` | **Deferred, not retired** — nullable schema fields are still present; producer/computer remains unimplemented. Canonical closure condition is `reports/v0.3.9-closeout.md` §Cat-H.3. |

### D2 — Garden deterministic triage governance status

**Unified typed-resolution governance.** Garden's deterministic triage
(`SignalService.evaluateTriage` + `MaterializationRouter`) remains the
**low-trust durable producer**, but its **only legal claim output is
`claim_status=draft`**. There is no "high-confidence + evidence_refs
auto-active" fast path — evidence_refs presence does not equal
evidence verification or user attestation.

Active promotion requires a **typed resolution recorded in EventLog**
through one of two reviewer-bound routes:

1. **Inline typed resolution (`soul.resolve`)**: agent receives a
   `staged_warning` on a draft claim during recall, invokes
   `soul.resolve` with `resolution=confirm` and a typed payload; the
   handler writes an audit event and applies
   `ClaimService.transitionLifecycle(draft → active)` atomically. The
   reviewer identity carried is the agent's MCP session identity, so
   the active claim is bound to a specific delivery + session pair.

2. **Out-of-band Proposal (`soul.propose_memory_update` + review)**:
   explicit host assertion or operator manual review through Inspector /
   CLI / MCP review. Unchanged.

Both routes share the same audit trail shape and the same reviewer
identity binding. `SoulToolGovernanceAdapter` continues to gate
active runtime governance on `claim_status ∈ {active, contested, winner}`;
Garden's draft output never enters runtime governance until a typed
resolution promotes it.

- Handbook prose updated to describe **two co-existing governance
  routes**: deterministic triage (fire-and-forget low-trust durable)
  and Proposal/HITL (high-trust promotion or memory update).

### D3 — PathRelation EventLog-first fix approach

**Transactional `publishEventLogMutation`** wraps `repo.create()` and
emits `path.relation_created` in the same transaction — matches
`PathPlasticityService` pattern. Additionally, the graph-edge
audit/insert atomicity gap noted in
`packages/protocol/src/soul/memory-graph.ts:43-54` is closed the same
way (Category 0 covers both).

## v0.3.9 categories (11 total)

| Cat | Aim | Layer | Owns |
|---|---|---|---|
| **0** | PathRelation EventLog-first + graph-edge audit atomicity | L2+L3 | Blocking, ships first |
| **A** | Inline Governance Loop — `staged_warnings` on recall payload; `GovernancePolicy` resolver assigns one of (`safe_automatic` / `agent_reviewable` / `human_review_required` / `diagnostic_only`); new `soul.resolve` typed verb (`confirm` / `reject` / `correct` / `stale` / `defer` / `not_relevant`); fatigue controls (per-turn `ask_now` budget) | L3 | New MCP verb (dot namespace) + recall payload extension |
| **B** | Memory Quality Lift — materialization not 1:1:1; route by `detected_object.object_kind`; Garden's only legal claim output is `draft` (no auto-active); `potential_conflict` signal kind routed | L1 | `MaterializationRouter` rewire |
| **C** | Usage Loop Widening — `resolveUsedObjectIds` allows single used object for telemetry/HOT promotion/usage anchor (does **not** synthesise PathRelation co-usage from single usage — relation semantics preserved); usage telemetry split 5 buckets (`no recall` / `empty recall` / `delivered_not_reported` / `reported_skipped_or_na` / `reported_used`) | L3 | `report_context_usage` handler + Inspector telemetry |
| **D** | Data correctness — codex review Blocking + Important (LoCoMo `evaluated_count` denom, cohort metric ≤50%, sample-size label, runtime-status sync, embedding-on baseline policy, Phase 6 bench truth-up) | All | Eval / bench / docs |
| **E** | Inspector Health Inbox — aggregate Auditor / OrphanRadar / Green by memory / `evidence_ref` / root cause; typed actions per class; fatigue dedupe | L3 | New Inspector page + daemon aggregation route |
| **F** | Path-Driven Manifestation Activation — stored `PathRelation` → `ActivationCandidate` → `ManifestationResolver` producer; explicit governance-class to stance/nudge/lens policy boundary; `verification_bias` + `unfinishedness_bias` landing strategy (non-durable) | L2 | New producer service + manifestation policy |
| **G** | Schema Field Reclamation — every K.1-K.4 dead/half-dead/computed-then-discarded field: wire consumer or remove from schema (no "looks supported" mirage); evaluate enum-single-producer extension vs. retraction | All | Cross-package cleanup |
| **H** | Dead-abstraction action — execute D1 (keep & wire DeferredObligation + SurfaceService narrow; retire NodeInstance + SynthesisCapsule promotion; keep `UpgradeAssessmentAxis` deferred on schema per Cat-H.3) | All | Schema deletion + service wiring except `UpgradeAssessmentAxis` (deferred) |
| **I** | 21k+ sink repair — GreenStatus silent UPDATE (affected-row guard + workspace predicate + EventLog mandatory); OrphanRadar feeds Category E; evidence_failure aggregates upward to E | L3 | `garden-data-ports.ts` patch + Auditor reshaping |
| **J** | Docs truth alignment — `runtime-status.md` readiness split into 4 levels (`schema_only` / `implementation_wired` / `live_event_proven` / `agent_used`); every producer/consumer path tagged separately; v0.3.8 closeout retroactively annotated where labels were overstated | Docs meta | `docs/handbook/runtime-status.md` rewrite |

## Backlog inclusion

- **#BL-044** (Recall utilization follow-through — deferred from
  v0.3.8 by user directive) → resolved by **Category C** (telemetry
  split + 1-used loosening) and **Category E** (operator drill-down
  in health inbox).
- No other open backlog items. `#BL-039/040/041/042/045/046` closed in
  v0.3.8. All v0.3.9 finding-derived issues are absorbed in-release.

## Out of scope (explicit)

- No new SQL migrations beyond what Category G + H need (schema removal
  / column drop only; no behaviour migrations).
- No new MCP verb beyond `soul.resolve` (Category A, dot-namespaced to
  match the existing `soul.*` tool surface in `packages/engine-gateway/src/provider/soul-tool-specs.ts`)
  and no breaking changes to existing 13 CLI verbs.
- No R@K chasing as the primary optimisation goal. Benchmarks remain
  in scope as **diagnostic mirrors** of the three-layer repairs:
  pre-v0.3.9 baseline vs. post-v0.3.9 diff per category, run in P5.
  Per user directive ("不要为了测试的分数而盲目做内容") and the
  benchmark-as-feedback-loop principle — measurements feed diagnosis,
  not the other way around. Specific reflections this release expects
  benchmarks to surface:
  - Category B (Memory Quality Lift): EvidenceCapsule `evidence_kind`
    diversification observable; `dimension` distribution diversifies.
  - Category C (Usage Loop Widening): `reported_used` bucket ratio
    rises; single-used reports produce telemetry + usage-anchor signals
    but do **not** synthesise PathRelation co-usage (relation semantics
    preserved — see Cat-C in `plan.md`).
  - Category F (Path-Driven Manifestation): non-bootstrap PathRelation
    rows appear; non-default `effect_vector` rows present.
  - Category I (Sink Repair): `green.revoked` event rate drops to
    bounded-by-actual-revokes; `evidence_failure` aggregates rather
    than scan-per-row.
  - LoCoMo R@K (after Cat-D.1 denominator fix) becomes meaningful for
    the first time — track the absolute number but **only as a
    diagnostic signal**, not a release gate.
- No agent-frontend GUI / conversation TUI (invariant §21a). Inspector
  Health Inbox is the only new UI surface and remains memory-tooling
  loopback.
- Embedding provider semantics unchanged (remains recall supplement
  per invariant; no truth-deciding role).

## Milestones (per `plan.md`)

| Phase | Categories | Gating condition |
|---|---|---|
| **P0** | Category 0 (PathRelation EventLog-first + graph-edge atomicity), Category I.1 (GreenStatus silent UPDATE) | Blocking; merges independently with hotfix tag `v0.3.9-blocking-p0` |
| **P1** | Category H (D1 dead-abstraction action), Category G (schema reclamation) | Schema-level changes; must precede other phases that depend on cleaned ontology |
| **P2** | Category B (Memory Quality Lift), Category C (Usage Loop Widening) | Core memory-loop rewiring |
| **P3** | Category F (Path-Driven Manifestation), Category I.2-3 (OrphanRadar+evidence_failure into health inbox) | Behavior-activation + sink repair |
| **P4** | Category A (Inline Governance Loop), Category E (Inspector Health Inbox) | New MCP verb + Inspector surface |
| **P5** | Category D (data correctness), Category J (docs truth alignment), release notes | Closeout + bench infrastructure correctness |

Each phase ends with `do-it-review-loop` (per
`feedback_release_workflow`). Worktree default per
`feedback_release_workflow`.

## Verification gates (per phase)

- `rtk pnpm build` clean
- `rtk pnpm test` clean
- `do-it-review-loop` reports zero Blocking + zero Important
- Live SQLite snapshot diff: each category lists a verifiable live-DB
  signal (e.g. P0 → `path_relations.created_at` appears in EventLog;
  P2 → `evidence_kind` distribution diversifies; P3 → at least one
  non-bootstrap PathRelation row with non-default `effect_vector`)

## Documents

- `decisions.md` — the three load-bearing decisions with rationale and
  rejected alternatives.
- `plan.md` — phase-level breakdown with per-category sub-tasks,
  affected files, verification gates, and rollout risks.
- `release-notes.md` — written at P5 close.
- `reports/v0.3.9-closeout.md` — written after the review-loop closes.

## Source documents this plan integrates

- `.do-it/findings/v0.3.8-live-data-portrait.md` (sections A through L)
- `.do-it/findings/v0.3.9-root-cause-deep-dive/01-architecture-contract-vs-runtime.md`
- `.do-it/findings/v0.3.9-root-cause-deep-dive/02-memory-pipeline-callpath.md`
- `.do-it/findings/v0.3.9-root-cause-deep-dive/03-path-driven-behavior.md`
- `.do-it/findings/v0.3.9-root-cause-deep-dive/04-governance-evidence-health.md`
- `.do-it/findings/v0.3.9-root-cause-deep-dive/05-live-data-and-doc-truth.md`
- `.do-it/findings/v0.3.9-claude/v0.3.8-schema-consumer-audit-memory-object.md`
- `.do-it/findings/v0.3.9-claude/v0.3.8-schema-consumer-audit-governance-conflict.md`
- `.do-it/findings/v0.3.9-claude/v0.3.8-schema-consumer-audit-plasticity-evolution.md`
- `.do-it/findings/v0.3.9-claude/v0.3.8-schema-consumer-audit-synthesis-anchor.md`
