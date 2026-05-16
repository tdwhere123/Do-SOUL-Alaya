# v0.3.9 Implementation Plan

Six phases (P0-P5) cover eleven categories (Cat-0 + A-J). Each phase
ends with `do-it-review-loop` (reviewer + codex adversarial lens per
`feedback_review_loop_codex_lens`) until zero Blocking + zero Important.

Worktree default per `feedback_release_workflow` — recommended branch
`work/v0.3.9-three-layer-repair` off `main`.

Conventions used below:
- **Files** lists owning files (relative to repo root).
- **Action** is the surgical change required.
- **Verify** is the post-task gate (lives DB query, test name, or doc
  assertion).
- **Risk** flags rollout / migration / interface concerns.

---

## P0 — Blocking fixes (Cat-0, Cat-I.1)

Goal: close the two handbook-invariant violations before any other
work. Independently merge-able as `v0.3.9-blocking-p0`.

### P0.1 — Cat-0.1: PathRelation EventLog-first

**Files**:
- `packages/core/src/path-relation-proposal-service.ts:146-186`
- `packages/storage/src/repos/path-relation-repo.ts:170-185`
- `apps/core-daemon/src/event-publisher.ts` (or equivalent `publishEventLogMutation` host)
- `packages/protocol/src/events/runtime-governance.ts:69-75` (event shape — no schema change expected, verify)

**Action**:
1. Lift `propose(...)` to accept the EventPublisher port (matches
   `PathPlasticityService` constructor shape).
2. Wrap `repo.create(...)` in `publishEventLogMutation(eventPublisher, …)`
   that emits `path.relation_created` with the row payload and inserts
   the row in the same SQLite tx.
3. Daemon wiring: pass the existing EventPublisher into the proposal
   service in `apps/core-daemon/src/index.ts` (where the service is
   constructed).

**Verify**:
- New unit test `path-relation-proposal-service.event-first.test.ts`
  asserts an `event_log` row with `event_type=path.relation_created`
  precedes/co-exists-with the `path_relations` row insert.
- Live SQLite snapshot after a K=3 co-usage simulation must show one
  `event_log` row of `event_type=path.relation_created` per new
  PathRelation row.
- `rtk pnpm test` clean.

**Risk**: PathRelation creation tx may serialise with concurrent
recall writes. Mitigate by using the same WAL-aware tx helper that
plasticity already uses; spike a parallel-write integration test.

### P0.2 — Cat-0.2: graph-edge audit/insert atomicity

**Files**:
- `packages/storage/src/repos/memory-graph-edge-repo.ts:63-90, 138-170`
- `packages/protocol/src/soul/memory-graph.ts:43-54` (audit comment updated post-fix)
- `apps/core-daemon/src/mcp-memory-tool-handler.ts:1198-1231` (caller, may need to pass EventPublisher through)

**Action**:
1. Define typed event in `packages/protocol/src/events/runtime-governance.ts`
   if missing — e.g. `memory_graph_edge.created` carrying
   `source_memory_id`, `target_memory_id`, `edge_type`, `workspace_id`.
2. Wrap `ensureEdge` insert in `publishEventLogMutation`.
3. Remove the audit-atomicity warning comment in `memory-graph.ts:43-54`.

**Verify**:
- Test: `memory-graph-edge-repo.event-first.test.ts` proves
  insert + event row are atomic.
- Live DB: cross-question replay produces a 1:1 ratio of
  `memory_graph_edge.created` events to new `memory_graph_edges` rows
  (no orphan events, no orphan rows).

**Risk**: callers other than `crossLinkRecalledMemories` may exist
that bypass the new helper. `rtk pnpm exec grep "ensureEdge\|graph-edge-repo"`
sweep before merge.

### P0.3 — Cat-I.1: GreenStatus silent UPDATE

**Files**:
- `packages/storage/src/repos/garden-data-ports.ts:459-485`
- `packages/soul/src/garden/auditor.ts:117-169`
- `apps/core-daemon/src/event-publisher.ts` (EventPublisher mandatory wire)

**Action**:
1. `revokeStatement` adds `workspace_id = ?` predicate and
   `green_state IN ('active', 'contested')` (or current valid
   pre-revoke states) predicate.
2. `revokeGreen` checks affected-row count; when 0, writes a
   `health_journal` no-op entry (`event_kind: green_revoke_noop`) and
   skips the `soul.green.revoked` EventLog write.
3. `publishEventLogMutation` requires non-null EventLog repo at this
   call site (remove the `eventLogRepo === undefined` branch for
   GreenService path).

**Verify**:
- New test: `green-service-revoke-guard.test.ts` covers (a) row-exists
  → revoke + event, (b) no row → health_journal noop + no event.
- Live DB after one Auditor pass: number of `soul.green.revoked` events
  no longer exceeds `green_statuses` row count by more than the active
  workspace baseline (validate after migration).

**Risk**: existing 21k+ `soul.green.revoked` events stay as
historical record. Document in release notes that the pre-v0.3.9
events were silent no-ops and do not represent real revoke actions.

### P0 review-loop gate

- `do-it-review-loop` (reviewer + codex adversarial) until zero
  Blocking + Important.
- Tag `v0.3.9-blocking-p0` on the last commit in P0.

---

## P1 — Schema cleanup (Cat-H, Cat-G)

Goal: clean schema and dead-abstraction surfaces before behaviour
rewires depend on the cleaned ontology.

### P1.1 — Cat-H.1: Retire NodeInstance

**Files** (delete or empty):
- `packages/storage/src/repos/node-instance-repo.ts`
- `packages/storage/src/migrations/<NN>-node-instances.sql` table dropper migration (new)
- `packages/protocol/src/soul/node-instance.ts` (if exists)
- Any imports in `apps/core-daemon/src/index.ts` (verify no live wire)

**Action**:
1. Confirm no live wire (codex audit B-11 already states none).
2. Write migration `0NN-drop-node-instances.sql` that drops the table.
3. Remove repo file, schema file, exports.

**Verify**:
- `rtk pnpm exec grep -r "NodeInstance\|node_instances"` returns only
  the new migration file and historical archive paths.
- `rtk pnpm test` + `rtk pnpm build` clean.

**Risk**: zero (no live wire).

### P1.2 — Cat-H.2: Retire SynthesisCapsule promotion lifecycle

**Files**:
- `packages/protocol/src/soul/synthesis-capsule.ts` — remove
  `authority_round_count`, `cooldown_until`, `promotion_state` fields
  and the corresponding zod schema.
- `packages/storage/src/migrations/<NN>-synthesis-capsule-drop-promotion.sql`
  (new column dropper).
- `packages/core/src/synthesis-service.ts` (or equivalent) — remove
  `requestPromotion`, `resolvePromotionDecision`, `incrementAuthority`.
- `packages/core/src/proposal-service.ts:148-201, 390-409` — remove
  the legacy synthesis-promotion proposal code path.

**Action**:
1. Migrate `synthesis_capsules` table — drop the three columns; keep
   the row.
2. Remove three service methods + their tests.
3. Remove the synthesis-promotion code path in `ProposalService`.
4. Leave `SynthesisCapsule` schema in place for its original
   synthesis-of-facts purpose, but **do not reuse it for Category E
   health-inbox aggregation** (that conflates control-plane signals
   with memory ontology — codex review Important #7). Category E
   builds a new `HealthIssueGroup` control-plane projection
   (covered in P4.4 + a new P1.7 below).

**Verify**:
- `rtk pnpm test` clean.
- No remaining import of the removed methods.

**Risk**: any test relying on synthesis promotion fails — update or
delete those tests.

### P1.3 — Cat-H.3: Retire UpgradeAssessmentAxis

**Files**:
- `packages/protocol/src/soul/gap-record.ts` (or equivalent)
- `packages/protocol/src/soul/handoff-record.ts` (or equivalent)
- `packages/storage/src/migrations/<NN>-drop-upgrade-axis-fields.sql`

**Action**:
1. Drop fields `recurrence_runs`, `recurrence_surfaces`,
   `governance_impact`, `unresolved_age_ms`, `upgrade_candidate` from
   both records.
2. Migration drops the columns from `gap_records` + `handoff_records`.

**Verify**:
- `rtk pnpm test` clean.

**Risk**: zero (fields were hardcoded null).

### P1.4 — Cat-H.4: Keep & Wire DeferredObligation (preparation)

**Files**:
- `packages/core/src/deferred-obligation-service.ts` (verify entry
  points exist).
- `apps/core-daemon/src/index.ts` (wire service into daemon if not
  already wired).

**Action**:
1. Verify `DeferredObligationService.create()` signature is callable
   from materialization-router and from Category A `soul.resolve.defer`.
2. Add daemon wiring if missing (DI binding); add EventPublisher pass
   for any new events the service publishes.

**Verify**:
- A noop integration test that instantiates the service via daemon
  init and confirms `create()` writes a row + event.

**Risk**: if the service has stale APIs that conflict with the new
caller shape, slot a small adapter rather than rewriting the service.

### P1.5 — Cat-H.5: Keep & Wire SurfaceService (narrow)

**Files**:
- `apps/core-daemon/src/index.ts:431` (currently creates orphan
  instance — wire downstream).
- `apps/core-daemon/src/cli/attach.ts` or MCP attach path — register
  `surface_identities` row per host (`agent_target` discriminator).
- `packages/soul/src/garden/auditor.ts` — emit `governance_critical`
  DriftAlert through SurfaceService's notification port.

**Action**:
1. Pass `surfaceService` to attach path so codex/mcp/claude-code
   attaches each create a `surface_identities` row.
2. Wire `governance_critical` DriftAlert classification result into
   SurfaceService's surface-bound notification port (used by Cat-E
   Inspector inbox).
3. Other surface APIs (anchor mutation, binding updates) remain in
   place but unused — document as v0.4 scope in the surface module
   doc.

**Verify**:
- Live DB after one fresh attach: `surface_identities` row exists for
  the attaching `agent_target`.
- Live DB after auditor pass: a `governance_critical` DriftAlert
  produces a `health_journal` entry routed via SurfaceService rather
  than the bare EventLog.

**Risk**: surface_identities row contention if multiple attaches
overlap — add `INSERT … ON CONFLICT` guard.

### P1.6 — Cat-G: Schema Field Reclamation

For every dead/half-dead field in `K.1-K.4` of the live-data portrait,
take one of two actions:

| Field group | Action |
|---|---|
| `EvidenceCapsule.physical_anchor`, `source_hash`, `semantic_anchor`, `event_anchor` (B-extra K.1 💀) | **Cat-B feeds these** — `semantic_anchor` populated when signal carries dia_id or path anchor; `event_anchor` populated when signal carries turn boundary; `physical_anchor` populated when signal carries file/line ref; `source_hash` populated by garden compile. Add reader in recall scoring for `semantic_anchor`. |
| `MemoryEntry.contradiction_count` (K.1 ❌) | **Add consumer** — recall scoring degradation factor `-0.05 * min(contradiction_count, 5)`. Also feeds Cat-F `verification_bias`. |
| `EvidenceCapsule.evidence_kind` enum (K.1 ❌) | **Diversify producer** — `MaterializationRouter` writes `inferred` only when signal source is LLM; writes `referenced` when signal has explicit `evidence_refs`; writes `attested` when signal source is `user_override`. |
| `ClaimForm.precedence_basis.recency`/`authority` (K.1 ❌) | **Add producer** — `recency` written when newer claim supersedes older same-subject; `authority` written when claim's `enforcement_level=strict`. |
| `MemoryEntry.confidence` (K.1 🟡) | **Add direct read** — recall scoring uses `confidence` as a sub-weight (currently goes through `retention_score` indirection). |
| `Proposal.expires_at` (K.2 💀) | **Add sweeper** — daemon-side periodic sweep marks pending proposals past `expires_at` as `expired`. Or remove the field if no use case (D2 says Cat-A `soul.resolve.defer` can extend). |
| `ProposalResolutionState.expired` / `superseded` (K.2 💀) | If `expires_at` sweeper added → `expired` becomes live; `superseded` resolved by Cat-A `soul.resolve.correct` writing a new proposal that supersedes the old. |
| `ProposalOption.unresolved_after_apply` (K.2 ❌) | **Add reader** — Inspector pending list shows count of `unresolved_after_apply` items as a "still-pending downstream" badge. |
| `GreenStatus.revoke_reason='mapping_revoked'` (K.2 ❌) | **Add producer** — emitted when a memory's evidence ref is rewritten to point at a different capsule. Tie-in with Cat-I.2 OrphanRadar resolution. |
| `ContextDeliveryRecord.run_id` / `UsageProofRecord.reason` (K.2 ❌) | **Add Inspector consumer** — Cat-C telemetry split surface uses `run_id` for per-run drill-down; `reason` shown when `usage_state` ∈ {skipped, not_applicable}. |
| `karma_events.reuse_gain` / `evidence_gain` / `supersede_penalty` (K.3 💀) | **Add producers** — `reuse_gain` emitted by Cat-C 1-used loosening; `evidence_gain` emitted by `EvidenceService.update` when health goes `questionable → verified`; `supersede_penalty` emitted by `ConflictDetectionService` when an existing memory is superseded. |
| `PathRelation.stability_class` (K.3 💀) | **Add evolver** — `PathPlasticityService` plan-step transitions `volatile → normal` after `support_events_count ≥ 5`, `normal → stable` after `≥ 15`, `stable → pinned` only on `governance_class=strictly_governed`. |
| `direction_bias` (K.3) | **Already live — no Cat-G action** — recall path expansion already reads it (`packages/core/src/recall-service.ts:2038`) and plasticity uses it (`apps/core-daemon/src/path-plasticity-runtime.ts:398-418`). Earlier classification as 🟡 computed-then-discarded was a finding-stage error; corrected here. |
| `governance_critical` DriftAlert (K.3 🟡) | **Cat-H.5 wires** through SurfaceService. |
| `PathGraphSnapshot` 11 fields (K.4 🟡) | **Add Inspector consumer** — `apps/inspector/web/src/pages/PathSnapshot.tsx` (or similar) renders distributions + deltas. Or remove the fields. Decision per field: keep `total_active_paths`, `isolated_anchors` (live); remove the 9 unused unless an Inspector view ships in v0.3.9. |
| `FormationKind.inferred`/`derived` (K.1 🟡) | **Either add `toFormationKind` cases or remove** — decision: remove (no live producer path identified). |
| `CandidateMemorySignal.signal_kind = potential_conflict` (K.1 🟡) | **Add route** — `MaterializationRouter` routes `potential_conflict` signals through `ConflictDetectionService.evaluate()` rather than evidence-only fallback. |

**Verify (per group)**:
- A reader-side test demonstrating the consumer fires for the new
  producer.
- Live DB after one workflow run shows the previously-empty field
  populated for at least one row.

**Risk**: G is the largest sub-category by file count. Recommended
order: producer-only first (evidence_kind diversification, karma
producers), then consumer-only (Inspector readers), then bi-directional
(stability_class evolver). Single phase but multiple commits, each
reviewed.

### P1 review-loop gate

- `do-it-review-loop` until zero Blocking + Important.
- Schema migrations applied to test DB and live DB (operator's
  alaya.db backed up before).

---

## P2 — Memory-loop rewire (Cat-B, Cat-C)

Goal: the core change to how durable memory is produced and how usage
loops back.

### P2.1 — Cat-B.1: Materialization routing by object_kind

**Files**:
- `packages/soul/src/garden/materialization-router.ts:164-273, 540-599, 657`

**Action**:
1. Replace the `confidence ≥ 0.5 → memory_and_claim` blanket route
   with a routing function keyed on `detected_object.object_kind`:

```ts
type RouteTarget =
  | "signal_only"            // scope statements, transient
  | "evidence_only"          // activity reports, status snapshots
  | "evidence_short_ttl"     // workspace_status (TTL via Auditor staleness)
  | "memory_entry_only"      // facts, references, observations
  | "memory_and_claim_draft";// preferences / decisions (always draft, per D2)
```

2. Specific mappings:
   - `scope` / `task_scope` / `workflow_preference` (transient) → `signal_only`
   - `activity` / `review_scope` → `evidence_only`
   - `workspace_status` / `project_state` → `evidence_short_ttl`
   - `decision` / `preference` (any confidence) → `memory_and_claim_draft`
   - `outcome` / `reference` / `task_state` → `memory_entry_only`
   - Unknown / unmapped → `evidence_only` (current `questionable`
     fallback, but no longer creates memory_entry + claim)

   Note: no `memory_and_claim_active` route. Per D2, Garden's
   only legal claim output is `draft`. Active promotion requires
   `soul.resolve.confirm` (Cat-A) or Proposal/HITL.

3. Update `dimension` mapping in `toMemoryEntryDimension` so unknown
   object_kind no longer collapses to `fact` — instead, the routing
   function above gates whether a memory_entry is even created.

4. Remove the universal 1:1:1 trio creation; let each route create
   only the rows it semantically maps to.

**Verify**:
- New test `materialization-router-routing.test.ts` covers each route
  with a fixture signal.
- Live DB after one Garden compile pass: `evidence_kind` distribution
  diversifies (no longer 100% `inferred`); `dimension` distribution
  diversifies; some signals stop at `signal_only` (no memory_entry
  row created).

**Risk**: existing test fixtures assume 1:1:1. Update or refresh.

### P2.2 — Cat-B.2: WITHDRAWN (rejected by codex review)

**Status**: Withdrawn. The earlier draft of this task allowed
`MaterializationRouter` to create `claim_status=active` directly when
both `confidence ≥ 0.7` and `signal.evidence_refs.length > 0`.

**Why withdrawn**: presence of `evidence_refs` is a syntactic property
of the signal, not a verification fact about the referenced capsule.
Verification is a separate event chain (`EvidenceService.update`,
`green_statuses.verified_at`, Auditor). Allowing
`MaterializationRouter` to skip the typed-resolution step would
short-circuit verification and bind active runtime governance to an
unverified ontology row. See `decisions.md` §D2 "Rejected
alternatives".

**Replacement path**: Garden's only legal claim output is
`claim_status=draft`. Active promotion is gated by
`soul.resolve.confirm` (Cat-A) or `soul.propose_memory_update +
review` (Proposal/HITL, unchanged from v0.3.8). No
`memory_and_claim_active` route target exists in Cat-B.

**Files unchanged**: this section now has no implementation footprint;
referenced files remain on the v0.3.8 behaviour for direct
activation (i.e. they do not directly activate from materialization).

### P2.3 — Cat-C.1: Single-used-object → telemetry + anchor, NOT relation synthesis

**Files**:
- `apps/core-daemon/src/mcp-memory-tool-handler.ts:929-942, 1200-1242, 1329-1345`

**Action**:
1. `resolveUsedObjectIds` returns the explicit `used` set without
   the `length >= 2` precondition (so single-used reports are no
   longer dropped before downstream telemetry).
2. **Single-used reports** trigger only:
   - usage proof persistence (current behaviour)
   - HOT tier promotion of the single used memory (current behaviour
     when count ≥ 1)
   - a `single_used_anchor` telemetry event for Cat-C.2 bucket
     classification.
   They do **not** create any graph edge and do **not** advance
   `PathRelationProposalService` counters.
3. **PathRelation co-usage semantics preserved**: only ≥ 2 used object
   ids in the same report contribute one tick to the K=3 counter.
   PathRelation is by definition a relation between two co-used
   memories; single-used reports are anchor data, not relation data.
   Synthesising a 0.5 co-usage from "1 used + next-highest delivered"
   would conflate "user used this memory" with "user co-used these
   two memories" — codex review Blocking #1 rejection.
4. **No new edge type.** The earlier proposal of a `recalls_anchor`
   typed edge from used memory to next-highest delivered is dropped;
   that information lives in the telemetry stream and the
   single-used anchor signal in the next recall's
   `staged_warnings` payload (Cat-A).

**Verify**:
- Test confirms single-used report writes usage proof + HOT promote
  but **does not** insert any `memory_graph_edges` row or increment
  `PathRelationProposalService`'s counter.
- Test confirms ≥ 2 used reports continue producing RECALLS edges +
  PathRelation co-usage as before.
- Live DB after a 1-used `report_context_usage`: `memory_graph_edges`
  count unchanged; single-used telemetry bucket increments.

**Risk**: telemetry bucket name `single_used_anchor` must not be
misread as relation data. Document at the call site + in the
telemetry surface (Cat-C.2) that the bucket counts standalone usage,
not relation evidence.

### P2.4 — Cat-C.2: Usage telemetry split 5 buckets

**Files**:
- `apps/inspector/src/routes/bench-summary.ts` (or new
  `recall-utilization.ts` route)
- `apps/inspector/web/src/pages/Overview.tsx`
- New eval helper in `packages/eval/src/utilization-buckets.ts`

**Action**:
1. Daemon route returns counts per workspace / per `agent_target`:
   - `no_recall` — turn finished with no `soul.recall` call
   - `empty_recall` — `pointer_count = 0`
   - `delivered_not_reported` — delivery without `report_context_usage`
   - `reported_skipped_or_na` — `report_context_usage` with `usage_state ∈ {skipped, not_applicable}`
   - `reported_used` — ≥1 used object id
2. Inspector Overview shows a stacked bar / list per `agent_target`.
3. Resolves `#BL-044`.

**Verify**:
- Live DB query path returns the 5 buckets summing to the count of
  delivered events + `no_recall` count from EventLog.
- Inspector page visually splits the buckets and identifies which
  bucket dominates per host.

**Risk**: `no_recall` requires turn detection on the daemon side
which Alaya does not have (turns are host-defined). Implementation
uses `runs` table activity windows as a proxy and labels the metric
"approximate" in the UI.

### P2 review-loop gate

- `do-it-review-loop` until zero Blocking + Important.
- Live snapshot diff verified: `evidence_kind` and `dimension` no
  longer single-value.

---

## P3 — Behaviour activation + sink repair (Cat-F, Cat-I.2-3)

### P3.1 — Cat-F.1: PathRelation → ActivationCandidate producer

**Files**:
- New `packages/core/src/path-activation-candidate-producer.ts`
- `packages/core/src/manifestation-resolver.ts:201-228, 410-412` (verify consumer hook)
- `apps/core-daemon/src/index.ts` (wire producer)

**Action**:
1. New service reads stored `PathRelation` rows on demand (or via a
   recall-side trigger) and emits `ActivationCandidate` rows containing
   `effect_vector_snapshot` (full 5 fields including
   `verification_bias`, `unfinishedness_bias`, `default_manifestation_preference`).
2. `ManifestationResolver` already consumes `effect_vector_snapshot`
   (`manifestation-resolver.ts:219-225`) but only `default_manifestation_preference`.
   Extend to consume `verification_bias` and `unfinishedness_bias`:
   - `verification_bias`: feeds Auditor scheduling priority (high bias →
     higher priority for evidence recheck).
   - `unfinishedness_bias`: feeds `pending` / `incomplete` memory
     surface flag (shown in Inspector + carried in recall sidecar).

**Verify**:
- New integration test: stored PathRelation row →
  ActivationCandidate → ManifestationResolver decision with all 3
  effect fields read.
- Live behaviour: an active `PathRelation` row with non-zero
  `verification_bias` causes Auditor to schedule its evidence
  recheck before a path with `verification_bias=0`.

**Risk**: ActivationCandidate has a clear schema
(`packages/protocol/src/soul/activation-candidate.ts`) but production
calls need design. Initial scope: produce on-demand at recall time
when a `PathRelation` would be admitted as a `path_expansion`
candidate.

### P3.2 — Cat-F.2: Governance-class → manifestation-preference policy

**Files**:
- New `packages/core/src/path-manifestation-policy.ts`
- `packages/core/src/manifestation-resolver.ts:268-286`

**Action**:
1. Policy module defines which `governance_class` may produce which
   `manifestation_preference`:
   - `hint_only` → no manifestation effect
   - `attention_only` → may produce `lens_entry` only
   - `recall_allowed` → may produce `lens_entry` and `dialogue_nudge`
   - `strictly_governed` → may produce all three including `stance_bias`
2. `ManifestationResolver` consults the policy before lifting the
   preference into a decision.

**Verify**:
- Test for each (`governance_class`, preference) pair.
- Live observation: an `attention_only` path no longer produces a
  `stance_bias` decision.

**Risk**: changes recall sidecar payload shape. Document in tool
description that `manifestation_decision` field may be richer than
before.

### P3.3 — Cat-F.3: governance_class promotion ladder

**Files**:
- `packages/core/src/path-plasticity-service.ts:573-592` (extend plan
  output)
- New helper in same file for promotion thresholds

**Action**:
1. Add plan step `promote_governance_class` that, when
   `support_events_count ≥ N` and `contradiction_events_count = 0`,
   suggests `hint_only → attention_only`, then `attention_only →
   recall_allowed` (thresholds N: 3 / 8 / not-applicable).
2. `strictly_governed` remains user-set via Inspector (Cat-E).
3. Promotion emits `path.governance_promoted` audit event.

**Verify**:
- Test: 8 successful reinforcements promotes a path from
  `hint_only` to `recall_allowed`.

**Risk**: thresholds need empirical calibration. Initial values are
guesses; can be tuned post-v0.3.9 without breaking the contract.

### P3.4 — Cat-I.2: OrphanRadar into Inspector inbox

**Files**:
- `packages/soul/src/garden/auditor.ts:284-414`
- New daemon route `apps/core-daemon/src/routes/health-inbox.ts`
- `packages/storage/src/repos/orphan-radar-repo.ts` (extend reader)

**Action**:
1. Auditor `OrphanRadar` creation continues, but Inspector inbox route
   exposes a grouped view (by `target_memory_id` × `suspected_surface_gaps`)
   with counts, age, confidence.
2. Each group has typed actions (Cat-A `soul.resolve` verbs):
   `relink` / `retire` / `suppress` / `defer`.

**Verify**:
- Live DB query returns grouped OrphanRadar with action counts.
- Inspector page shows the grouped list.

### P3.5 — Cat-I.3: evidence_failure aggregation

**Files**:
- `packages/soul/src/garden/auditor.ts:117-169` (stale evidence path)
- Daemon route extends Cat-I.2 with `evidence_failure` group.

**Action**:
1. Auditor stale-evidence aggregates by `target_memory_id` and emits
   a single `health_journal evidence_failure_grouped` entry per pass
   per memory, rather than one per scan.
2. Inspector inbox surfaces the grouped entry with typed actions:
   `request_evidence` / `retire_memory` / `mark_questionable_ok`.

**Verify**:
- Live DB: per-pass `health_journal` `evidence_failure` count drops
  from 1160 to bounded-by-memory-count.

**Risk**: aggregation must not lose audit truth — keep individual scan
events at a lower-resolution event type, or drop them entirely if
aggregation is sufficient. Documented in release notes.

### P3 review-loop gate

- `do-it-review-loop` until zero Blocking + Important.
- Live snapshot: at least one PathRelation row with non-default
  `effect_vector`; at least one `health_journal` grouped entry.

---

## P4 — New surfaces (Cat-A, Cat-E)

Goal: the user-facing parts of the trust loop closure.

### P4.1 — Cat-A.1: `soul_recall` payload extension with `staged_warnings`

**Files**:
- `apps/core-daemon/src/mcp-memory-tool-handler.ts:402-456` (recall handler)
- `apps/core-daemon/src/mcp-memory-tool-catalog.ts:39-57` (tool description)
- `packages/protocol/src/recall-payload.ts` (or equivalent)

**Action**:
1. Each pointer in the recall response may carry
   `staged_warnings: StagedWarning[]`. Each warning has:
   - `kind: "stale" | "conflict" | "draft_claim" | "orphan_candidate" | "supersede_candidate"`
   - `severity: "info" | "warn" | "blocking"`
   - `policy: "ask_now" | "apply_silently" | "track_only" | "inspect_later"`
   - `summary: string`
   - `resolution_options: SoulResolveAction[]`
2. Daemon GovernancePolicy resolver (new module) computes the `policy`
   value per warning based on severity, host's recent resolve cadence,
   and global per-turn `ask_now` budget.

**Verify**:
- Test: recall with one stale memory returns a `staged_warnings`
  array with `kind=stale` and `policy=ask_now` or `apply_silently`
  depending on conditions.

**Risk**: existing recall consumers expect a flat pointer payload.
Bump tool description with a `staged_warnings` example; mark the field
optional so older agents skip it.

### P4.2 — Cat-A.2: New MCP verb `soul.resolve`

**Files**:
- `apps/core-daemon/src/mcp-memory-tool-catalog.ts` (new verb registration)
- New handler `apps/core-daemon/src/mcp-memory-resolve-handler.ts`
- `packages/core/src/resolution-service.ts` (new — typed action dispatcher)

**Action**:
1. Verb signature:

```ts
soul.resolve({
  delivery_id: string,
  warning_id: string,
  resolution: "confirm" | "reject" | "correct" | "stale" | "defer" | "not_relevant",
  payload?: { /* per-resolution */ }
})
```

2. Dispatcher routes per resolution kind:
   - `confirm` → calls promotion / activation depending on warning
     kind (e.g. draft_claim confirm → `ClaimService.transitionLifecycle`
     active).
   - `reject` → marks the warning as user-rejected; if it was a
     supersede candidate, the candidate is dropped.
   - `correct` → opens a typed Proposal carrying the correction
     payload.
   - `stale` → `EvidenceService.update` marks the capsule
     `disputed`/`refuted`; memory may be tombstoned.
   - `defer` → creates a `DeferredObligation` (Cat-H.4) so the
     warning re-surfaces at the right time.
   - `not_relevant` → suppress this exact warning shape for the
     workspace + session (decay over time, not permanent).

3. All resolutions emit `soul.resolved` audit event with the typed
   payload.

**Verify**:
- Per-resolution test in `mcp-memory-resolve-handler.test.ts`.
- Integration: end-to-end recall → staged_warning → soul.resolve →
  apply chain proven.

**Risk**: this is a new MCP verb. Adds to the 13-verb surface →
becomes 14 verbs. Document in README.md + CLI help.

### P4.3 — Cat-A.3: Fatigue controls

**Files**:
- New `packages/core/src/governance-policy.ts`
- `apps/core-daemon/src/mcp-memory-tool-handler.ts` (consults policy
  module before stamping `policy` on each warning)

**Action**:
1. Policy module exposes:

```ts
classifyWarning(input: {
  warning: StagedWarning,
  recent_resolutions: ResolveActionRecord[],
  turn_budget: { ask_now_used_this_turn: number },
  workspace_governance: WorkspaceGovernancePrefs
}): "ask_now" | "apply_silently" | "track_only" | "inspect_later"
```

2. Defaults:
   - `ask_now` budget per turn: 1 (configurable via
     `ALAYA_GOVERNANCE_ASK_NOW_PER_TURN`).
   - `apply_silently`: clear-cut stale, low-severity orphan candidates
     where user has resolved the same shape ≥ 3 times the same way
     (auto-policy learning).
   - `track_only`: low-severity info that doesn't block recall use.
   - `inspect_later`: routed to Cat-E inbox.

**Verify**:
- Test: 5 stale warnings in one recall — only 1 emerges as `ask_now`,
  others split between `apply_silently` and `inspect_later`.

### P4.4 — Cat-E.1: Inspector Health Inbox page (over `HealthIssueGroup`)

**Files**:
- New `apps/inspector/web/src/pages/HealthInbox.tsx`
- New daemon route `apps/core-daemon/src/routes/health-inbox.ts`
  (already touched in Cat-I.2)
- New `packages/protocol/src/control-plane/health-issue-group.ts`
  (control-plane projection schema)
- New `packages/storage/src/repos/health-issue-group-repo.ts`
- New `packages/storage/src/migrations/<NN>-health-issue-groups.sql`
- Inspector navigation update.

**Action**:
1. New control-plane projection `HealthIssueGroup` (per `decisions.md`
   §D1, replacing the earlier idea of reusing `SynthesisCapsule`).
   Shape:
   - `group_id`
   - `target_object_id` (memory_entry or evidence_capsule)
   - `cause_kind` (`orphan` / `green_revoked` / `evidence_failure` / ...)
   - `severity` / `confidence` / `first_seen_at` / `last_seen_at`
   - `count` (de-duped from raw stream)
   - `suggested_action` (typed verb list)
   - `resolution_state` (`pending` / `resolved` / `suppressed`)
2. Cat-I.2 / Cat-I.3 producers (OrphanRadar, evidence_failure)
   emit into the projection rather than into raw event streams.
3. Health Inbox shows three sections:
   - **Pending actions** (typed verbs from `suggested_action`)
   - **Recent resolved** (`resolution_state=resolved`, last 7 days)
   - **System silence** (low-severity items, audit-only)
4. Each row exposes the suggested typed action; clicking triggers a
   typed Proposal (or, for low-risk cases, a `soul.resolve` invocation
   that the inspector copies to the operator's clipboard per
   invariant §21a). Inspector never directly mutates durable state;
   actions travel through the audit-trail apply path.

**Verify**:
- Inspector page renders with at least 5 grouped entries from a live
  workspace.

### P4.5 — Cat-E.2: `strictly_governed` PathRelation promotion via Proposal

**Files**:
- Inspector Memory Browser extension (`apps/inspector/web/src/pages/MemoryBrowser.tsx`)
- New filter chip "strictly governed paths"
- `apps/core-daemon/src/mcp-memory-proposal-workflow.ts` — extend
  Proposal target kinds to include `path_relation` with the
  `governance_class` mutation shape
- `packages/core/src/path-plasticity-service.ts` — `transitionGovernance`
  helper invoked by the Proposal apply path

**Action**:
1. Inspector exposes "Promote to strictly_governed" as an **origination
   surface** only. The button does **not** directly call
   `PathPlasticityService.transitionGovernance` and does **not** write
   `path_relations` rows from the inspector worker.
2. Instead, the button posts a typed Proposal via the existing daemon
   review surface:
   - `target_object_kind: path_relation`
   - `proposed_changes: { governance_class: "strictly_governed" }`
   - `reviewer_identity` bound to the inspector operator
3. Operator reviews + accepts through Inspector's Proposals page.
4. Accept path applies via `PathPlasticityService.transitionGovernance`,
   which publishes `path.governance_promoted` in the same transaction
   as the row update (`publishEventLogMutation` pattern from Cat-0).

This preserves invariant §21+§21b: Inspector is the origination
surface, not the persistence surface; durable path state changes
travel through the typed-resolution / Proposal audit trail before
landing.

**Verify**:
- Test: Inspector "Promote" button creates a `path_relation` Proposal
  with the correct `proposed_changes` payload — does not mutate
  `path_relations` directly.
- Test: accepting the Proposal applies via `transitionGovernance` +
  emits `path.governance_promoted` event atomically.
- Live: a manually-promoted path appears with
  `governance_class=strictly_governed` and the audit trail shows
  Proposal creation → accept → governance promotion event in
  chronological order.

### P4 review-loop gate

- `do-it-review-loop` until zero Blocking + Important.
- New MCP verb tool tested via CLI: `alaya tools call soul.resolve`.

---

## P5 — Data correctness + docs (Cat-D, Cat-J, closeout)

### P5.1 — Cat-D.1: LoCoMo `evaluated_count` denominator

**Files**:
- `apps/bench-runner/src/locomo/runner.ts:95`
- `packages/eval/src/diff.ts:54`

**Action**: `evaluated_count` reflects `totalQa` (scored QA), not
conversation count.

**Verify**: re-run LoCoMo bench; `evaluated_count` ≈ 1986 (not 10);
Wilson CI half-width sensible at that N.

### P5.2 — Cat-D.2: Cohort metric ≤ 50% (cross-question)

**Files**: `packages/core/src/recall-service.ts` (re-check cohort guard
implementation post-v0.3.8 fix); test fixtures.

**Action**: confirm guard actually drops cross-question 34/41 (83%)
admission ratio below 50%. Adjust if still exceeded.

**Verify**: cross-question-100 bench run shows cohort attribution ≤ 50%.

### P5.3 — Cat-D.3: sample-size label correctness

**Files**: `packages/eval/src/report.ts`.

**Action**: 100/500 sample run no longer labelled `full`; correct
label cascade: `smoke` (≤ 50), `staged` (51-200), `shard_merged`
(201-499), `full` (≥ 500 or `limit = total`).

**Verify**: existing 100/500 archives re-rendered show
`label = staged` not `full`.

### P5.4 — Cat-D.4: runtime-status doc sync

**Files**: `docs/handbook/runtime-status.md`.

**Action**: per codex 01 report §Recommended priority #5, split
readiness into 4 levels:
- `schema_only` — zod schema exists, no runtime path
- `implementation_wired` — daemon wires producer + consumer, no live
  proof
- `live_event_proven` — integration test + live SQLite snapshot proves
  the path
- `agent_used` — live workspace shows the agent (codex / claude-code)
  uses the feature

Each producer/consumer path tagged separately.

**Verify**: a manual walk-through of the doc against the live DB shows
no overstatement; cohort, PathRelation, edge producers, embedding all
labelled accurately.

### P5.5 — Cat-D.5: embedding-on baseline policy

**Files**: `docs/bench-history/README.md`,
`docs/bench-history/public/<embedding-on archives>/findings.md`,
`docs/bench-history/public/latest-baseline.json` policy doc.

**Action**: per codex#1 review Blocking #3 — separate embedding-on
archives from disabled baseline cadence; `latest-baseline.json`
points only at disabled-500 full runs. Embedding-on archives live in
a new sibling pointer `latest-baseline-embedding-on.json`.

**Verify**: `latest-baseline.json` no longer points at a FAIL archive.

### P5.6 — Cat-D.6: Phase 6 bench truth-up

**Files**: `docs/v0.3/v0.3.8/reports/v0.3.8-closeout.md`, release
notes, backlog notes.

**Action**: retroactively annotate v0.3.8 closeout/release-notes
where bench claims overstated actual run scale (cross-question 50,
embedding-on 100, OOM 464). Either declare "downgraded" or schedule
the full-scale re-run in v0.3.9 P5 bench pass.

**Verify**: closeout reflects actual archive sample sizes; no claim
exceeds archive evidence.

### P5.X — Bench-as-diagnostic pass (pre/post diff)

Benchmarks are diagnostic mirrors of the three-layer repairs. They
are run **not because we need a number**, but because their results
reveal which system layer is still not working. A bad benchmark
number is a diagnosis prompt ("Category Y did not fully land"), not a
trigger for score-chasing patches. Per user directive
("不要为了测试的分数而盲目做内容") and the benchmark-as-feedback-loop
principle.

Two passes:

**Pass A — pre-v0.3.9 baseline reaffirmation** (at P0 start):
- `disabled-500 longmemeval-s` (the existing v0.3.8 archive serves
  here; do not re-run unless changed)
- `cross-question-100 longmemeval-s`
- `locomo10` (with the FIXED `evaluated_count` from Cat-D.1)
- `embedding-on-500` (only for reference; not a baseline)
- All archives committed under
  `docs/bench-history/public-pre-v0.3.9/`.

**Pass B — post-v0.3.9 diff** (at P5 close):
- Re-run the same four configurations against the v0.3.9 daemon.
- Archive under `docs/bench-history/public/` per the existing
  cadence (full sample sizes — see `latest-baseline.json` policy from
  P5.5).

**Diff lens** (`docs/v0.3/v0.3.9/reports/v0.3.9-bench-diff.md`):
For each Category, list the expected reflection signal and the
observed value. Examples:

| Category | Expected reflection | Pass A observation | Pass B observation |
|---|---|---|---|
| B | `EvidenceCapsule.evidence_kind` distribution diversifies | 100% inferred | (post) |
| B | `MemoryEntry.dimension` distribution diversifies | 99% fact | (post) |
| C | `reported_used` ratio of total deliveries | 47/169 (28%) | (post) |
| C | 5-bucket telemetry split visible per host | absent | (post) |
| C | `single_used_anchor` telemetry events emitted on 1-used reports (does NOT advance PathRelation counter; does NOT insert graph edge) | absent | (post) |
| F | Non-bootstrap PathRelation count | 0 | (post) |
| F | Paths with non-default `effect_vector` | 0 | (post) |
| F | Paths with `governance_class ∈ {recall_allowed, strictly_governed}` | 0 | (post) |
| I.1 | `green.revoked` event rate / `green_statuses` row count | 21k / 0 (silent fail) | (post) |
| I.2 | `orphan_radar` row count vs grouped Inspector inbox entries | 12k / 0 | (post) |
| I.3 | `evidence_failure` health_journal entries per Auditor pass | per-scan-per-memory | (post) |
| 0 | `path.relation_created` event count vs `path_relations` row count | mismatched (no event published) | (post) — should be 1:1 |
| 0 | `memory_graph_edge.created` event count vs row insertion | mismatched | (post) — should be 1:1 |
| D | LoCoMo R@K (real denominator) | (Pass A) | (post) |

Bench is read as **diagnostic signal**, not release gate. If a
reflection signal moves in the wrong direction, that triggers a fix
within the relevant Category, not a release block.

**Files**:
- `docs/v0.3/v0.3.9/reports/v0.3.9-bench-diff.md` (new)
- `docs/bench-history/public-pre-v0.3.9/` (new sibling cadence dir,
  archives only)
- `docs/bench-history/public/<post-v0.3.9 archives>` (existing cadence)

**Verify**: bench diff doc filled in for every row in the table.

**Risk**: LongMemEval-S R@5 may stay at ~77% post-v0.3.9 — Alaya is
not optimising for that workload, and the three-layer repairs target
the live operator loop (where the actual evidence is). Document this
in the diff doc: explain R@5 stability is not a regression; the new
signals (non-bootstrap PathRelation rows, diversified
`evidence_kind`, `staged_warnings` resolution rate, the 5-bucket
usage telemetry split) are the real success metrics. Conversely, if
a reflection signal moves in the wrong direction, treat it as a
diagnosis prompt and reopen the relevant Category — do not patch the
bench score.

### P5.7 — Cat-J: Docs truth alignment (already mostly D.4)

Encapsulates Cat-D.4 plus any prose updates needed for D2's
"two co-existing governance routes" handbook language.

**Files**: `docs/handbook/invariants.md:57-77`,
`docs/handbook/architecture.md`,
`docs/handbook/runtime-status.md`,
`README.md` (project root) governance-route section.

**Action**: prose updates per D2 decision (deterministic + Proposal
co-exist with promotion gates).

**Verify**: doc walkthrough.

### P5.8 — Release notes + closeout

**Files**:
- `docs/v0.3/v0.3.9/release-notes.md`
- `docs/v0.3/v0.3.9/reports/v0.3.9-closeout.md`
- `docs/handbook/backlog.md` (close `#BL-044`; record any new findings
  not absorbed — should be empty)

**Action**: full release notes including the three load-bearing
decisions, the 11 categories executed, and any acknowledgements where
intended behaviour deviates from naive reader expectation.

### P5 review-loop gate

- Final `do-it-review-loop` round (reviewer + codex adversarial)
  until zero Blocking + Important.
- All 11 categories' verify gates green.

---

## Rollout sequencing

```
P0 (Blocking)  ──┐
                 ├──→ P1 (Schema)  ──→ P2 (Memory loop)
                 │                          │
                 │                          v
                 │                      P3 (Behaviour) ──→ P4 (Surfaces) ──→ P5 (Docs)
                 │                                                                │
                 └──→ tag v0.3.9-blocking-p0                                       │
                                                                                  v
                                                                            tag v0.3.9
```

P0 ships as hotfix tag if user wants to merge silent-UPDATE +
EventLog-first fixes ahead of the rest of the schedule. Otherwise the
six phases ship as one v0.3.9 release after P5 closeout.

## Risk register

| Risk | Mitigation |
|---|---|
| P1 schema migrations to live DB. Operator's `alaya.db` has 4 days of dogfood data. | Backup `~/.config/alaya/alaya.db` to `alaya.db.pre-v0.3.9` before P1 deploy. Migrations are column drops + table drops (no data loss for kept rows). |
| Cat-A new `soul.resolve` verb is a 14th MCP verb, breaks "13 verbs" invariant copy. | Update invariant prose to "14 verbs" with `soul.resolve` enumerated. User-facing CLI gains corresponding cmd (no breaking rename). |
| Cat-B routing change drops some signals to `signal_only` that today produce memory rows. | Document as intentional. Daily run-rate of new memory rows is expected to drop (this is a quality lift, not a quantity regression). |
| Cat-E new `HealthIssueGroup` projection adds a new table (`health_issue_groups`) and new repo. | Schema is control-plane (not memory ontology); migration is additive only; rollback by table drop if needed. |
| Cat-F new ActivationCandidate producer adds load to recall path. | Producer is on-demand at recall time; expected O(path_expansion_seed_count) which is bounded by tier pool. Benchmark in P3. |
| P3 OrphanRadar aggregation may hide individual issues from operators who relied on the raw stream. | Inspector inbox shows individual rows on drill-down; aggregation only at the inbox-list level. |

## Out-of-scope continuation

- **v0.4 scope candidates**: SurfaceService full API (anchor mutation,
  binding rebinds), `time_concern` / `risk_concern` PathAnchorRef
  producers (only `obligation` lands in v0.3.9), Inspector
  Synthesis-aggregation view (basic shape only; rich grouping
  deferred).
- **Bench infrastructure** beyond data-correctness fixes (Cat-D)
  remains deferred until a real-use-case bench is designed (post-v0.4
  candidate).
