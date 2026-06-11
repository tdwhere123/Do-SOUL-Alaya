# v0.3.9 — Trustworthy Memory Loop Closure (Three-Layer Repair)

Single-source plan for the v0.3.9 release. Supersedes the original
`README.md` + `decisions.md` + `plan.md` triplet (folded into this file)
and the interim `orchestration-plan.md` (folded into §5 / §6 / §7
below). All execution sequencing answers come from this document.

The release is the structural-repair pass that closes the three-layer
breakages diagnosed by `.do-it/findings/v0.3.8-live-data-portrait.md`
and the codex root-cause deep-dive (`.do-it/findings/v0.3.9-root-cause-deep-dive/`,
reports `01-architecture-contract-vs-runtime` through
`05-live-data-and-doc-truth`). v0.3.9 does **not** chase a benchmark
number — synthetic R@K does not represent Alaya's real use shape; this
release targets the trust-loop closure observed in the operator's live
SQLite snapshot.

---

## 1. Diagnosis — three-layer breakage

| Layer | Diagnosis | Live evidence |
|---|---|---|
| **L1 Memory ontology generated heavily but quality weak** | All 316 durable memories from `garden_compile` deterministic triage; 312 `fact` + 4 `constraint` (8-enum collapse); 316/316 evidence `inferred` + `questionable`; 316/316 claims `draft` | live DB query 2026-05-16 |
| **L2 Structure registry has schema and partial recall consumption, but real path learning has not started** | 1 bootstrap `PathRelation`; 92 `RECALLS` graph edges; 0 staged edges (supersedes / contradicts / exception_to / incompatible_with); 0 conflict matrix; 0 synthesis capsule; 0 strong_ref; 0 slot; 21 446 `green.revoked` events against `green_statuses = 0` (silent UPDATE) | live DB + codex 04 + 05 |
| **L3 Runtime control usage/governance feedback too narrow** | 169 deliveries, 101 usage proofs, 47 used; `report_context_usage` required ≥ 2 used object ids before cross-link and PathRelation propose; 12 791 `orphan_radar.reported` with no consumer; Inspector queue is a flat raw list | live DB + codex 02 + 04 |

Five repeating anti-patterns confirmed across four schema layers (see
live-data portrait §K.5):

1. **Enum complete, producer single** — `MemoryEntry.dimension`,
   `EvidenceCapsule.evidence_kind`, `CandidateMemorySignal.signal_kind`,
   `karma_events`, `MemoryGraphEdge.edge_type`, `ClaimForm.precedence_basis`,
   `PathRelation.governance_class`.
2. **Evolution fields producer-write defaults** — `PathRelation.stability_class`
   hardcoded `"stable"`, `effect_vector` defaults, `contradiction_count` /
   `support_events_count` zero, `evidence_health_state` default
   `questionable`.
3. **Computed-then-discarded** — `governance_critical` DriftAlert logged
   but no Inspector route; `ProposalOption.unresolved_after_apply`
   written but unread; `EvidenceCapsule.semantic_anchor` / `event_anchor`
   written as JSON but no deserialiser; `PathGraphSnapshot` 11 fields
   unread. Note: `direction_bias` is **not** discarded — recall path
   expansion reads it (`packages/core/src/recall/recall-service.ts:2038`) and
   plasticity uses it (`apps/core-daemon/src/path-plasticity-runtime.ts:398-418`).
4. **21k+ pure sink** — `orphan_radar.reported`, `green.revoked`,
   `evidence_failure`.
5. **Entire abstractions dead-coded** — `NodeInstance`, `SurfaceService`,
   `DeferredObligation`, `SynthesisCapsule` promotion lifecycle,
   `GapRecord` / `HandoffRecord.UpgradeAssessmentAxis`.

---

## 2. Three load-bearing decisions

These three decisions shape every Cat-H retire and every Cat-G
reclamation. They were taken with user authorisation on 2026-05-16.

### D1 — Dead-abstraction action

| Abstraction | Action | Rationale |
|---|---|---|
| `DeferredObligation` | **Keep & Wire** | Category F requires `obligation` `PathAnchorRef` producer. Schema and service already complete; wiring cost is small (insert obligation creation at materialization-router decision boundaries + at `soul.resolve.defer` outcome). |
| `SurfaceService` | **Keep & Wire (narrow)** | Daemon currently constructs the service but never trades it onward. Narrow scope is `surface_identities` per host (codex / mcp / claude_code) + routing `governance_critical` `DriftAlert` through the surface-bound notification port to the Inspector inbox. Wider surface APIs stay deferred. |
| `NodeInstance` | **Retire** | Runtime engine single-instance is sufficient for the attach model (one daemon, multiple MCP sessions); no user-surfaced scenario requires multi-engine binding. Repo is complete but daemon never mounts it. Retirement removes one table + one repo + the schema. Future re-introduction is cheap. |
| `SynthesisCapsule.promotion` lifecycle | **Retire promotion fully — but ONLY after the replacement promoter ships** | Promotion fields (`authority_round_count`, `cooldown_until`, `promotion_state`) + three service methods + the legacy synthesis-promotion proposal code path are unwired. The replacement is `soul.resolve.confirm` (Cat-A.2). **Retire must follow `soul.resolve` going live, not precede it** — a P1 retire ahead of P4 leaves Garden compile output without a promoter (mid-air state). |
| `HealthIssueGroup` (new control-plane projection) | **Build** | Replaces the earlier (rejected) idea of reusing `SynthesisCapsule` for health-inbox aggregation. Groups `OrphanRadar` / `Green` / `evidence_failure` entries by `target_memory_id × cause_kind`. New `health_issue_groups` table + repo. |
| `UpgradeAssessmentAxis` (5 fields on `GapRecord` / `HandoffRecord`) | **Decide at L0 close** | All five fields (`recurrence_runs`, `recurrence_surfaces`, `governance_impact`, `unresolved_age_ms`, `upgrade_candidate`) are hardcoded `null` at creation because the computer that would populate them was never built. **Do not retire unless an upgrade-candidate computer ships in v0.3.9.** If no computer ships, L0 closeout records the deferred condition and the schema slot stays so the future computer has a target. |

### D2 — Garden deterministic triage governance status

**Unified typed-resolution governance.** Garden's deterministic
`SignalService.evaluateTriage` + `MaterializationRouter` remains the
**low-trust durable producer**, but its **only legal claim output is
`claim_status = draft`**. There is no "high-confidence + evidence_refs
auto-active" fast path — evidence_refs presence is a syntactic property
of the signal, not a verification fact about the referenced capsule.

Active promotion requires a **typed resolution recorded in EventLog**
through one of two reviewer-bound routes:

1. **Inline typed resolution (`soul.resolve`)** — agent receives a
   `staged_warning` on a draft claim during recall, invokes
   `soul.resolve` with `resolution = confirm` and a typed payload; the
   handler atomically writes the audit event, calls
   `ClaimService.transitionLifecycle(draft → active)`, and binds the
   active claim to the agent's MCP session identity.
2. **Out-of-band Proposal (`soul.propose_memory_update` + review)** —
   explicit host assertion or operator manual review through Inspector /
   CLI / MCP review. Unchanged from v0.3.8.

Both routes share the same audit shape and reviewer identity binding.
`SoulToolGovernanceAdapter` continues to gate active runtime governance
on `claim_status ∈ {active, contested, winner}`; Garden's draft output
never enters runtime governance until a typed resolution promotes it.

**Inspector cannot directly mutate durable state.** Any Inspector
action that appears to "promote" / "retire" / "relink" routes through
one of the two typed-resolution paths above; Inspector is the
origination surface, not the persistence surface (invariant §21 + §21b).

Handbook prose updated to two co-existing governance routes
(low-trust deterministic + typed-resolution promotion). The single
"proposal route" language is dropped.

### D3 — PathRelation EventLog-first fix approach

**Transactional `publishEventLogMutation` wrap.**
`PathRelationProposalService.propose` routes its `repo.create(...)`
through `publishEventLogMutation`, emitting `path.relation_created` in
the same SQLite transaction as the row insert. Pattern matches
`PathPlasticityService` reinforcement / weakening / retirement /
redirection. The graph-edge audit/insert atomicity gap noted in
`packages/protocol/src/soul/memory-graph.ts:43-54` is closed the same
way for `MemoryGraphEdgeRepo.ensureEdge` /
`GraphExploreService.addEdge`.

---

## 3. Eleven categories (status table)

Categories from the original triage. Status reflects state at the head
of `worktree-v0.3.9-three-layer-repair` (current snapshot is §4 below).

| Cat | Aim | Layer | Status |
|---|---|---|---|
| **0** | PathRelation EventLog-first + graph-edge audit atomicity | L2+L3 | **Done** — tagged `v0.3.9-blocking-p0` |
| **A** | Inline Governance Loop — `staged_warnings` on recall payload, `GovernancePolicy` resolver, new `soul.resolve` typed verb, fatigue controls | L3 | Pending L3 |
| **B** | Memory Quality Lift — materialization routes by `object_kind`; Garden's only legal claim output is `draft`; `potential_conflict` signal kind routed | L1 | Pending L1 |
| **C** | Usage Loop Widening — `resolveUsedObjectIds` allows single used object for telemetry / HOT promote / usage anchor (no PathRelation synthesis from a single used); 5-bucket usage telemetry split | L3 | Single-used path already correct in code (verify); 5-bucket split pending L3 |
| **D** | Data correctness — codex review blocking + important findings (LoCoMo `evaluated_count` denominator, cohort metric ≤ 50%, sample-size label, runtime-status sync, embedding-on baseline policy, Phase 6 bench truth-up) | All | Pending L0 |
| **E** | Inspector Health Inbox — aggregate Auditor / OrphanRadar / Green by memory / evidence_ref / root cause; typed actions per class; fatigue dedupe | L3 | Schema + repo done (D1); Inspector page + producer aggregation pending L3 |
| **F** | Path-Driven Manifestation Activation — stored `PathRelation` → `ActivationCandidate` → `ManifestationResolver` producer; explicit governance-class → stance/nudge/lens policy; `verification_bias` + `unfinishedness_bias` landing strategy | L2 | Pending L2 |
| **G** | Schema Field Reclamation — every K.1-K.4 dead/half-dead/computed-then-discarded field: wire consumer or remove from schema; evaluate enum-single-producer extension vs retraction | All | **Partial.** Done: `evidence_kind` diversification, `MemoryEntry.contradiction_count` recall consumer, `FormationKind` producer refresh (inferred / derived path). Pending: precedence_basis recency / authority producer, confidence direct read, expires_at sweeper, mapping_revoked producer, `karma_events` three producers, `PathRelation.stability_class` evolver, `PathGraphSnapshot` 11-field decision, `potential_conflict` route, ContextDeliveryRecord.run_id / UsageProofRecord.reason Inspector consumer. |
| **H** | Dead-abstraction action — execute D1 | All | **Partial.** Done: H.1 NodeInstance retire; H.4 DeferredObligation wire; H.5 narrow SurfaceDrift → HealthJournal. Pending: H.2 SynthesisCapsule.promotion retire (deferred until L3 ships `soul.resolve`); H.5 full surface_identities-per-attach; H.3 UpgradeAssessmentAxis (decide at L0 close). |
| **I** | 21k+ sink repair — GreenStatus silent UPDATE (affected-row guard + workspace predicate + EventLog mandatory); OrphanRadar feeds Category E; evidence_failure aggregates upward to E | L3 | I.1 done as part of P0. I.2/I.3 pending L2-C (HealthIssueGroup ingest). |
| **J** | Docs truth alignment — `runtime-status.md` readiness split into 4 levels; every producer/consumer path tagged separately; v0.3.8 closeout retroactively annotated where labels were overstated | Docs meta | Pending L0 |

Backlog inclusion: **#BL-044** (recall utilization follow-through,
deferred from v0.3.8) is resolved by Cat-C 5-bucket split + Cat-E
operator drill-down. No other open backlog. `#BL-039 / 040 / 041 / 042 /
045 / 046` already closed in v0.3.8.

Out of scope (explicit): no R@K chasing; no new MCP verbs beyond
`soul.resolve` (14th); no agent-frontend GUI / conversation TUI
(invariant §21a); embedding provider semantics unchanged.

---

## 4. Current snapshot (frozen at the head of this plan)

- **Branch / worktree:** `.claude/worktrees/v0.3.9-three-layer-repair`
  on branch `worktree-v0.3.9-three-layer-repair`.
- **Tag `v0.3.9-blocking-p0`** at commit `b71566e` — Cat-0.1 / Cat-0.2 /
  Cat-I.1, reviewer + Codex two-round review-loop verdict clean.
- **Most recent commit** when this consolidated plan landed: see
  `git log --oneline -5` for the current head. The `commit` that
  introduced this single-file plan also deletes the original
  `README.md` / `decisions.md` / interim `orchestration-plan.md`.
- **Tests at HEAD:** 2665 / 2665.

### What landed and stays (do NOT redo)

| Slot | Landed | Justification |
|---|---|---|
| Cat-0.1 PathRelation EventLog-first | `087efb3` + `b71566e` review-loop fix | Atomicity invariant restored |
| Cat-0.2 GraphExploreService.addEdge atomicity | Same | Atomicity invariant restored |
| Cat-I.1 GreenStatus revoke guard + `green_revoke_noop` | Same | Silent UPDATE bug closed |
| Cat-H.1 NodeInstance retire (table + repo + zod + migration 069) | `0200573` (part of P1 first pass) | Single-instance runtime engine is the decided shape (D1); reintroduction is cheap |
| Cat-H.4 `DeferredObligationService` instantiated in daemon | `b5d60f0` | Producer for Cat-F `obligation` `PathAnchorRef` + Cat-A `soul.resolve.defer` |
| Cat-H.5 (narrow) `SurfaceDriftService` → `HealthJournal` | `b5d60f0` | `governance_critical` drift alerts surface in Inspector inbox via D1 projection |
| D1 `HealthIssueGroup` projection (zod + repo + migration 071) | `b5d60f0` | Inspector health inbox aggregation target |
| Cat-G `evidence_kind` diversification | `b5d60f0` | Producer no longer collapses to 100% `inferred` |
| Cat-G `MemoryEntry.contradiction_count` recall consumer | `7e09666` | Adds `contradiction_penalty` to recall score |
| Cat-G `FormationKind` producer refresh (inferred / derived) | `7e09666` | `toFormationKind(signal)` picks `derived` for LLM-with-`source_memory_refs`, `inferred` otherwise |

### What was rolled back and is **explicitly deferred until a prerequisite ships**

| Slot | Deferred until | Reason |
|---|---|---|
| **Cat-H.2 SynthesisCapsule.promotion retire** | L3 closes Cat-A.2 `soul.resolve` | Without `soul.resolve`, Garden compile produces synthesis candidates with no promoter. Retiring promotion early leaves them as a graveyard. The original plan §P1.2 (pre-rewrite) put the retire in P1 ahead of the P4 replacement — an execution-order bug. |
| **Cat-H.3 UpgradeAssessmentAxis retire** | An upgrade-candidate computer ships in L2, OR L0 closeout records the deferred condition | The 5 fields are the schema slot for meta-cognitive gap aggregation; retiring without a replacement loses the slot. The original plan §P1.3 logged `Risk: zero (fields were hardcoded null)`, missing the slot-purpose question entirely. |

### Architecture-first checklist (mandatory before any Cat-H retire or Cat-G reclamation)

Every retire / wire decision MUST answer two questions in the commit
message AND in the subagent return schema:

1. **What does this slot serve in the architecture?** (one sentence)
2. **Who serves it now if we retire / who consumes it if we wire?**
   (one sentence; if "nobody", that is grounds to NOT retire and to
   write a deferred condition into L0 closeout instead)

The two rolled-back retires (H.2 / H.3) both skipped this checklist.
The orchestration model below treats the checklist as a hard gate,
not a recommendation.

### Open architecture questions to answer before each remaining lens starts

1. **Cat-B routing-by-`object_kind`** (L1) — when the router stops
   creating the 1:1:1 trio for some `object_kind` values, what does
   Garden actually write for those signals? L1-A owner MUST decide for
   each `RouteTarget` value and verify no downstream reader breaks when
   a signal stops at the earlier tier.
2. **Cat-G `precedence_basis.recency` / `authority` producer** (L1) —
   `ClaimService.create` (and the supersede path) must choose
   `precedence_basis` based on signal source + enforcement level. L1-B
   locks the truth table before coding.
3. **Cat-F `governance_class → manifestation_preference` policy** (L2)
   — policy module defines which `governance_class` may emit
   `lens_entry` / `dialogue_nudge` / `stance_bias`. L2-B locks the
   table before wiring.
4. **`PathGraphSnapshot` 11 unused fields** (L2) — per-field decision:
   wire into Inspector view, or remove from schema. Kept set today is
   `total_active_paths` + `isolated_anchors`; the other 9 either land
   a consumer or get a remove migration. L2-C returns the per-field
   decision.
5. **`Proposal.expires_at` sweeper** (L2 or L3) — if added, sweeper
   moves pending proposals to `expired` after the timestamp. If not
   added the field stays unused; choose explicitly.

---

## 5. Execution lenses (order: L1 → L2 → L3 → L0)

Each lens block is **self-contained** so the orchestrating thread can
re-enter after context compression without re-deriving scope.

### Lens L1 — Memory ontology producer diversification

**Goal:** stop the producer-side single-value collapses
(`100% inferred`, `99% fact`, `100% draft`) so the live ontology has the
shape recall + governance expect. Closes Cat-B + the L1 portion of
Cat-G.

**Three subagent task packages, dispatch in parallel:**

#### L1-A: MaterializationRouter routing-by-`object_kind` + Garden `claim_status=draft` lock (D2) + `potential_conflict` route

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `packages/soul/src/garden/materialization-router.ts`
  - `packages/soul/src/__tests__/materialization-router.test.ts`
  - new test `packages/soul/src/__tests__/materialization-router-routing.test.ts`
- **Forbidden paths:** anything outside `packages/soul/`; do not touch
  the protocol zod schema in this pack — the router consumes the
  existing `signal.object_kind`.
- **Architecture-first answers (mandatory in return schema):**
  1. What does each new `RouteTarget` serve? (signal_only / evidence_only
     / evidence_short_ttl / memory_entry_only / memory_and_claim_draft)
  2. Who consumes the rows produced by each route? (per-route reader)
- **Must verify before stop:**
  - `rtk pnpm exec vitest run packages/soul/src/__tests__/` clean
  - `route()` mapping: `scope` / `task_scope` / `workflow_preference`
    → `signal_only`; `activity` / `review_scope` → `evidence_only`;
    `workspace_status` / `project_state` → `evidence_short_ttl`;
    `preference` / `decision` → `memory_and_claim_draft`; `outcome` /
    `reference` / `task_state` → `memory_entry_only`; unknown →
    `evidence_only`
  - `potential_conflict` signal kind routes to a path that invokes
    `ConflictDetectionPort.evaluate`, not the questionable-evidence
    fallback
  - claim_status default through this router is **always** `draft`
    (assertion in test)
  - existing 25 materialization-router tests still pass (update only
    fixtures where the new routing rule actually changes the expected
    outcome)
- **Stop condition:** all asserts above + new routing test green
- **Return schema:**
  - `files_touched`: list
  - `routes_added`: list of `{signal_kind | object_kind, RouteTarget}`
  - `routes_removed`: any removed targets
  - `architecture_answers`: object with `slot_purpose` + `consumer`
    for each route
  - `test_summary`: pass / fail counts
  - `migrations_added`: should be empty
  - `open_questions`: anything the owner could not lock without
    orchestrator input

#### L1-B: `precedence_basis.recency` / `authority` producer in `ClaimService.create` + supersede path

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `packages/core/src/governance/claim-service.ts`
  - `packages/core/src/__tests__/governance/claim-service.test.ts`
  - `packages/soul/src/garden/materialization-router.ts` — only
    `buildClaimInput()`, to thread the right `precedence_basis` from
    the signal
- **Forbidden paths:** schema files (do not touch `PrecedenceBasis`
  enum)
- **Architecture-first answers:**
  1. What does each `precedence_basis` value (`recency` / `authority` /
     `evidence_strength` / `user_override`) signal downstream?
  2. Who reads `precedence_basis` to make arbitration / governance
     decisions? (audit the consumer side)
- **Must verify:**
  - `recency` when a new claim supersedes an older same-subject claim
  - `authority` when the new claim has `enforcement_level = strict`
  - `evidence_strength` default for normal Garden compile output
  - `user_override` when source is `user_seed` or signal carries an
    override marker
  - claim-service tests pass
- **Return schema:** same shape as L1-A plus `precedence_table`
  (4-way mapping)

#### L1-C: Recall scoring reads `MemoryEntry.confidence` directly

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `packages/core/src/recall/recall-service.ts` (`computeEffectiveScoreDetails`)
  - `packages/core/src/recall/recall-candidate-builder.ts` (small wiring if
    needed)
  - `packages/protocol/src/soul/recall-candidate.ts` (only if a new
    factor needs a schema field; `contradiction_penalty` already exists)
  - tests in `packages/core/src/__tests__/recall-*`
- **Forbidden paths:** materialization router, claim service,
  plasticity
- **Architecture-first answers:**
  1. What does `confidence` semantically promise (vs `retention_score`
     vs `activation_score`)?
  2. Who else reads `confidence` today? (don't break their contract)
- **Must verify:**
  - recall scoring uses `entry.confidence` as a sub-weight, not only
    via `retention_score`
  - new sub-weight bounded, score still clamped `[0, 1]`
  - `recall-8factor.test.ts` and `recall-service-tier-cascade.test.ts`
    still pass
  - new test: two memories identical except for `confidence` produce
    ordered scores
- **Return schema:** same as L1-A

**L1 orchestrator gate:**

After all three subagents return, the orchestrator:

1. Runs `rtk pnpm build` and `rtk pnpm test`.
2. Dispatches review-loop:
   - `Agent({subagent_type: "reviewer", ...})` — Claude lens
   - `Skill({skill: "codex:rescue", args: "adversarial review of L1 ..."})`
   - Findings to `.do-it/v0.3.9-l1-review/`
3. Fix-loop until verdict `clean` on both lenses
   (`feedback_review_loop_until_clean`)
4. **Commits + tags `v0.3.9-l1`** on the final clean commit

---

### Lens L2 — Structure registry activation

**Goal:** `PathRelation` + staged edges + governance / plasticity
vectors stop being inert schema and become first-class producers +
consumers. Closes Cat-F + the L2 portion of Cat-G + Cat-I.2 / I.3.

**Three subagent task packages, dispatch in parallel:**

#### L2-A: Cat-F PathRelation → ActivationCandidate producer + ManifestationResolver consumes `verification_bias` / `unfinishedness_bias`

- **Owner:** `architecture-strategist` (to draft the producer-vs-resolver
  interface) THEN `typescript-pro` (to implement). Orchestrator chains
  them; strategist returns a design as input to the implementer.
- **Write ownership:**
  - new `packages/core/src/path-graph/path-activation-candidate-producer.ts`
  - `packages/core/src/manifestation-resolver.ts` (extension)
  - `apps/core-daemon/src/index.ts` (wire producer)
  - tests
- **Architecture-first answers:**
  1. What does each `effect_vector` field promise downstream
     (`salience` / `recall_bias` / `verification_bias` /
     `unfinishedness_bias` / `default_manifestation_preference`)?
  2. Who consumes `verification_bias` (Auditor scheduling)? Who
     consumes `unfinishedness_bias` (recall sidecar `pending` flag)?
- **Must verify:**
  - stored `PathRelation` with non-zero `verification_bias` causes
    Auditor evidence-recheck for its anchor memory to be scheduled
    before a path with `verification_bias = 0`
  - `unfinishedness_bias` carried through to the recall sidecar as a
    `pending` / `incomplete` flag
- **Return schema:** standard

#### L2-B: `governance_class` → manifestation policy + promotion ladder + `stability_class` evolver

- **Owner:** `typescript-pro`
- **Write ownership:**
  - new `packages/core/src/path-graph/path-manifestation-policy.ts`
  - `packages/core/src/path-plasticity/service.ts` (extend plan output
    with promotion plan-step + `stability_class` transitions)
  - `packages/core/src/manifestation-resolver.ts` (consume policy)
  - new tests
- **Architecture-first answers:**
  1. What does each `governance_class` (`hint_only` / `attention_only`
     / `recall_allowed` / `strictly_governed`) authorise / forbid?
  2. What does each `stability_class` (`volatile` / `normal` / `stable`
     / `pinned`) buy at recall and at retention?
- **Must verify:**
  - `hint_only → no manifestation`; `attention_only → lens_entry`;
    `recall_allowed → lens_entry + dialogue_nudge`;
    `strictly_governed → all three including stance_bias`
  - `stability_class` evolves `volatile → normal → stable` on cumulative
    `support_events_count` thresholds (defaults 3 / 8);
    `stable → pinned` only when `governance_class = strictly_governed`
  - promotion ladder: `hint_only → attention_only` after
    `support_events_count ≥ 3` with `contradiction_events_count = 0`;
    `attention_only → recall_allowed` after `≥ 8`; `strictly_governed`
    stays user-set; each promotion writes `path.governance_promoted`
- **Return schema:** standard

#### L2-C: `karma_events` three producers + Cat-I.2/I.3 → `HealthIssueGroup` + `PathGraphSnapshot` 11 fields decision + `mapping_revoked` producer

- **Owner:** `typescript-pro` (orchestrator may split into two if the
  scope feels large; prefer a single owner so decisions stay consistent)
- **Write ownership:**
  - `packages/core/src/dynamics-service.ts` (or
    `karma-event-store.ts`) — three producers (`reuse_gain` from Cat-C
    single-used loosening; `evidence_gain` from `EvidenceService.update`
    when health goes `questionable → verified`; `supersede_penalty` from
    `ConflictDetectionService` when an existing memory is superseded)
  - `packages/soul/src/garden/auditor.ts` + new `HealthIssueGroup`
    writers — Cat-I.2 OrphanRadar entries upsert into
    `HealthIssueGroupRepo` grouped by `target_memory_id × cause_kind`;
    Cat-I.3 aggregates `evidence_failure` into the same projection
  - `packages/storage/src/repos/garden-data-ports.ts` — produce
    `revoke_reason = 'mapping_revoked'` when an evidence ref is
    rewritten to point at a different capsule
  - `packages/protocol/src/soul/path-graph-snapshot.ts` (or equivalent)
    — keep `total_active_paths` + `isolated_anchors`; for each of the
    other 9 fields either ship a remove migration OR wire an Inspector
    consumer (owner returns the per-field decision)
  - migrations as needed
- **Architecture-first answers:**
  1. What does each `karma_events` kind represent
     (`accept_gain` / `reject_penalty` / `reuse_gain` / `evidence_gain`
     / `supersede_penalty`)?
  2. For each of the 9 unused snapshot fields, what was it meant to
     serve, and what's the closure (wire / remove)?
- **Must verify:**
  - each karma producer fires in its own scenario
  - `HealthIssueGroup` rows appear after one Auditor pass over a
    workspace with orphans + failed evidence
  - `revoke_reason = 'mapping_revoked'` shows up for a re-anchored
    evidence
  - `PathGraphSnapshot` schema lines up with the per-field decision
    (no unread fields after this lens)
- **Return schema:** standard plus `decisions_taken` (the 9 snapshot
  fields outcome list)

**L2 orchestrator gate:** standard review-loop, then tag `v0.3.9-l2`.

---

### Lens L3 — Runtime control + governance loop closure

**Goal:** trust loop closes end-to-end — recall payload carries
`staged_warnings`, `soul.resolve` is reachable from every attached
agent, Inspector Health Inbox renders aggregated entries, and **only
then** the legacy SynthesisCapsule promotion is safe to retire.

Closes Cat-A + Cat-C 5-bucket + Cat-E + Cat-H.5 completion +
**Cat-H.2 retire as the final step**.

**Four subagent task packages; dispatch in two waves.**

#### Wave 1 (parallel)

##### L3-A: Cat-A.1 `soul_recall` payload extension with `staged_warnings`

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `apps/core-daemon/src/mcp-memory-tool-handler.ts` (recall handler)
  - `apps/core-daemon/src/mcp-memory-tool-catalog.ts` (tool description)
  - `packages/protocol/src/recall-payload.ts` (or matching schema)
  - new test
- **Must verify:**
  - each pointer can carry `staged_warnings: StagedWarning[]`
  - each warning has `kind`, `severity`, `policy`, `summary`,
    `resolution_options`
  - field optional so older agents skip it
- **Return schema:** standard

##### L3-B: Cat-C.2 5-bucket usage telemetry split (server-side route)

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `apps/inspector/src/routes/recall-utilization.ts` (new daemon
    route) — buckets `no_recall` / `empty_recall` /
    `delivered_not_reported` / `reported_skipped_or_na` / `reported_used`
  - new eval helper `packages/eval/src/utilization-buckets.ts` if
    needed for reuse
  - tests
- **Forbidden paths:** the Inspector web UI for this bucket (L3-D owns
  it)
- **Must verify:**
  - route returns per-workspace per-`agent_target` 5-bucket counts
    summing to deliveries + `no_recall` from EventLog
  - `single_used_anchor` telemetry event emitted on 1-used reports
    (does NOT advance PathRelation counter)
- **Return schema:** standard

#### Wave 2 (after Wave 1 returns; parallel)

##### L3-C: Cat-A.2 new MCP verb `soul.resolve` + Cat-A.3 `GovernancePolicy`

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `apps/core-daemon/src/mcp-memory-tool-catalog.ts` (register the 14th
    verb)
  - new handler `apps/core-daemon/src/mcp-memory-resolve-handler.ts`
  - new `packages/core/src/governance/resolution-service.ts` (typed dispatcher)
  - new `packages/core/src/governance/governance-policy.ts` (`classifyWarning`
    returns `ask_now` / `apply_silently` / `track_only` /
    `inspect_later`; per-turn `ask_now` budget)
  - `packages/engine-gateway/src/provider/soul-tool-specs.ts`
  - tests including end-to-end recall → staged_warning → soul.resolve
    → apply
- **Must verify:**
  - each of the six resolutions (`confirm` / `reject` / `correct` /
    `stale` / `defer` / `not_relevant`) routes correctly and emits the
    typed audit event
  - `defer` creates a `DeferredObligation` via the service wired in P1
  - tool-spec snapshot reflects the new verb
  - README + invariants prose flagged for L0 to update (stage the diff
    but defer the final word to L0)
- **Return schema:** standard

##### L3-D: Cat-E.1 Inspector Health Inbox page + Cat-E.2 strictly_governed Proposal + Cat-H.5 completion (surface_identities-per-attach)

- **Owner:** `react-specialist` + `typescript-pro` (orchestrator may
  split into two subagents; prefer one owner who owns the contract
  between route and page)
- **Write ownership:**
  - new `apps/inspector/web/src/pages/HealthInbox.tsx`
  - new `apps/core-daemon/src/routes/health-inbox.ts` if not already
    added by L2-C
  - `apps/inspector/web/src/pages/MemoryBrowser.tsx` — add "Promote to
    strictly_governed" button that posts a typed `path_relation`
    Proposal (origination surface only)
  - `apps/core-daemon/src/cli/attach.ts` (or matching MCP attach path)
    — call `SurfaceService.createSurface` once per host attach so
    `surface_identities` rows exist for `codex` / `mcp` / `claude_code`
    per workspace
  - tests
- **Must verify:**
  - Inspector page renders with at least 5 grouped entries against a
    fresh DB seeded by tests
  - clicking the promote button creates a `path_relation` Proposal
    (not a direct mutation)
  - daemon writes a `surface_identities` row on first attach per
    `agent_target` per workspace
- **Return schema:** standard

#### Wave 3 (orchestrator-only) — Cat-H.2 retire as the final L3 step

After Wave 1 + Wave 2 return cleanly AND the L3 review-loop reports
verdict `clean`, the orchestrator finally lands the deferred retire:

##### L3-E: Cat-H.2 SynthesisCapsule.promotion retire (only after `soul.resolve` proven)

- **Orchestrator action** (not a subagent — small but cross-cutting):
  drop the three promotion fields, remove the three SynthesisService
  methods, drop the synthesis-promotion code path in `ProposalService`.
  This now has a working replacement: `soul.resolve.confirm` triggers
  `ClaimService.transitionLifecycle(draft → active)` directly, and
  `defer` writes a `DeferredObligation`. Add the drop-columns migration
  + corresponding index drop; verify all tests pass.
- **Architecture-first answers (in commit message):**
  1. What did `promotion_state` / `authority_round_count` /
     `cooldown_until` serve in the old architecture?
  2. Who serves the equivalent now? (`soul.resolve.confirm` writes the
     audit event + claim transition; `soul.resolve.defer` writes the
     obligation that replaces `cooldown_until`; the `authority_round_count`
     read was redundant with `support_events_count` on the PathRelation
     side)
- **Must verify before commit:**
  - `Garden compile → claim` flow still produces an `active` claim
    via `soul.resolve.confirm` (end-to-end integration test added as
    part of L3-C must cover this)
  - no test depends on `promotion_state` anymore
  - drop migration matches existing pattern (drop dependent indexes
    before columns)

**L3 orchestrator gate:** standard review-loop, then tag `v0.3.9-l3`.

---

### Lens L0 — Truth alignment + bench feedback + closeout

**Goal:** docs match what the system actually does (not what it
could); benchmarks act as diagnostic mirrors of L1 / L2 / L3 (per the
user directive "不要为了测试的分数而盲目做内容"); release ready to
merge. Closes Cat-D + Cat-J + the Cat-H.3 final decision + release
artefacts.

**Two subagent task packages; can run in parallel.**

#### L0-A: Cat-D.1–6 data correctness + bench pre/post diff

- **Owner:** `test-automator` (+ optional `sql-pro` for the cohort
  metric)
- **Write ownership:**
  - `apps/bench-runner/src/locomo/runner.ts` (`evaluated_count`
    denominator → `totalQa`)
  - `packages/eval/src/diff.ts`
  - `packages/eval/src/report.ts` (sample-size label cascade: `smoke`
    ≤ 50 / `staged` 51-200 / `shard_merged` 201-499 / `full` ≥ 500)
  - `docs/bench-history/README.md` +
    `docs/bench-history/public/latest-baseline.json` + new sibling
    `docs/bench-history/public/latest-baseline-embedding-on.json`
  - new directory `docs/bench-history/public-pre-v0.3.9/` for Pass A
    archives
  - `docs/v0.3/v0.3.9/reports/v0.3.9-bench-diff.md` (filled per
    category)
  - `docs/v0.3/v0.3.8/reports/v0.3.8-closeout.md` retroactive truth-up
- **Must verify:**
  - LoCoMo bench rerun reports `evaluated_count ≈ totalQa`
  - cross-question-100 rerun shows cohort attribution ≤ 50%
  - existing 100/500 archives rerendered show `label = staged` not
    `full`
  - `latest-baseline.json` no longer points at a FAIL archive
  - bench diff doc table filled for every row
- **Return schema:** standard

#### L0-B: Cat-J doc truth alignment + Cat-H.3 final decision + release-notes + closeout

- **Owner:** `documentation-engineer`
- **Write ownership:**
  - `docs/handbook/runtime-status.md` (rewrite per 4-level readiness:
    `schema_only` / `implementation_wired` / `live_event_proven` /
    `agent_used`)
  - `docs/handbook/invariants.md` §57-77 (D2 two-route governance
    language)
  - `docs/handbook/architecture.md` (low-trust draft + typed-resolution
    chain prose)
  - `README.md` (root project README — governance-route section + new
    14-verb surface note)
  - `docs/v0.3/v0.3.9/release-notes.md`
  - `docs/v0.3/v0.3.9/reports/v0.3.9-closeout.md`
  - **Cat-H.3 decision**: if L2 did not ship an upgrade-candidate
    computer, this lens MUST write a closeout-deferred-condition
    section naming the next release that closes the gap and keep the
    5 fields on the schema. If L2 did ship the computer, this lens
    removes the 5 fields via migration + records the cutover.
- **Must verify:**
  - doc walkthrough confirms no readiness level overstated
  - release notes call out the three load-bearing decisions, the 11
    categories executed (or deferred), and the new 14th MCP verb
  - closeout names every Cat-G decision (per-field outcome)
- **Return schema:** standard

**L0 orchestrator gate:** standard review-loop. Final tag: **`v0.3.9`**
(no suffix).

---

## 6. Main-thread orchestration discipline

Per `feedback_subagent_dispatch_discipline` and
`feedback_delegate_heavy_code_to_codex`:

- The main thread is the **orchestrator**, not the implementer. Heavy
  code lives in subagents.
- Every dispatch carries the **task-package frame**: write ownership,
  forbidden paths, architecture-first answers, must-verify list, stop
  condition, return schema. The shape is fixed (see L1-A above).
- Subagents return one message; the orchestrator does NOT message them
  again. If a subagent returns blocked or unclean, the orchestrator
  decides: re-dispatch a fresh subagent with the gap added, or land a
  small orchestrator-side fix.
- After every subagent batch, the orchestrator runs `rtk pnpm build`
  and `rtk pnpm test` on the worktree before any commit.
- After every lens the orchestrator runs the **review-loop**:
  1. `Agent({subagent_type: "reviewer", ...})` — Claude lens
  2. `Skill({skill: "codex:rescue", args: "adversarial review of ..."})`
     — Codex lens
  3. Findings under `.do-it/v0.3.9-<lens>-review/`
  4. Orchestrator merges, applies fixes (main thread or follow-up
     subagent), re-dispatches the same review-loop until verdict
     `clean` on both lenses (`feedback_review_loop_until_clean`)
- Tags landed by the orchestrator only after review-loop closes clean:
  `v0.3.9-l1` → `v0.3.9-l2` → `v0.3.9-l3` → `v0.3.9`.

### Comments discipline (the hook catches this anyway)

Per `feedback_no_stage_history_comments` and the
`do-it-comments-discipline` skill: comments may be `invariant:`,
`see also:`, type annotations, anchors, or tool directives. **No**
phase numbers, BL-XXX, `Cat-X.Y` markers, version markers, "before
vX.Y", "removed in …", or other narrative. Every subagent task package
inherits this; the orchestrator rejects any returned diff that
violates.

---

## 7. Quick-restart pointer for the orchestrator

After context compression the orchestrator should:

1. `cat docs/v0.3/v0.3.9/plan.md` (this file).
2. `git log --oneline v0.3.9-blocking-p0..HEAD` to see what landed
   since P0.
3. `cat .do-it/v0.3.9-l<N>-review/*.md` to load any open review
   findings for the current lens.
4. Pick the next lens that has no clean tag yet and dispatch its task
   packages in parallel.
5. Drive the review-loop to clean before moving on.

---

## 8. Source documents this plan integrates

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
