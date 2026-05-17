# v0.3.9 Release Notes — Trustworthy Memory Loop Closure

v0.3.9 closes the three structural breakages diagnosed by the live
SQLite portrait taken at the head of v0.3.8: producer-side ontology
collapse (every Garden compile output landed as `draft` `fact` with
`inferred` evidence), inert structure registry (`PathRelation` had a
schema and propose path but no behaviour consumers), and an open trust
loop (recall delivered warnings but the agent had no typed way to
resolve them). v0.3.9 is a structural-repair release; it does not
chase a synthetic R@K number.

## Three load-bearing decisions

These three decisions shape every other change in v0.3.9. They were
taken with user authorisation on 2026-05-16.

### D1 — Dead-abstraction action

Six abstractions were each given an explicit verdict (keep-and-wire,
retire, or build). `NodeInstance` retired (single-instance runtime
engine is the decided shape). `DeferredObligation` and the narrow
slice of `SurfaceService` (surface-identity binding per host)
wire into production. `SynthesisCapsule.promotion` is retired but
**only after** its replacement (`soul.resolve.confirm`) shipped — the
retire-then-replace order from the original triage was an execution
bug. `HealthIssueGroup` is a new projection that aggregates Auditor /
OrphanRadar / Green and `evidence_failure` entries for the Inspector
Health Inbox. `UpgradeAssessmentAxis` (5 hardcoded-null fields on
`GapRecord` / `HandoffRecord`) is held on schema with a deferred
closure condition — see the closeout for details.

### D2 — Garden's only legal claim output is `draft`

Garden's deterministic `SignalService.evaluateTriage` +
`MaterializationRouter` remains the **low-trust durable producer**,
but its only legal `ClaimForm` output is now `claim_status = draft`.
The "high-confidence + evidence_refs auto-active" fast path is gone —
syntactic presence of evidence_refs is not a verification fact about
the referenced capsule. Active promotion now requires a typed
resolution recorded in EventLog through one of two reviewer-bound
routes:

1. **Inline typed resolution** via the new `soul.resolve` MCP verb,
   atomically writing the audit event, transitioning
   `ClaimService.transitionLifecycle(draft → active)`, and binding the
   active claim to the agent's MCP session identity.
2. **Out-of-band Proposal** via `soul.propose_memory_update` plus
   `soul.review_memory_proposal` (unchanged from v0.3.8 — the explicit
   host-asserted path).

Both routes share the same audit shape, identity binding, and
governance gate. `SoulToolGovernanceAdapter` continues to gate active
runtime governance on `claim_status ∈ {active, contested, winner}`;
draft never enters runtime governance until a typed resolution
promotes it. Inspector is the **origination surface**, never the
persistence surface — any Inspector action that appears to "promote"
routes through one of these two paths (invariants §21 + §21b
unchanged; §35 codifies the two-route shape).

### D3 — EventLog-first atomicity for `PathRelation` and graph edges

`PathRelationProposalService.propose` now routes `repo.create(...)`
through `publishEventLogMutation`, emitting `path.relation_created` in
the same SQLite transaction as the row insert. The same pattern is
applied to `MemoryGraphEdgeRepo.ensureEdge` and
`GraphExploreService.addEdge`. This closes the audit-vs-state gap
flagged in `packages/protocol/src/soul/memory-graph.ts` and brings
the structure-registry write path in line with the rest of the runtime
control plane.

## Live MCP verb count: 13

The plan referred to `soul.resolve` as "the 14th verb" before the
catalog was counted. The live MCP tool surface at v0.3.9 is
**13 tools**: 10 `soul.*` (including the new `soul.resolve`) plus 3
`garden.*`. `ALAYA_MEMORY_TOOL_NAMES` in
`apps/core-daemon/src/mcp-memory-tool-catalog.ts` is the source of
truth. The verb-count mismatch is doc-side only; nothing in the
catalog or wire contract changes.

## Eleven categories — executed or deferred

| Cat | Aim | Outcome |
|---|---|---|
| **0** | `PathRelation` + graph-edge EventLog-first; `GreenStatus` silent UPDATE | Done. Tagged `v0.3.9-blocking-p0`. |
| **A** | Inline governance loop (`staged_warnings`, `GovernancePolicy`, `soul.resolve` verb, fatigue controls) | Done. |
| **B** | Producer-side ontology diversification (`object_kind` routing, draft-only Garden output, `potential_conflict` route) | Done. |
| **C** | Usage loop widening (single-used telemetry, 5-bucket utilization split) | Done. |
| **D** | Data-correctness for the bench harness (denominator fix, cohort guard, sample-size label, baseline pointer hygiene) | Done. See `./reports/v0.3.9-bench-diff.md`. |
| **E** | Inspector Health Inbox (Auditor / OrphanRadar / Green aggregation, promote-strictly-governed Proposal button) | Done. Accept-apply handler for the new Proposal kind deferred to a follow-up release. |
| **F** | Path-driven manifestation activation (`PathRelation` → `ActivationCandidate` producer, `ManifestationResolver` consumes governance ceiling, `verification_bias` / `unfinishedness_bias` landing) | Done. |
| **G** | Schema-field reclamation (per-field wire-or-retract) | Mostly done; per-field index lives in the closeout. |
| **H** | Dead-abstraction action (execute D1) | Mostly done. H.3 (`UpgradeAssessmentAxis`) intentionally deferred (see below). |
| **I** | 21k+-row sink repair (GreenStatus, OrphanRadar, evidence_failure feeding `HealthIssueGroup`) | Done. |
| **J** | Doc truth alignment + 4-level readiness rewrite | Done as part of this release. |

Backlog: `#BL-044` (recall utilization follow-through, deferred from
v0.3.8) is resolved by the new 5-bucket recall-utilization telemetry
and the Inspector Health Inbox operator drill-down. No other open
backlog at release.

## `UpgradeAssessmentAxis` deferred (closure condition recorded)

This release did not ship a computer that populates the 5
`GapRecord` / `HandoffRecord` upgrade-assessment fields
(`recurrence_runs`, `recurrence_surfaces`, `governance_impact`,
`unresolved_age_ms`, `upgrade_candidate`). Retiring the slot without a
replacement would lose the schema target for meta-cognitive gap
aggregation. The fields remain on the schema with a written closure
condition; see `./reports/v0.3.9-closeout.md` for the exact follow-on
release that owns the cutover.

## New MCP surface

### `soul.resolve` (10th `soul.*` verb)

Typed reviewer-bound resolution for a draft claim or a staged warning
delivered on a recall payload. Six resolutions:

| Resolution | What it does |
|---|---|
| `confirm` | Promotes a draft `ClaimForm` to `active` via `ClaimService.transitionLifecycle`; binds the active claim to the agent's MCP session identity. |
| `reject` | Terminates the draft (any of the 6 starting states; round-3 fix extended `applyReject` to cover `DRAFT`). |
| `correct` | Records a corrected payload and emits the typed audit event. |
| `stale` | Marks the claim subject as no longer current. |
| `defer` | Writes a `DeferredObligation` carrying the re-entry timestamp; replaces the old `cooldown_until` field on `SynthesisCapsule`. |
| `not_relevant` | Records that the staged warning was inspected but did not apply to the current task. |

The handler is in `apps/core-daemon/src/mcp-memory-resolve-handler.ts`;
the typed dispatcher is `packages/core/src/resolution-service.ts`.
Optimistic concurrency is enforced at the SQL boundary
(`updateStatusStatement` adds `AND claim_status = ?`) so a concurrent
confirm / reject race resolves to a single winner with a single audit
row. CAS state mutation is now ordered before audit append; the
narrowed remaining atomicity gap (CAS-success / audit-append-failure
crash window) is named in the closeout.

### `GovernancePolicy` (agent-side classifier)

Staged warnings on a recall payload now carry an optional
`policy_classification` (`ask_now` / `apply_silently` / `track_only` /
`inspect_later`). The agent supplies the classification; the daemon
echoes it. A per-turn `ask_now` budget keeps the agent's context
intact; overflowing warnings degrade to `inspect_later` so the
Inspector still surfaces them.

### `staged_warnings[]` on `soul.recall` results (additive)

Each recall result may now carry an optional `staged_warnings` array.
Every warning names `kind` (`low_confidence` /
`contradiction_pending` / `supersede_candidate` / `evidence_missing` /
`policy_violation`), `severity` (`info` / `warning` / `blocking`), the
producing `policy`, a one-line `summary`, and `resolution_options` an
agent may pick from. Older agents that do not understand the field
can ignore it.

### Recall utilization 5-bucket telemetry

`/workspaces/:workspaceId/recall-stats` now splits utilization across
five buckets: `no_recall`, `empty_recall`, `delivered_not_reported`,
`reported_skipped_or_na`, `reported_used`. The buckets sum to recall
deliveries plus `no_recall` events from EventLog, per workspace per
`agent_target`. A new `SOUL_SINGLE_USED_ANCHOR` telemetry event fires
on single-used reports; it never advances the PathRelation co-usage
counter.

## Schema changes

- `synthesis_capsules` drops `promotion_state`, `authority_round_count`,
  `cooldown_until` (migration `072-drop-synthesis-promotion.sql`).
  `SOUL_SYNTHESIS_PROMOTED` event registration is kept as deprecated
  for historical EventLog replay (invariant §25).
- `node_instances` table dropped (migration
  `069-drop-node-instances.sql`).
- `health_issue_groups` table added (migration
  `071-health-issue-groups.sql`) with `(target_memory_id, cause_kind)`
  uniqueness; backs the Inspector Health Inbox.
- `surface_identities` row created on first attach per
  `(workspace_id, agent_target)`.
- `PathRelation.governance_class` is now read by `ManifestationResolver`
  as the maximum manifestation ceiling (`hint_only → none`;
  `attention_only → lens_entry`; `recall_allowed → lens_entry +
  dialogue_nudge`; `strictly_governed → all three including
  stance_bias`).
- `PathRelation.stability_class` evolves
  `volatile → normal → stable` on cumulative `support_events_count`
  thresholds (3 / 8 with `contradiction_events_count = 0`); promotion
  to `pinned` only when `governance_class = strictly_governed`.
- `PathGraphSnapshot` 9-field decision: 7 fields wired into
  `SoulPathGraphSnapshotTrend` (Inspector-internal additive,
  `snapshot_trend` is `.optional()` on contract); 2 fields removed.
- 4 staged `MemoryGraphEdgeType` values (`supersedes`, `contradicts`,
  `exception_to`, `incompatible_with`) gain `karma_events` producer
  hooks via `supersede_penalty`.
- `EvidenceCapsule` `mapping_revoked` storage path landed (production
  call site from `MemoryService.update` on `evidence_refs` rewrite
  remains a follow-up wire).

## Verification

- Build green at HEAD (`f5d9a63`).
- Tests 2839 / 2839 across the worktree (baseline 2687 + 152 added
  across the three lenses and the review-loop rounds).
- The protocol package's `pnpm -r exec vitest run` still reports 16
  pre-existing failures that predate v0.3.9; they are tracked in the
  closeout carry-forward.

## Resolved backlog

- `#BL-044` — Recall utilization follow-through (deferred from v0.3.8;
  closed by the 5-bucket recall-utilization telemetry and the
  Inspector Health Inbox operator drill-down).

## Verification commands

```bash
rtk pnpm build
rtk pnpm test
rtk pnpm alaya tools list --json | jq '.tools | length'    # expect 13
rtk pnpm alaya tools call soul.recall \
  '{"query":"<your query>","scope_class":null,"dimension":null,"domain_tags":null,"max_results":5}' \
  --json
```

`./reports/v0.3.9-bench-diff.md` carries the pre/post bench numbers
per category.

Workspace packages bumped `0.3.8` → `0.3.9`.
