# Runtime Status

Single source of truth for what is wired and what is not. Update after
each release.

## Canonical 4-Level Readiness (current vocabulary)

v0.3.9 adopts a 4-level readiness model. New readiness claims after
v0.3.9 must use one of these four labels; the legacy vocabulary below
is retained for historical entries in this file but should not be
used for new rows.

| Level | Meaning | Promotion evidence required |
|---|---|---|
| `schema_only` | Zod / type / migration exists; no production code reads or writes it. | Promote to `implementation_wired` by landing the production producer **and** at least one production consumer in the daemon's startup graph. |
| `implementation_wired` | Producer and consumer code both exist in the daemon wiring; service is constructed at startup; targeted unit / integration tests prove the call path under fixture conditions. No live durable evidence has been observed outside the test harness. | Promote to `live_event_proven` when at least one of: (a) a non-test EventLog row produced by this subsystem appears under a real attached MCP session (Codex / Claude Code or another adapter), recorded in `docs/v0.3/v0.3.x/host-autonomy-fixtures/` or equivalent witness path; OR (b) a live SQLite portrait (post-fix snapshot under `.do-it/findings/v0.3.x-live-data-portrait*.md` or similar) confirms the producer is firing against a real workspace; OR (c) `bench-runner` end-to-end output exercises the surface under a non-mock run. |
| `live_event_proven` | The subsystem has been observed producing durable artefacts in a real workspace — via attached MCP session, live SQLite portrait, or `bench-runner` end-to-end — not only in test fixtures. The agent did not necessarily decide autonomously to use it; the trigger may have been the host operator, another subsystem, or the bench harness. | Promote to `agent_used` when an attached host agent (Codex or Claude Code) is observed autonomously invoking the surface during a normal conversation, with EventLog evidence chained across the recall / open / respond / report cycle. |
| `agent_used` | A real host agent autonomously chose the surface during a normal conversation; the EventLog chain is committed durable. Strongest claim on this scale. | — (terminal level) |

**Legacy vocabulary cross-walk** (used in pre-v0.3.9 rows below; the
mapping is one-to-many in places because the legacy vocabulary
overloaded promotion evidence with surface-shape claims):

| Legacy label | New 4-level mapping |
|---|---|
| `not-started` | drop the row (no readiness claim) |
| `schema-ready` | `schema_only` |
| `implementation-ready` | `implementation_wired` if the production wiring exists; otherwise `schema_only`. The legacy label does not distinguish. |
| `live-event-ready` | `live_event_proven` |
| `mcp-callable` | `live_event_proven` (the MCP SDK harness counts as a live event, but the host did not necessarily autonomously call it) |
| `agent-used` | `agent_used` |
| `host-worker-ready` | `live_event_proven` for the workload surface; `agent_used` if an external host has autonomously claimed and completed a task on the live system |
| `mcp-consumable` | `live_event_proven` (deprecated legacy alias for `mcp-callable`) |
| `cli-consumable` | `live_event_proven` for the CLI verb (the E2E run counts as live event) |
| `docs-truth-ready` | not a readiness level on the new scale; tracked separately as doc audit notes |

## Legacy Readiness Vocabulary (kept for historical rows only)

| Label | Meaning |
|---|---|
| `not-started` | no implementation work has begun |
| `schema-ready` | type / schema in place; no live consumer |
| `implementation-ready` | code exists and unit tests pass; not wired into daemon |
| `live-event-ready` | wired into daemon; producer / consumer path proven by an integration or E2E test |
| `mcp-callable` | exposed as an MCP tool / resource and proven invocable through the MCP SDK harness (deterministic SDK client calling the tool). Does NOT prove a real host agent autonomously chooses the tool during normal chat. |
| `agent-used` | a real host agent (Codex or Claude Code) has been observed autonomously calling the tool during a normal conversation, with EventLog evidence of recall/open/respond/report cycles. Stronger claim than `mcp-callable`. |
| `host-worker-ready` | the daemon exposes a workload (e.g. Garden tasks) for an external host CLI agent to claim through MCP, with atomic CAS claim semantics, and the host can submit results back through the same surface. v0.1.1 introduced this for Garden via `garden.list_pending_tasks` / `garden.claim_task` / `garden.complete_task`. |
| `mcp-consumable` | **deprecated alias for `mcp-callable`**, retained for one release. Pre-v0.1.1 docs use this term to mean what `mcp-callable` now means; new claims must use `mcp-callable` (current proof) or `agent-used` (host-autonomy proof, v0.2 deferred). |
| `cli-consumable` | exposed via CLI command and proven by at least one E2E run |
| `docs-truth-ready` | cross-doc contract wording is aligned and matches current runtime/governance behavior |

## v0.3.11 Subsystem Readiness (current truth, 4-level)

v0.3.11 is **implementation complete with the big-machine 500q KPI gate
PENDING** (see `docs/v0.3/v0.3.11/reports/v0.3.11-closeout-report.md`).
The rows below cover the subsystems v0.3.11 changed. None is promoted past
`implementation_wired`: the live witnesses for these surfaces require the R5
500q bench run on a larger host (the local 7.6 GB WSL2 box OOMs at 500q), or
an attached host driving the new Garden task. R@5 -> 90% is **not** claimed
as achieved by any row here.

| Subsystem | Level | Evidence |
|---|---|---|
| Garden compute default (`host_worker`, zero-cloud) | `implementation_wired`. `defaultRuntimeGardenComputeConfig` resolves `host_worker` when no Garden secret is configured (a secret present is read as an explicit `official_api` opt-in); the attached CLI agent is the compute. `official_api` is the explicit opt-in for bench/no-agent. `alaya doctor` prints the live mode and warns when extract work is sitting unclaimed. Live witness requires an attached host (Codex / Claude Code) claiming + completing tasks on a live system. | `apps/core-daemon/src/index.ts`; `apps/core-daemon/src/daemon-runtime-support.ts`. |
| `EDGE_CLASSIFY` host-worker Garden task (B-2 edge classification) | `implementation_wired`. B-2 pair classification is deferred out of synchronous enrichment into a claimable `EDGE_CLASSIFY` Garden task; a `completed` `garden.complete_task` for an `EDGE_CLASSIFY` task now REQUIRES a well-formed `edge_verdict` (`edge_type: "none"` is the only successful no-op result; a missing verdict can no longer record false success); only LLM-port verdicts clearing the auto-accept confidence floor mint with `trigger_source = llm_supports`. | `packages/protocol/src/soul/garden-tier.ts`; `packages/storage/src/repos/garden-task-repo.ts`; `packages/core/src/path-graph/edge-auto-producer-service.ts`; `apps/core-daemon/src/edge-classify-queue-adapter.ts`; `apps/core-daemon/src/mcp-memory-tool-handler.ts`. |
| Edge-classify eventual-consistency fallback | `implementation_wired`. Recall right after memory creation may run before host-worker classification completes; the deterministic rule heuristic is the immediate fallback so work never sits silently pending. Pending/stale `EDGE_CLASSIFY` tasks are surfaced as diagnostics; a stale-after threshold gates the warning. | `apps/core-daemon/src/mcp-memory-tool-handler.ts` (`EDGE_CLASSIFY_STALE_AFTER_MS`); `apps/core-daemon/src/edge-classify-queue-adapter.ts`. |
| Cloud edge-LLM default-OFF (K4.5 zero-cloud) | `implementation_wired`. The cloud edge-LLM is strict opt-in behind `ALAYA_EDGE_PRODUCER_LLM_ENABLED`; the provider URL no longer defaults to a cloud endpoint. A no-network K4.5 regression asserts no Alaya cloud call by default. | `apps/core-daemon/src/daemon-runtime-support.ts` (`ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV`); `apps/core-daemon/src/index.ts`. |
| Edge `llm_supports` LOCAL pair-classifier | `schema_only` for the LOCAL classifier. The `EdgeAutoProducerService` accepts an optional in-process pair-classifier port (host-worker LLM verdict path is wired), but a LOCAL (host-worker / ONNX) classifier producing `llm_supports` is not yet built; until then the local rule heuristic tags `local_*` trigger sources. Deferred — backlog `#BL-053`. | `packages/core/src/path-graph/edge-auto-producer-service.ts`. |
| Bench-side earned `co_recalled` substrate (R1) | `implementation_wired`. Bench harnesses mint same-session co-recall `recalls`-tier edges at seed time and EARN sparse co-recall paths through the production `onCoUsage` gate, so the archive contains accepted, recall-eligible positive PathRelations rather than sub-auto-accept pending proposals. Live witness is the R5 500q archive. | `apps/bench-runner/src/**`; `packages/core/src/recall/recall-service.ts`. |
| Durable recall fan-in (Route 乙, R2) | `implementation_wired`. The temporary `session_cohort_fanin` heuristic is retired; durable ACCEPTED positive `memory_entry <-> memory_entry` co-occurrence hub edges (member -> representative) carry fan-in. Direct hub effects score through `path_expansion`; `graph_expansion` only covers leftover/multi-hop reach. The structural reserve is gold-blind relevance-gated and honors suppression; the representative-selection guard nominates ONE query/evidence-relevant representative and refuses membership-only promotion. **R@5 -> 90% efficacy is UNPROVEN locally and deferred to the R5 500q gate.** | `packages/core/src/recall/recall-service.ts`; `packages/core/src/recall/graph-expansion.ts`; `packages/core/src/recall/path-relations.ts`; `packages/core/src/recall/fusion-delivery.ts`; `packages/core/src/recall/recall-service-types.ts`. |
| Production synthesis review accept -> capsule create (R3a, G1) | `implementation_wired`. The librarian/auditor synthesis review-proposal `accept` reaches a `synthesis_create` branch that creates a capsule with a deterministic no-LLM summary, atomic accept-with-events — the memory-compression ENTRY. Live witness requires an accepted synthesis proposal in a real workspace. | `apps/core-daemon/src/mcp-memory-proposal-workflow.ts`; `packages/storage/src/repos/proposal/accept-workflows.ts`; `packages/storage/src/repos/proposal/sqlite-proposal-repo.ts`. |
| Forgetting lifecycle — autonomous full lifecycle (R3b/R3c/R3d/R3e) | `implementation_wired`. The full lifecycle now runs AUTONOMOUSLY and is B1-data-loss-safe. The periodic Janitor pass enqueues `TTL_CLEANUP` + `DORMANT_DEMOTION` + `TOMBSTONE_GC` every interval (the `TOMBSTONE_GC` enqueue was the missing scheduler link — now wired), so `active -> dormant -> tombstone(+disposition) -> physical GC` runs with no external trigger. Dormancy is reversible: `active -> dormant` demotion emits a per-memory `SOUL_MEMORY_STATE_CHANGED` audited transition before the row leaves recall (recall/list/FTS exclude DORMANT rows), and `dormant -> active` revival is guarded. Lazy time/idle decay is computed at recall read (bounded, no full-table scan). The `judged_useless` arm deletes only sourceless, never-reinforced rows (evidence == 0 AND reinforcement == 0) and re-verifies that verdict at delete time, refusing fail-closed if it no longer holds. The disposition sweep is gated, skips-and-continues on benign tombstone races, re-asserts not-explicitly-protected at the autonomous tombstone authority, and consults strong-ref protection. Live witness requires a real workspace accumulating dormant/aged rows. | `packages/core/src/path-plasticity/index.ts`; `packages/core/src/path-plasticity/`; `packages/core/src/importance-gate.ts`; `packages/soul/src/garden/janitor.ts`; `apps/core-daemon/src/garden-runtime.ts`; `apps/core-daemon/src/forget-disposition-ports.ts`; `packages/storage/src/repos/memory-entry-repo.ts`; `packages/storage/src/repos/memory-entry/lifecycle-workflows.ts`. |
| Forgetting lifecycle — disposition delete-gate + B1 re-verify | `implementation_wired`. Hard delete enforces a durable disposition marker (`forget_disposition` / `forget_disposition_ref` columns on the memory entry) and re-verifies capsule membership at the delete-authority transaction (capsule TOCTOU re-verify); stale forget markers clear on a non-tombstone transition; dormant -> active revival is guarded. | `packages/storage/src/repos/memory-entry/row-mapper.ts`; `packages/core/src/memory/memory-service.ts`; `packages/core/src/memory-service/`. |
| Forgetting lifecycle — **compress arm** (delete consolidated members into a capsule) | `implementation_wired` — **ARMED.** A dormant memory earns the `compressed` (deletable) disposition ONLY when a LIVE synthesis capsule lists it as a FULLY-CONSOLIDATED member (its `evidence_refs` are a subset of the capsule's `evidence_refs`); synthesis accept now populates `source_memory_refs` so that capsule -> member relationship exists. Explicit-keep protection (pinned / hazard / canon / consolidated) is evaluated BEFORE the compress arm, so a protected member is never compress-deleted. The compressed-member physical delete and its delete audit commit in ONE transaction with an atomic capsule liveness + membership re-verify (race-free). **HONEST caveat:** the capsule preserves the cluster's SHARED EVIDENCE (which survives independently as `evidence_capsules`) plus a deterministic gist summary — it does NOT byte-preserve the member's distilled `content`. This is acceptable lossy consolidation; only fully-consolidated members are eligible. Live witness requires a real workspace with an accepted synthesis capsule and a fully-consolidated dormant member. Backlog `#BL-049` is closed by this activation. | `packages/core/src/path-plasticity/index.ts`; `packages/core/src/path-plasticity/`; `packages/core/src/importance-gate.ts`; `apps/core-daemon/src/forget-disposition-ports.ts`; `apps/core-daemon/src/mcp-memory-proposal-workflow.ts`; `packages/core/src/memory/memory-service.ts`; `packages/core/src/memory-service/`. |
| Edge-proposal / `EDGE_CLASSIFY` expiry (B5) | `implementation_wired`. `expires_at` defaults to `created_at + TTL` (30 days) when no caller value is given, and `sweepExpired` flips pending proposals past their non-null `expires_at` to `expired` with an audit reason — so the `expired` status + `expires_at` column are a live feature, not dead schema. | `packages/core/src/path-graph/edge-proposal-service.ts`. |
| Path-relation failure -> `health_inbox` surfacing (D-EDGEAUDIT) | `implementation_wired`. Path-relation / edge-proposal failures surface as a `path_relation_failure` health cause grouped into the Health Inbox projection (K4 needs auditable topology). The Inspector web UI does not yet carry a dedicated label/filter for the new cause — deferred, backlog `#BL-055`. | `packages/core/src/path-graph/path-failure-health-inbox.ts`; `packages/protocol/src/soul/health-issue-group.ts`; `apps/core-daemon/src/index.ts`. |
| Ingest reconciliation routing (D-F1) | `implementation_wired` — **DEFAULT-ON.** Ingest-time dedup runs out of the box on a rule-only, zero-cloud decision basis: a byte-equal duplicate resolves to an identity-key NOOP, and the ambiguous "refines vs distinct" band resolves to ADD (never a rule-based UPDATE/NOOP — that would erase answers). The cloud garden-LLM is the OPTIONAL ambiguous-band upgrade (UPDATE/NOOP) and stays default-OFF, preserving R0 zero-cloud. Operators turn the whole feature off with `ALAYA_INGEST_RECONCILIATION_ENABLED=0` / `=false`. It covers the `materializeMemoryEntryOnly` path; `materialize_and_claim` is intentionally not reconciled, and the DELETE / supersede path stays owned by `ConflictDetectionService`. Backlog `#BL-050` is closed by this default flip. | `apps/core-daemon/src/index.ts`; `apps/core-daemon/src/reconciliation-llm-decision.ts`; `packages/core/src/governance/reconciliation-service.ts`. |
| Auto-extractor `contradicts_refs` ref-hints (B7) | `implementation_wired`. The auto-extractor emits a bounded `contradicts_refs` ref-hint producer (previously only the MCP / test paths populated these hints). | `packages/core/src/path-graph/edge-auto-producer-service.ts` and the extractor path. |
| Seed-materialization per-signal failure isolation (D-SEED) | `implementation_wired`. Batch loss (`candidate_absent` + 1963 dropped) is fixed by per-signal failure isolation + a persisted drop reason, so one bad signal no longer voids the batch. | `apps/bench-runner/src/**` (seed materialization path). |

## v0.3.9 Subsystem Readiness (current truth, 4-level)

The table below uses only the new 4-level vocabulary and audits every
subsystem touched in v0.3.0 — v0.3.9, not the pre-port history. For
historical context on subsystems first introduced before v0.3.0, see
the legacy table further down.

| Subsystem | Level | Evidence |
|---|---|---|
| MCP tool surface — legacy 12 tools (9 pre-`soul.resolve` `soul.*` + 3 `garden.*`) | `live_event_proven` for the legacy catalog. `agent_used` for `soul.recall` + `soul.report_context_usage` only (the v0.3.0 host-autonomy witness). The live catalog remains 13 tools after `soul.resolve`. | `apps/core-daemon/src/mcp-memory-tool-catalog.ts:3-17`. `agent_used` evidence: `docs/v0.3/v0.3.0/host-autonomy-fixtures/`. |
| `soul.resolve` verb (new in v0.3.9) | `implementation_wired`. Production handler is mounted; end-to-end tests cover all 6 resolutions; optimistic concurrency guard live. No real host has been observed autonomously calling it yet. | Handler: `apps/core-daemon/src/mcp-memory-resolve-handler.ts`. Dispatcher: `packages/core/src/governance/resolution-service.ts`. E2E: `apps/core-daemon/src/__tests__/soul-resolve-e2e.test.ts`. |
| `staged_warnings[]` on recall payload (additive) | `implementation_wired`. Recall handler attaches warnings when policies fire; protocol schema field is optional and now carries typed `target_object_id` so `soul.resolve` scope checks do not infer the target from array position. Production producers exist; an attached host has not yet been observed reacting to a warning autonomously. | `apps/core-daemon/src/mcp-memory-tool-handler.ts`; `packages/protocol/src/soul/staged-warning.ts`; descriptor: catalog `soul.recall` description. |
| `active_constraints[]` recall root channel | `implementation_wired`. Governance-backed hard constraints / hazards / active governance facts are returned outside `results[]`, deduped from ordinary recall results, and capped by workspace config. Draft claims and dimension-only agent outputs do not enter this hard channel. This is an additive root field; `results[]` remains the existing recall result list. | `packages/protocol/src/soul/mcp-types.ts`; `packages/storage/src/repos/active-constraints.ts`; `packages/core/src/recall/recall-service.ts`; `apps/core-daemon/src/mcp-memory-recall-result.ts`; tests: `active-constraints.test.ts`, `harness.test.ts`, `recall-service-tier-cascade.test.ts`, `mcp-memory-tool-handler.test.ts`. |
| `soul.report_context_usage.trust_mode` | `implementation_wired`. Usage proof accepts optional `trust_mode` (`manual` / `automatic`), persists it in EventLog / storage, and PathPlasticityService halves automatic used-report reinforcement while keeping integer support-event counts. | `packages/protocol/src/soul/mcp-types.ts`; `packages/storage/src/migrations/076-trust-usage-trust-mode.sql`; `apps/core-daemon/src/trust-state.ts`; `packages/core/src/path-plasticity/index.ts`; `packages/core/src/path-plasticity/`; tests: `trust-state.test.ts`, `trust-state-repo.test.ts`, `path-plasticity-service.test.ts`. |
| Garden's `MaterializationRouter` (draft-only claim output, `object_kind` routing, `potential_conflict` route) | `live_event_proven`. The bench harness drives `MaterializationRouter` on every seeded turn via the rotated `object_kind` set (see `apps/bench-runner/src/harness/seed-rotation.ts`); the post-fix archives at `docs/bench-history/public-locomo/2026-05-17T064415Z-75d418c/` (LoCoMo 10-conv full, sample_size=1982), `docs/bench-history/public/2026-05-17T065105Z-75d418c/` (LongMemEval-S 100 disabled, label=staged), and `docs/bench-history/public/2026-05-17T104037Z-294070f/` (LongMemEval-S 100 embedding-on, label=staged) durably persist both the `memory_entry` and the `claim_form (draft)` rows produced by the router on real workspace state. | `packages/soul/src/garden/materialization-router/router.ts`. |
| Producer-side ontology diversification (`pickEvidenceKind`, `toFormationKind`, `derivePrecedenceBasis`) | `live_event_proven`. The bench seed rotation (`fact / preference / decision / constraint / outcome` × N turns × M questions) flows through `routeByObjectKind` — 3/5 of seeds land in `memory_and_claim_draft` and run `derivePrecedenceBasis`, 2/5 land in `memory_entry_only`. Witnessed by the three archives above: every seeded turn writes a `memory_entry` row with the diversified `dimension` field per the rotation, and the claim-capable rows write `claim_form` rows with the derived `precedence_basis`. The same rotation runs across both the embedding-off and embedding-on configurations. | `packages/soul/src/garden/materialization-router/inputs.ts`; `packages/core/src/governance/claim-service.ts`. Tests: `materialization-router-routing.test.ts`, `seed-rotation.test.ts`. |
| `ClaimService.transitionLifecycle` + optimistic concurrency on claim status | `implementation_wired`. Inline `soul.resolve` promotion runs through the storage-CAS lifecycle path; production wiring uses the EventPublisher append-and-mutate transaction so the lifecycle audit row and status change close together. Live witness requires an attached host calling `soul.resolve.confirm` against a draft claim, which is the `soul.resolve` host-autonomy gate. | `packages/core/src/governance/claim-service.ts`; `packages/storage/src/repos/claim-form-repo.ts`; tests: `claim-service.test.ts`, `claim-form-repo.test.ts`. |
| `PathRelation` → `ActivationCandidate` producer | `implementation_wired`. Producer wired in the daemon; `verification_bias` consumed by `AuditorSchedulingAdvisor`; `pending_incomplete` and `unfinishedness_bias` are carried into the public recall sidecar. The 2-conv LoCoMo smoke does not yet reach K=3 co-usage to materialise paths; a longer bench or live workspace portrait is the gate. | `packages/core/src/path-graph/path-activation-candidate-producer.ts`; `packages/core/src/manifestation-resolver.ts`; `apps/core-daemon/src/mcp-memory-recall-result.ts`. |
| `SoulPathGraphSnapshotTrend` | `implementation_wired`. `snapshot_trend` is optional on the graph contract, but when present its nested snapshot keys are required by protocol. Runtime omits the trend only when history is unavailable or unreadable; it does not emit partial trend objects. | `packages/protocol/src/soul/graph.ts`; `packages/core/src/path-graph/graph-contract-service.ts`; tests: `soul-graph.test.ts`, `graph-contract-service.test.ts`. |
| `PathRelation.governance_class` → manifestation policy | `implementation_wired`. `ManifestationResolver` reads `governance_class` as the manifestation ceiling per the four-class table; promotion requires a workspace with paths past the strictly_governed threshold. | `packages/core/src/path-graph/path-manifestation-policy.ts`; `packages/core/src/manifestation-resolver.ts`. |
| `PathRelation.stability_class` evolver | `implementation_wired`. Promotion ladder requires cumulative `support_events_count` and `contradiction_events_count = 0`; repeated used reports decay for strength, automatic trust-mode used reports are half-weighted, and support counts remain integer event counts. Tests cover the matrix. Live witness requires a workspace with K=3+ co-usage which the 2-conv bench cannot generate. | `packages/core/src/path-plasticity/index.ts`; `packages/core/src/path-plasticity/`; `apps/core-daemon/src/path-plasticity-runtime.ts`. |
| `AuditorSchedulingAdvisor` | `implementation_wired`. Production Garden runtime wraps the Auditor evidence-staleness port with advisor ordering from active PathRelation `verification_bias`, so biased paths are rechecked first. | `packages/core/src/governance/auditor-scheduling-advisor.ts`; `apps/core-daemon/src/garden-runtime.ts`; tests: `garden-runtime.test.ts`, `path-activation-candidate-producer.test.ts`. |
| `ManifestationBudgetConfigProviderPort` | `implementation_wired`. Daemon startup injects a persistent config-service provider backed by the generic `app_config` table; absent workspace config still falls back to resolver defaults. Inspector config can read and patch the workspace budget through the daemon route. Migration version `075` is an intentional gap because no dedicated manifestation-budget table is used. | `packages/storage/src/migrations/023-config.sql`; `packages/storage/src/repos/config-repo.ts`; `apps/core-daemon/src/services/config-service.ts`; `apps/core-daemon/src/index.ts`; `apps/core-daemon/src/routes/config.ts`; `apps/inspector/web/src/components/ManifestationBudgetForm.tsx`; tests: `routes-config-port.test.ts`, `Config.test.tsx`. |
| `karma_events` (`reuse_gain` / `evidence_gain` / `supersede_penalty` producers) | `implementation_wired`. Each producer is wired into its trigger site (recall hit / evidence health change / contradiction edge create); unit + integration tests prove each scenario. Live witness requires a workspace where the trigger sites actually fire (recall-twice / questionable→verified evidence flip / contradicts edge). | `packages/core/src/dynamics-service.ts`. |
| `HealthIssueGroup` projection + Inspector Health Inbox | `implementation_wired`. Migration `071-health-issue-groups.sql` defines the table; Auditor / OrphanRadar / Green producers upsert by `(target_memory_id, cause_kind)` with calibrated severity and operator-visible summaries; Inspector `/health-inbox` renders the grouped view; tests cover the route. Live witness requires an Auditor pass against a workspace that has orphans or failed evidence. | `apps/inspector/web/src/pages/HealthInbox.tsx`; `packages/soul/src/garden/auditor.ts`; tests: `auditor-health-issue-group.test.ts`, `routes-health-inbox.test.ts`. |
| Promote-to-`strictly_governed` Inspector Proposal | `implementation_wired`. Inspector posts a typed `path_relation` Proposal and the accept-apply workflow creates or updates the corresponding `path_relations` row. | `apps/inspector/web/src/pages/MemoryBrowser.tsx`; `apps/core-daemon/src/routes/proposals.ts`; `apps/core-daemon/src/mcp-memory-proposal-workflow.ts`; `packages/storage/src/repos/proposal/accept-workflows.ts`; `packages/storage/src/repos/proposal/path-relations.ts`; migration `073`. |
| `surface_identities` per `(workspace_id, agent_target)` | `implementation_wired`. First attach per host writes the row via `SurfaceService.createSurface` (idempotent on CONFLICT); registrar covered by tests. Live witness requires a real attach from Codex / Claude Code that populates the table. | `apps/core-daemon/src/attach-surface-registrar.ts`. |
| Recall utilization 5-bucket telemetry | `implementation_wired`. Route returns per-workspace per-`agent_target` 5-bucket counts derived from EventLog. Live witness requires a workspace that has accumulated recall deliveries + usage reports through the route. | `apps/core-daemon/src/routes/recall-utilization.ts`; `packages/eval/src/metrics/utilization-buckets.ts`. |
| `SOUL_SINGLE_USED_ANCHOR` telemetry | `implementation_wired`. Emits when pointer_count===1 reports land; helper looks up the delivered_object_id; does **not** advance PathRelation co-usage counter. The 2-conv LoCoMo smoke does not yet emit a real single-used-anchor row. | `apps/core-daemon/src/routes/recall-utilization.ts`; `apps/core-daemon/src/index.ts`. |
| `GreenStatus` silent-UPDATE repair (v0.3.9 Cat-0) | `implementation_wired`. Revoke guard + workspace predicate + `green_revoke_noop` EventLog row are in the production code path; tests prove no silent overwrite. Live witness requires a workspace where the prior anti-pattern (21 446 silent revoke events) is no longer reproduced — captured when the next v0.3.9 portrait runs against a populated workspace. | `packages/storage/src/repos/garden-data-ports.ts`. |
| `PathRelation` EventLog-first atomicity (v0.3.9 Cat-0) | `implementation_wired`. `PathRelationProposalService.propose`, `MemoryGraphEdgeRepo.ensureEdge`, and `GraphExploreService.addEdge` all route through `publishEventLogMutation`; tests cover the rollback path. Live witness requires a workspace where the producer fires against real consolidation activity. | `packages/core/src/path-graph/path-relation-proposal-service.ts`. |
| `SynthesisCapsule.promotion` | **Retired in v0.3.9.** Schema columns dropped via migration `072`; `SOUL_SYNTHESIS_PROMOTED` event registration kept as deprecated per invariant §25 (no producer). | Migration `072-drop-synthesis-promotion.sql`. |
| `NodeInstance` | **Retired in v0.3.9.** Single-instance runtime engine; no consumer needed. Schema dropped via migration `069`. | Migration `069-drop-node-instances.sql`. |
| `DeferredObligation` | `implementation_wired`. Service instantiated in the daemon; `soul.resolve.defer` is the only producer; tests cover the obligation create path. Live witness chains on `soul.resolve` host-autonomy. | `packages/core/src/governance/deferred-obligation-service.ts`. |
| `UpgradeAssessmentAxis` (5 fields on `GapRecord` / `HandoffRecord`) | `schema_only` — deferred decision. Producer and consumer pending; see `docs/v0.3/v0.3.9/closeout-deferred-conditions.md` for the closure condition. | Carry-forward item. |
| Bench harness data correctness (LoCoMo denominator, cohort guard, sample-size label, baseline pointer hygiene, shared version helper, producer-chain seed rotation) | `live_event_proven`. The denominator fix is observable in `public-locomo/2026-05-17T064415Z-75d418c/kpi.json` (`sample_size = 1982`, `evaluated_count = 1982`, `label = full`). The label cascade renders `staged` on `public/2026-05-17T065105Z-75d418c` (100 evaluated, disabled) and on `public/2026-05-17T104037Z-294070f` (100 evaluated, embedding-on). Shared version helper writes `alaya_version: 0.3.9` to all three archives. The embedding-on baseline pointer hygiene fix is observable in `public/latest-baseline-embedding-on.json` (no longer `{ "slug": null }`). Seed rotation persists mixed-dimension memories across all three archives. See `docs/v0.3/v0.3.9/reports/v0.3.9-bench-diff.md` for the full diff. | `apps/bench-runner/src/locomo/runner.ts`; `apps/bench-runner/src/version.ts`; `apps/bench-runner/src/harness/seed-rotation.ts`; `packages/eval/src/metrics/wilson-ci.ts`; `packages/eval/src/metrics/cohort-attribution.ts`. |

**Deliberately not promoted past `implementation_wired` for most
v0.3.9-new subsystems.** The release shipped production code +
tests + the bench-runner smoke that exercises the
`MaterializationRouter` producer chain, but most subsystems require
a live workspace witness that the 2-conversation LoCoMo smoke does
not yet produce (paths past K=3 co-usage; karma trigger sites
firing; Auditor passes against a workspace with orphans). Each row
above documents the specific witness needed. Promotion to
`live_event_proven` for these rows happens when one of: (a) a longer
bench run (LongMemEval-S 500 staged + cross-question-100) emits the
durable artefacts the subsystem produces; (b) a live SQLite portrait
under `.do-it/findings/v0.3.9-*-live-data-portrait.md` is captured
against a populated workspace; (c) an attached host (Codex / Claude
Code) drives the surface during a real session. Promotion to
`agent_used` requires (c) with the attached host AUTONOMOUSLY
choosing the surface during a normal conversation, parallel to the
v0.3.0 witness for `soul.recall`.
Both witnesses are tracked as v0.3.x follow-on work.

## Legacy Subsystem Readiness Table (pre-v0.3.9, kept for historical record)

The table below uses the legacy vocabulary. New rows should not be
added here; use the v0.3.9 4-level table above. Status columns
reflect the state at the time of the row's last update.

## v0.1 Phase Status

| Phase | Scope | Status | Gate |
|---|---|---|---|
| Phase 0 | Reset, port-source snapshot, handbook, INDEX, task cards | **done** | Gate-0 passed |
| Phase 1 | Wave 1 leaves: protocol, migrations, storage shared, config, topology, engine-gateway | **done** | Gate-1 passed |
| Phase 2 | Wave 2: storage repos batches + core services + Garden + security defense | **done** | Gate-2 passed |
| Phase 3 | Wave 3: foundation helpers, ConversationService, MCP discovery, run lifecycle, misc services, core barrel | **done** | Gate-3 passed |
| Phase 4 | Wave 4: Core daemon, routes, MCP server transport, real profile mutation, CLI bridge, secrets, Inspector server, Inspector frontend | MCP memory surface `mcp-callable`; Inspector config-write and trust delivery/usage durability fixes verified | Gate-4 passed 2026-05-01 |
| Phase 5 | Wave 5: full E2E, graph contract, final review | **done**: graph contract `schema-ready`; release E2E `live-event-ready`; final review `mcp-callable` | Gate-5 passed 2026-05-02 |
| Gate-5F | Post-Gate-5 backlog closeout | **done**: `#BL-025`..`#BL-036` resolved; aggregate final review clean; full verification passed | Gate-5F passed |
| Phase 6 | Wave 6: MCP agent-use protocol (9 `soul.*` tools), Garden auto-start on attach, cwd workspace, proposal accept→apply persistence | **done**: 9 MCP tools `mcp-callable`; Trustworthy Memory Loop `live-event-ready` | Gate-6 passed 2026-05-02; delta补审 closed at commit `abd464d` |
| Phase 6.1 (v0.1.1) | Memory plane coherence wave: Inspector graph centring, Garden compute config split, recall tier widening, recall hit promotion, host-as-Garden-compute via SQLite-backed task queue + 3 `garden.*` MCP tools, profile drift detection, embedding error surfacing | **done**: Garden compute `host-worker-ready` via H1+H2+H3; recall cascade `live-event-ready`; 11 atomic slices, see commits `f4a522e..1f6fe35` | wave-end review pending |
| v0.2.0 | pi-mono Garden provider path, recall scoring refinements, Trustworthy Loop trace anchoring, and invariant §25 SemVer contract | **candidate**: deterministic pi-mono resolver/extractor tests pass, recall refinements `live-event-ready`, Trustworthy Loop trace `live-event-ready`, SemVer snapshot `docs-truth-ready`; provider-transport live smoke is recorded, but the full daemon `POST_TURN_EXTRACT` + EventLog AC7 live smoke is not yet proven | `docs/archive/v0.2/v0.2.0/`; release acceptance pending full Slice 3 AC7 live daemon smoke |

## Subsystem Readiness (target = v0.1 release)

| Subsystem | Current | Target | Owning phase |
|---|---|---|---|
| Memory ontology types | `schema-ready` | `schema-ready` | P1-protocol |
| Storage skeleton + DB helpers | `schema-ready` | `schema-ready` | P1-storage-skeleton |
| Storage shared utilities | `implementation-ready` | `implementation-ready` | P1-storage-shared |
| SQLite migrations | `implementation-ready` | `implementation-ready` | P1-migrations |
| Storage repos | `implementation-ready` | `implementation-ready` | P2-repos-batch-* + P2-barrel-storage |
| Core package skeleton + shared utilities | `schema-ready` | `schema-ready` | P1-core-skeleton |
| Dynamics runtime constants | `schema-ready` | `schema-ready` | P1-config |
| MemoryService | `implementation-ready` | `live-event-ready` | P2-svc-memory |
| EvidenceService | `implementation-ready` | `live-event-ready` | P2-svc-evidence |
| SignalService | `implementation-ready`; v0.3.2 defers invalid schema-grounded candidate signals before post-triage materialization can run | `live-event-ready` | P2-svc-signal + v0.3.2 |
| GlobalMemoryRecallService | `implementation-ready` | `live-event-ready` | P2-svc-global-recall |
| TaskSurfaceBuilder | `implementation-ready` | `implementation-ready` | P2-svc-task-surface-builder-prelude |
| RecallService | `live-event-ready`; v0.2.0 adds budget `pressure_ratio` scoring, per-call `host_context.tokenizer_hint` estimation, and deterministic `domain_weight_overrides` audit factors | `live-event-ready` | P2-svc-recall + v0.2.0-slice-5..7 |
| EmbeddingRecallService | `implementation-ready`; public barrel remains `packages/core/src/embedding-recall-service.ts`, implementation lives under `packages/core/src/embedding-recall/` | `live-event-ready` | P2-svc-embedding-recall |
| EmbeddingBackfillHandler | `implementation-ready` | `live-event-ready` | P2-svc-embedding-pipeline |
| ManifestationResolver | `implementation-ready` | `live-event-ready` | P2-svc-manifestation |
| SynthesisService | `implementation-ready` | `live-event-ready` | P2-svc-synthesis |
| ProposalService | `implementation-ready` | `live-event-ready` | P2-svc-proposal |
| GreenService (ELIGIBLE/GRACE/REVOKED) | `implementation-ready` | `live-event-ready` | P2-svc-green |
| GovernanceLeaseService | `implementation-ready` | `live-event-ready` | P2-svc-governance-lease |
| SessionOverrideService | `implementation-ready` | `live-event-ready` | P2-svc-session-override |
| Garden Auditor | `implementation-ready` | `live-event-ready` | P2-garden-batch-1 |
| Garden Janitor | `implementation-ready` | `live-event-ready` | P2-garden-batch-2 |
| Garden Librarian | `implementation-ready` | `live-event-ready` | P2-garden-batch-2 |
| GardenScheduler | `implementation-ready` | `live-event-ready` | P2-garden-batch-1 |
| Garden compute providers / pi-mono + local heuristics | `implementation-ready`; `OfficialApiGardenProvider` routes extraction through `packages/soul/src/garden/pi-mono-extractor.ts`, with lazy daemon credential/config resolution through `GardenComputeProviderResolver`; deterministic daemon/config tests pass and provider-transport live smoke is recorded, but full daemon `POST_TURN_EXTRACT` + EventLog live AC7 remains pending. v0.3.2 normalizes provider, local-heuristic, daemon, and host-worker candidate signals with internal schema-grounded raw-payload validation. | `live-event-ready` | P2-garden-batch-1 + v0.2.0-slice-2..4 + v0.3.2 |
| Garden materialization / degradation / handoff gap | `implementation-ready`; accepted signals are fenced through persisted `compiled` state before materialization side effects, and replay of `triaged` / `compiled` signals does not rerun materializers, preventing duplicate evidence / memory / claim objects after retry or crash windows. v0.3.2 rechecks schema-grounded field/value payloads in `MaterializationRouter` and routes invalid payloads to `deferred`, creating no memory or claim objects. | `live-event-ready` | P2-garden-batch-3 + v0.3.2 |
| Garden bootstrapping / remediation / backlog telemetry | `implementation-ready` | `live-event-ready` | P2-garden-batch-4 |
| Soul package skeleton + governance leaves | `schema-ready` | `schema-ready` | P1-soul-skeleton |
| Soul topology leaves | `implementation-ready` | `implementation-ready` | P1-topology |
| Permission policy stack | `implementation-ready` | `implementation-ready` | P2-security-1 |
| Worker safety / trust | `implementation-ready` | `implementation-ready` | P2-security-2 |
| ConversationService | `implementation-ready` | `implementation-ready` in P3; `live-event-ready` after Phase 4 daemon/MCP proof | P3-conversation + P4-mcp-memory-tools |
| Engine gateway MCP tool specs + binding helpers | `implementation-ready`; dead provider-placeholder types were deleted in v0.2.0, while `provider/soul-tool-specs.ts` remains the stable MCP tool-name/description seed under invariant §25 | `implementation-ready` | P1-engine-gateway-mcp + v0.2.0-slice-1 |
| First-party MCP memory tool contract | `implementation-ready` | `implementation-ready` | P4-mcp-memory-tools |
| MCP discovery services | `implementation-ready` | `implementation-ready` | P3-mcp-discovery |
| MCP tool surface | `mcp-callable` via single-daemon attached-agent MCP harness | `mcp-callable`; `agent-used` deferred to v0.2.2 / #BL-038 (real Codex/Claude conversation autonomy proof) | P3-mcp-discovery + P4-mcp-tooling + P4-mcp-memory-tools + P4-mcp-server + Gate-4 proof harness |
| Core daemon | `implementation-ready` | `live-event-ready` | P4-daemon-skeleton + P4-daemon-startup-ordering + P4-sse-strip |
| Profile mutation (Codex/Claude attach) | MCP profile entries are `cli-consumable`; Alaya-managed slash profile entries are written but host recognition is tracked separately | `cli-consumable` for MCP attach | P4-profile-mutation |
| Slash boot trigger (`/alaya-inspect`) | `implementation-ready`; attach writes the managed trigger, but Codex host recognition for custom slash commands is not proven | host-proven `cli-consumable` | P4-profile-mutation + #BL-037 |
| CLI commands (install / attach / status / doctor / tools list / tools call) | `cli-consumable` (proven by release E2E) | `cli-consumable` | P4-cli-bridge + P4-mcp-memory-tools + P4-cli-install + P4-cli-attach + P4-cli-status + P4-cli-doctor + P5-e2e |
| CLI commands (inspect / detach / backup / export / import / mcp stdio) | `implementation-ready` (covered by targeted command tests only) | `cli-consumable` | P4-cli-inspect + P4-cli-detach + P4-operations + P4-mcp-server |
| Trust state delivery / usage | `live-event-ready`; SQL-backed delivery and usage records survive daemon restart | `live-event-ready` | P4-trust-state + #BL-015 repair |
| Secret refs (env / local-file / paste-to-file) | `live-event-ready`; Inspector writes proxy daemon runtime config and are audited through EventLog | `live-event-ready` | P4-secrets + #BL-019 repair |
| Operations (backup / export) | `cli-consumable` (proven by release E2E) | `cli-consumable` | P4-operations + P5-e2e |
| Operations (import) | `implementation-ready` (covered by targeted operations tests only) | `cli-consumable` | P4-operations |
| Memory Inspector | `live-event-ready`; server/frontend exist, token-gated routes pass, and Provider/Config writes proxy daemon runtime config | `live-event-ready` for the inspector surface | P4-inspector-server + P4-cli-inspect + P4-inspector-frontend + #BL-019 repair |
| Current-directory workspace startup | `cli-consumable`; absent `--workspace` or `ALAYA_WORKSPACE_ID`, attached MCP stdio and CLI fallback calls derive and register a stable local workspace from process cwd before invoking memory tools or Garden startup | `cli-consumable` | P6-cwd-workspace-startup |
| Garden startup / cleanup loop | `live-event-ready`; HTTP daemon and attached MCP stdio start Garden services, trigger one startup background pass, then leave Janitor/Auditor/Librarian/Scheduler on intervals until shutdown drains them | `live-event-ready` | P2-garden-batch-* + P4-mcp-server + P6-garden-startup-cleanup-loop |
| MCP Agent-Use Protocol | `agent-used` for `soul.recall` + `soul.report_context_usage`: real Claude Code MCP stdio sessions have been observed autonomously calling `soul.recall` and then `soul.report_context_usage` with `usage_state == "used"` during normal conversations; #BL-038 closed in v0.3.0 with a live-usage EventLog witness (`docs/v0.3/v0.3.0/host-autonomy-fixtures/claude-code-live/`) + an offline regression (`host-autonomy-witness.test.ts`). SDK-driven proof still covers the full tool surface (discovery, ordered calls, CLI fallback, pointer open, proposal review, durable update, post-apply recall). Durable *capture* does not depend on host autonomy — the daemon auto-extracts server-side from the recall turn text (see POST_TURN_EXTRACT routing). By design, autonomous use of `soul.emit_candidate_signal` / `soul.propose_memory_update` is narrower: daemon-side POST_TURN_EXTRACT (`apps/core-daemon/src/mcp-memory-tool-handler.ts:1019-1069`) auto-captures from `recent_turn` / `turn_digest`, so the explicit emit / propose MCP channels are reserved for high-confidence host-asserted writes, not required for routine memory capture. | `agent-used` for recall + usage-report; explicit `emit_candidate_signal` / `propose_memory_update` channels remain available for host-driven assertions but routine capture is covered server-side | P6-agent-use-protocol + P6-live-agent-proof + v0.3.0-slice-4 (#BL-038) |
| Garden compute provider config | `live-event-ready` for deterministic config routing; provider_kind / model_id / provider_url / secret_ref split from embedding config; doctor surfaces credential_source (env / file / embedding-fallback / none) and routing_decision; v0.2.0 hot-applies runtime config patches by refreshing compute routing candidates and lazily rebuilding pi-mono-backed official providers after config/secret changes | `live-event-ready` | P6.1-C1 + P6.1-C2 + v0.2.0-slice-4 |
| Garden host-worker surface | `host-worker-ready`; SQLite-backed task queue with atomic claimAtomic CAS (`packages/storage/src/repos/garden-task-repo.ts`); three MCP tools (`garden.list_pending_tasks`, `garden.claim_task`, `garden.complete_task`) let host CLI agents claim and complete Garden tasks; result candidate_signals flow into the same review queue as `soul.emit_candidate_signal`; `garden.complete_task` persists a completion envelope before candidate-signal persistence so partial-failure retries must use the same signal set and cannot under-report already-persisted side effects. `provider_kind=host_worker` is the v0.3.11 PRODUCT DEFAULT (`defaultRuntimeGardenComputeConfig` resolves host_worker when no Garden secret is configured; a secret present is read as an explicit `official_api` opt-in). `ALAYA_GARDEN_PROVIDER_KIND` in the config `.env` or `garden_provider_kind` in `alaya install --non-interactive` set the env-derived mode explicitly; the Inspector Garden Compute form writes the authoritative `runtime:garden-compute` SQLite row (which, once present, overrides the env default). Under the host_worker default, extract work left unclaimed past a bounded window falls back to the zero-cloud `local_heuristics` extractor in-process so capture never stalls; `alaya doctor` prints the live mode and warns when extract work is sitting unclaimed (attach a CLI agent for LLM-quality extraction) | `host-worker-ready` | P6.1-H1 + P6.1-H2 + P6.1-H3 + v0.2.x completion-envelope / migration 067 + v0.3.0 host-worker config entry + v0.3.11 host_worker default |
| POST_TURN_EXTRACT routing | `live-event-ready`; v0.2.x makes capture self-bootstrapping — attached MCP stdio sessions without `ALAYA_RUN_ID` first create a canonical session run whose `run_id` equals the process-stable MCP `session_id`; `soul.recall` then enqueues a `POST_TURN_EXTRACT` task from `recent_turn` (or `query`), deduped on `(workspace_id, run_id, turn-text hash)`, and `report_context_usage` enqueues one whenever a `turn_digest` is present (no longer gated on a used object), deduped on `(linked_delivery.workspace_id, linked_delivery.run_id, turn_index)` unless the same normalized user turn already has a recall-origin extract task. Either way the daemon, not the host, drives capture; report-side extraction and recall-hit promotion attribute side effects to the linked delivery rather than the reporter's later MCP context; tasks route to OfficialApiGardenProvider, host_worker (pending for MCP claim, then a bounded zero-cloud LocalHeuristics in-process fallback if no agent claims — v0.3.11 host_worker default), or LocalHeuristics per the live Garden compute config, and a failed extract no longer aborts the background pass | `live-event-ready` | P6.1-H3 + v0.2.x-auto-extract + v0.3.11 host_worker fallback |
| Recall tier widening | `live-event-ready`; coarse filter cascades HOT → WARM → COLD when fine-assessment results stay below `MIN_RECALL_RESULTS`; freshness decay 0.7 / 0.45; `degradation_reason` surfaces `warm_cascade_engaged` / `cold_cascade_engaged`; HOT-only fast path is byte-identical at the response boundary | `live-event-ready` | P6.1-R1 |
| Recall hit → tier promotion | `live-event-ready`; `report_context_usage` with `usage_status="used"` on a non-HOT memory atomically promotes it to HOT and emits `SOUL_MEMORY_TIER_PROMOTED` with `reason="recall_hit"` via `EventPublisher.appendManyWithMutation`; concurrent USED reports collapse to one promotion via storage CAS | `live-event-ready` | P6.1-R2 |
| Trustworthy Memory Loop | `live-event-ready`; accepted memory proposals validate through `MemoryService.validateUpdate`, apply inside an atomic proposal/storage transaction, reject leaves durable memory unchanged, and v0.2.0 carries optional `source_delivery_ids` through agent-originated candidate signals, proposal rows, proposal events, and daemon audit proof after validating anchors against recorded deliveries in the current trusted context | `live-event-ready` | P6-governance-accept-apply + v0.2.0-slice-8..9 |
| Recall explainability + operator control | `schema-ready`; recall results expose selection reason, source channels, score factors, budget state, response strategy mix, and degradation reason; CLI/status names control-plane states distinctly. v0.3.2 adds internal recall evidence packs for fixture-level selected ids, source channels, score factors, budget state, evidence pointers, delivery/usage links, and metrics. v0.3.3 adds cold graph/path score reallocation and reports the resolved activation weights in score factors. | `schema-ready` | P6-recall-explainability + P6-operator-control + v0.3.2 + v0.3.3 |
| Recall utilization telemetry | `live-event-ready`; daemon emits `soul.recall.delivered` (delivery_id / session_id / run_id / agent_target / query_hash / pointer_count / latency_ms) per `soul.recall` MCP call and `soul.context_usage.reported` per `soul.report_context_usage`. session_id is process-stable for `mcp stdio` and per-call for HTTP / CLI surfaces. usage events attribute run_id / agent_target / workspace_id from the linked delivery (not the reporter context) so retries land in the right session. `alaya status --recall-stats --workspace <id> [--since/--until]` aggregates total / unique_sessions / unique_runs / miss_ratio / used_ratio / follow_through_ratio over the EventLog window; aggregation excludes `inspector` / `cli` / `tools-cli` agent_targets by default (configurable via `excludeAgentTargets`); failures of the telemetry append never surface to the MCP caller. | `live-event-ready` | apps/core-daemon/src/services/recall-utilization-service.ts |
| Memory-entry graph production | `live-event-ready`; the memory graph is the unified `path_relations` plane only — migration 085 dropped the legacy `memory_graph_edges` table and no producer writes it. Co-usage from used recall reports reinforces memory-entry `path_relations`, and later recall reads those path relations as weighted `graph_support`. This is memory-entry to memory-entry only; evidence/synthesis object edges remain out of scope. | `live-event-ready` | migration 085 + 5F-* + v0.3.3 |
| PathRelation production | `live-event-ready` for existing PathRelation plasticity reinforcement, weakening, retirement, and direction-bias redirection. v0.3.3 bootstrap reconcile is explicit-template-only: daemon defaults do not plant ontology seeds and empty defaults return `skipped_no_templates`; corrupt partial records degrade doctor. | `live-event-ready` for plasticity; explicit-template bootstrap only | 5F-C + 5F-D + 5F-E + v0.3.3 |
| Memory graph + path health diagnostics | `cli-consumable`; `alaya doctor` reports advisory graph-health counts from the unified `path_relations` plane only — active path relations grouped by relation kind and the latest path event (`apps/core-daemon/src/services/graph-health-service.ts`); the retired `memory_graph_edges` table is no longer counted. Sparse new workspaces warn without failing the doctor gate. | `cli-consumable` | migration 085 + v0.3.3 |
| Cross-surface Phase 6 contract parity docs | `docs-truth-ready` | `docs-truth-ready` | P6-contract-parity-reset |
| Graph inspector data contract | `live-event-ready`; daemon `GET /workspaces/:workspaceId/soul/graph` (`apps/core-daemon/src/routes/soul-graph.ts`) serves a `SoulGraph` projection assembled by `SoulGraphService` from the unified `path_relations` path graph (migration 085 dropped the legacy `memory_graph_edges` table; the graph plane is `path_relations` only); Inspector backend proxies as `GET /api/graph/:workspaceId` (`apps/inspector/src/routes/graph.ts`); Inspector Graph page consumes it. v0.3.3 doctor `graph_health` reuses the same SQL data | `live-event-ready` | P5-graph-contract + v0.3.3 |

## Known Wiring Gaps

Phase 1 through Phase 3 implementation surfaces are ported and unit-tested.
Phase 4 daemon, CLI, MCP, Inspector server, and Inspector frontend surfaces are
implemented and tested. Gate-4 passed on 2026-05-01 after the attached-agent
MCP proof, Inspector config-write repair, and trust delivery/usage durability
repair all passed targeted verification.

`apps/core-daemon/src/__tests__/attached-agent-mcp-proof.test.ts`
now resolves `#BL-018`: it runs `alaya install`, `alaya attach codex`,
MCP `tools/list`, `soul.recall`, `soul.open_pointer`,
`soul.report_context_usage`, `soul.emit_candidate_signal`, proposal
creation, governance reject, a Garden background pass with EventLog and
health-journal evidence, `alaya status`, and `alaya doctor` in one daemon
lifetime using the MCP SDK in-memory transport.

Remaining non-blocking follow-up after Gate-4: none for the resolved
trust-state delivery / usage and counter restart-stability repairs.

P5-graph-contract is `live-event-ready`: the daemon serves
`GET /workspaces/:workspaceId/soul/graph`
(`apps/core-daemon/src/routes/soul-graph.ts:23`) returning a
`SoulGraph` projection that `SoulGraphService.buildSoulGraph` assembles
from the unified `path_relations` path graph (migration 085 dropped the
legacy `memory_graph_edges` RECALLS-edge table; recall edges fold into
`path_relations`). The Inspector backend proxies the route as
`GET /api/graph/:workspaceId` (`apps/inspector/src/routes/graph.ts:5`)
and the Inspector Graph page consumes it
(`apps/inspector/web/src/pages/Graph.tsx:162`). v0.3.3 also adds
CLI-consumable doctor `graph_health` reading the same SQL data
(`path_relations` / `latest_path_event`). Daemon default
bootstrap templates remain empty; explicit templates can still be
planted, and empty defaults reconcile as `skipped_no_templates`. P5-e2e is
`live-event-ready`: the
release loop proves install, attach, MCP memory tools, CLI tools parity,
candidate signal, proposal reject, Garden pass, status/doctor, backup, and
export in one daemon lifetime. P5-final-review is `mcp-consumable`: the
four-perspective review/fix loop closed with zero Blocking / Important
findings for the MCP/CLI release path. Gate-5 / v0.1.0 passed on
2026-05-02.

The post-port hygiene sweep tracked by `#BL-017` executed after Gate-5
as a dedicated v0.1.x cleanup wave. It renamed protocol event source
files and symbols to domain names, split the listed oversized production
TypeScript files, and added reproducible `knip` unused-code checking
without changing event strings, storage schemas, MCP/CLI wire contracts,
or durable EventLog data. Phase 6 / Gate-6 / v0.1.1 active acceptance is
MCP agent-use proof plus trustworthy memory-loop runtime behavior;
legacy benchmark fixtures are archived-only and not an active gate.

## Phase 5 system-level review (post-Gate-5, 2026-05-03)

After Gate-5 the user requested a deeper system-level review than the
four-perspective Gate-5 final-review covered. The work was tracked under
`p5-system-review-r1` and `p5-system-review-r2`.

**Round 1 (`p5-system-review-r1`).** Ten reviewers (architect, red-team,
sql-pro, install-release, pr-review, test-automator, plan-challenger,
documentation-engineer, typescript-pro, codex external) ran in parallel
and surfaced 11 Blocking / 21 Important / 11 Nice-to-have findings after
deduplication. The merged report is at
`docs/archive/v0.1-port-record/phase-5-briefs/reports/p5-system-review-round-1.md`. Twenty-two
atomic commits closed the Round 1 Blocking set (HTTP proposal review +
memory read endpoints removed; `soul.emit_candidate_signal` scope bound to
MCP context; ProposalService/ClaimService `deferredNotificationEvents`
property name unified; MCP proposal create path atomized via
`createProposalWithEvents`; runtime-notifier listener exceptions isolated;
SQLite WAL + busy_timeout + version-ahead guard added; install plan/apply
/rollback with prior-audit guard; review-protocol §Cause Class
Aggregation + invariants §21a / §29-31 added; `#BL-024`, `#BL-023`,
`#BL-017` close paths declared in `docs/handbook/backlog.md`).

**Round 2 (`p5-system-review-r2`).** A Codex external sanity check
(`docs/archive/v0.1-port-record/phase-5-briefs/reports/p5-system-review-round-2.md`) confirmed
Round 1 closures and surfaced 4 residual Blocking findings: F-r2-001
(`soul.explore_graph` payload-spoofable workspace), F-r2-002 (`open_pointer`
fixed at handler boundary, not at `MemoryService` source), F-r2-003 (install
did not actually run schema migrations before claiming success), F-r2-004
(attach wrote bare `command = "alaya"` which pnpm did not expose to PATH).
Six atomic commits (`6299c95`, `be96a14`, `2d5366c`, `ee8c95f`, `384c2d4`,
plus `4f507d3` adding the root `pnpm alaya` npm script) closed all four,
moving scope binding to the MCP handler boundary, adding
`MemoryService.findByIdScoped`, calling `initDatabase` from install (without
closing the cached connection), and writing `command="node"` plus an
absolute path to `bin/alaya.mjs` into Codex / Claude profiles.

**Round 3 (`p5-system-review-r3`).** The user pushed back on Round 2's
"follow-up wave" framing because parking nine Round 1 Important findings
violates the "backlog 不是问题归宿" preference. Round 3 walked each
remaining Important either to a fix, an invariant, or an explicit v0.2
deferral with a written close condition. Nine Round 3 atomic commits
(`4aa5de1`, `d63ab97`, `bb3e02c`, `30ad2a0`, `dfdc909`, `60f2ec9`,
`78d8a91`, plus this one) closed all but one Important; the remaining
deferral was `#BL-022` (EventPublisher atomic port + EventLog revision
transaction). v0.1-closeout-a2 retroactively closed `#BL-022` rather
than ship the deferral — see `backlog.md` for the full migration
commit chain.
Highlights:
- MR-I05: `SoulOpenPointerResponse.content` is now a typed projection of
  six fields; MemoryEntry internals (lifecycle_state, created_by,
  storage_tier, workspace_id) no longer leak.
- MR-I03 + MR-I04: `BoundedString` primitives applied across MCP request
  schemas (query 4096 / id 256 / reason 16384 / arrays 1000 / evidence
  arrays 100); the catalog now derives `inputSchema` from zod via
  `zod-to-json-schema` so external clients see the same bounds the
  runtime enforces.
- MR-I11: `alaya doctor` reports `storage.schema_ok` (persisted vs known
  max migration version) so an operator can tell apart "db file exists"
  from "db is fully migrated for this binary".
- MR-I06: shutdown now drains in-flight HTTP handlers (lifecycle
  middleware returns 503 once SIGTERM/SIGINT lands; `database.close()`
  waits for the in-flight counter to reach zero with a 30s deadline).
- MR-I16 / MR-I20 / MR-N09: evidence-lock test renamed and given one
  behavior assertion, the `mixed:` readiness cells split into the proper
  vocabulary (`cli-consumable` subset vs `implementation-ready` subset),
  and three `expect.toBeDefined()` weak assertions were upgraded to
  interface-shape assertions.

Backlog Open count for `#BL-025` through `#BL-036` is zero after the
Gate-5F implementation cards. Gate-5F aggregate final review and full
verification have passed; Phase 6 is an MCP agent-use and trustworthy
memory-loop proof wave with `mcp-callable` / `live-event-ready` as
the active acceptance target.

## v0.1-closeout lessons (parallel A1/A2/A3 sub-agent dispatch)

Two recurring failure shapes surfaced across the parallel A1/A2/A3
sub-agent waves and are worth pinning so the next multi-card closeout
does not pay the same cost:

- **Test-shape pin vs behaviour pin.** A1's
  `review-evidence-locks` doc-cite loop, A2's workspace-service
  `Promise.all` parallel-insert assertion, and A2's
  `routes-config-port` "persist callback IS the SQL boundary" test all
  pinned implementation shape (catalog count, async ordering, callback
  layering) instead of the contract the test was named for. Any catalog
  growth, atomicity migration, or transaction-shape change broke
  unrelated tests purely because the test pinned `how`, not `what`.
  Future tests must assert observable contract — not call shape, not
  ordering, not async-vs-sync.
- **Prompt-shape vs codebase-shape.** A1's prompt asserted a
  `proposal_reviews` table that didn't exist; A3's prompt asserted
  `PathPlasticityStateSchema` was already exported (it was declared but
  not exported) and didn't include `garden-tier.ts` in the may-modify
  list (adding a new task kind requires that file). Per-card prompts
  that drifted from disk truth forced sub-agents to re-derive the shape
  mid-implementation. Future multi-card briefs must include a
  `verified-files-and-symbols` block produced by `rg`/`Read` immediately
  before dispatch, not from the planner's mental model.

Both lessons are process-level — neither requires a code change in
v0.1-closeout. They are pinned here so the v0.1.x maintenance waves and
v0.2 planning agents can reference them at the source rather than
re-discovering them from `.do-it/findings/{a1,a2,a3}.md`.

## v0.3.9 Release (2026-05-17)

Trustworthy memory loop closure across three structural layers
(producer-side ontology, structure registry, runtime control + typed
governance). Three new storage migrations: `069-drop-node-instances.sql`
(table drop), `071-health-issue-groups.sql` (new projection),
`072-drop-synthesis-promotion.sql` (drops 3 columns + dependent
index). Migration sequence number 070 is intentionally skipped.

MCP surface adds **one verb** — `soul.resolve` — bringing the live
catalog to **13 tools** (10 `soul.*` + 3 `garden.*`). Recall results
gain an additive optional `staged_warnings[]`. No other MCP tool name
or request-schema change.

New / changed runtime-visible surfaces:

- **`soul.resolve` MCP verb** is `implementation_wired`. Six
  resolutions (`confirm` / `reject` / `correct` / `stale` / `defer` /
  `not_relevant`) dispatch through `ResolutionService` and atomically
  transition `ClaimService.transitionLifecycle(draft → active)` or
  the appropriate alternative. Optimistic concurrency at the SQL
  boundary; CAS-first / audit-second ordering enforced.
- **Garden's only legal claim output is `draft`** (invariant §35).
  `MaterializationRouter` routes by `object_kind` to one of five
  targets (`signal_only` / `evidence_only` / `evidence_short_ttl` /
  `memory_entry_only` / `memory_and_claim_draft`); the
  `potential_conflict` signal kind routes through
  `ConflictDetectionPort.evaluate` instead of the questionable-evidence
  fallback.
- **`staged_warnings[]` on recall payload** is additive. Each warning
  carries `kind` (`low_confidence` / `contradiction_pending` /
  `supersede_candidate` / `evidence_missing` / `policy_violation`),
  `severity` (`info` / `warning` / `blocking`), `policy`, `summary`,
  and `resolution_options`. Older agents skip the field.
- **`GovernancePolicy` agent-side classifier**: optional
  `policy_classification` on `SoulResolveRequestSchema`
  (`ask_now` / `apply_silently` / `track_only` / `inspect_later`)
  with a per-turn `ask_now` budget; overflow degrades to
  `inspect_later` so the Inspector still surfaces warnings.
- **Recall utilization 5-bucket split**: per-workspace per-`agent_target`
  buckets (`no_recall` / `empty_recall` / `delivered_not_reported` /
  `reported_skipped_or_na` / `reported_used`) sum to deliveries +
  EventLog `no_recall` events; `SOUL_SINGLE_USED_ANCHOR` telemetry
  emits without advancing the PathRelation co-usage counter.
- **`PathRelation` becomes a first-class producer + consumer**:
  governance class drives the `ManifestationResolver` ceiling
  (`hint_only → none`, `attention_only → lens_entry`,
  `recall_allowed → lens_entry + dialogue_nudge`,
  `strictly_governed → all three including stance_bias`);
  `stability_class` evolves on cumulative `support_events_count`
  thresholds (3 / 8); `AuditorSchedulingAdvisor` reads
  `verification_bias`; `path-activation-candidate-producer.ts`
  bridges path data into manifestation.
- **Governance routes are documented as four route families**:
  scoring pressure, recall-time warning, out-of-band review queue,
  and inline typed resolution. The five compatible runtime surfaces
  remain for schema compatibility, but `HealthIssueGroup` and
  `Proposal` now share the out-of-band review queue concept. See
  `docs/handbook/governance-routes.md`.
- **`HealthIssueGroup` Inspector Health Inbox**: new projection
  table (migration `071`), aggregated by `(target_memory_id,
  cause_kind)` from Auditor / OrphanRadar / Green / `evidence_failure`
  producers; Inspector `/health-inbox` page renders the grouped view;
  Memory Browser ships "Promote to strictly_governed" button that
  posts a typed `path_relation` Proposal whose accept-apply path writes
  the `path_relations` row through the audited proposal workflow.
- **`surface_identities` per `(workspace_id, agent_target)`**: first
  attach writes a row via `SurfaceService.createSurface`; idempotent
  on CONFLICT; routes `governance_critical` DriftAlerts through
  `HealthJournal`.
- **`SynthesisCapsule.promotion` ladder retired**. Three columns
  dropped via migration `072`; `SOUL_SYNTHESIS_PROMOTED` event
  registration kept as deprecated for legacy EventLog replay
  (invariant §25); no producer emits it. The replacement is
  `soul.resolve.confirm`.
- **`NodeInstance` retired** (migration `069`). The daemon runtime
  engine is single-instance; the schema slot is removed.
- **`DeferredObligation` wired into production**. `soul.resolve.defer`
  writes obligations; replaces the retired `cooldown_until` field.
- **PathRelation / graph-edge EventLog-first atomicity**
  (`v0.3.9-blocking-p0` tag): `PathRelationProposalService.propose`,
  `MemoryGraphEdgeRepo.ensureEdge`, and `GraphExploreService.addEdge`
  now route through `publishEventLogMutation`. `GreenStatus` silent
  UPDATE bug closed with affected-row guard + `green_revoke_noop`
  EventLog row.

Bench feedback loop:

- LoCoMo `evaluated_count` denominator now uses `totalQa` instead of
  successfully scored entries; sample-size label cascades through
  `smoke` ≤ 50 / `staged` 51–200 / `shard_merged` 201–499 /
  `full` ≥ 500; cohort-attribution cross-question metric bounded ≤
  50%; `latest-baseline.json` no longer points at a FAIL archive.
  See `docs/v0.3/v0.3.9/reports/v0.3.9-bench-diff.md` for pre/post
  numbers per category.

Backlog status: `#BL-044` is closed in v0.3.9 (recall utilization
follow-through addressed by 5-bucket telemetry + Inspector drill-down).
During v0.3.10 implementation, the residual carry-forward items in
this section are closed in the controller branch: `mapping_revoked`
fires from `MemoryService.update` and atomic proposal accept-apply,
`ManifestationBudgetConfigProviderPort` uses the persistent config service,
`AuditorSchedulingAdvisor` is wired into production Garden runtime,
promote-to-`strictly_governed` Proposal accept-apply writes
`path_relations`, claim lifecycle transitions use the EventPublisher
transaction path, and path plasticity support thresholds are unified
under `DYNAMICS_CONSTANTS.path_plasticity`. `report_context_usage`
also carries optional `trust_mode`, path plasticity applies repeated-use
decay plus automatic-mode half weight, and recall diagnostics record
path expansion source seed/path/target triples. The long-lived
`UpgradeAssessmentAxis` cutover stays tracked by
`docs/v0.3/v0.3.9/closeout-deferred-conditions.md`.

Workspace packages bumped `0.3.8` → `0.3.9`. See `docs/v0.3/v0.3.9/`.

## v0.3.8 Release (2026-05-16)

Ontology mid-layer recapture + codex-review wiring repair. One new
storage migration (`068-evidence-capsule-fts.sql` — FTS5 only, no
ontology table change). No MCP tool name / request / response schema
changes; one additive schema change (`SoulOpenPointerContentSchema`
gains optional `gist` / `excerpt` for EvidenceCapsule pointers).

New / changed runtime-visible surfaces:

- **EvidenceCapsule production** is `live-event-ready`: `materialization-
  inputs.buildDistilledFact` writes a distilled `MemoryEntry.content`
  (caller-supplied `distilled_fact` or rule-based 2-sentence fallback
  capped at 280 chars across Latin + CJK terminators); the raw turn
  lives in `EvidenceCapsule.gist / .excerpt`; `soul.open_pointer`
  falls through to `EvidenceService.findByIdScoped` when the memory
  lookup misses so attached agents can dereference `evidence_refs[i]`.
- **Four staged MemoryGraphEdge producers** (`supersedes`,
  `contradicts`, `exception_to`, `incompatible_with`) are
  `live-event-ready` via caller-explicit `raw_payload.*_refs` hints
  plus a rule-based `ConflictDetectionService` (env-gated;
  `ALAYA_CONFLICT_DETECTION_ENABLED` and `ALAYA_CONFLICT_RULE_ENABLED`).
  Proposal accept does not write edges (in-place update, no
  new/old memory pair forms).
- **Conflict suppression is best-effort-eventual, not synchronous** (S3c
  enrich-decouple). Materialization enqueues an `enrich_pending` marker
  and acks; the Garden BULK_ENRICH worker drains it and runs
  `ConflictDetectionService` + edge auto-production off-path. The
  unconditional per-workspace drain runs on the ~60s GardenScheduler
  cadence and dispatches up to `BULK_ENRICH_DRAIN_CAP_PER_PASS = 32`
  `BULK_ENRICH` tasks per pass (`apps/core-daemon/src/garden-runtime.ts`).
  Each task is scoped to one workspace and claims at most
  `DYNAMICS_CONSTANTS.enrich.claim_batch_size = 50` pending markers, so
  the per-pass cap is 32 workspaces / 1600 markers while the per-workspace
  cycle cap remains 50. Within those caps the upper bound between a memory
  becoming recallable and its contradiction/supersession edges forming is
  ~1 min (surfaced != conflict-checked within that window). Beyond the cap
  a single-pass backlog larger than 32 workspaces degrades to
  ~`O(workspaces / 32) * 60s`; a single workspace with more than 50 pending
  markers drains across additional cycles because the claim batch bounds
  per-workspace work. A claim stranded by a daemon
  crash between claim and processed is re-armed after a TTL
  (`DYNAMICS_CONSTANTS.enrich.claim_stale_after_ms`, 10 min) by the same
  scheduler pass that reclaims abandoned `garden_task` claims, so no
  enrichment is silently lost on restart. Durable truth is still decided
  by the governed services; only *when* the edges form is deferred.
- **PathRelation propose** is `live-event-ready` via
  `PathRelationProposalService`: 3 co-usage events on the same memory
  pair write a PathRelation; TTL eviction (`ALAYA_PATHREL_COUNTER_TTL_MS`,
  default 24h) bounds the in-process pair counter.
- **Cohort dominance guard covers exact branch** — exact + seed
  cohort branches share a union ratio check and are admitted or
  skipped together when the union exceeds 50% of the tier pool.
- **Mandatory share cap** — protected-dimension non-winners are
  capped at floor(max_entries * 2/3) so 1/3 of the budget stays
  available for ranked candidates; winnerMemoryIds still bypass
  budget unconditionally.
- **Wilson 95% CI in bench report**: `packages/eval/src/metrics/wilson-ci.ts`
  computes the interval; `report.md` annotates R@K with half-width +
  lo/hi bounds + sample-size label; `diff.ts` widens regression
  bands to `max(raw, ci_half_width)` for `evaluated_count < 100`.
- **LoCoMo bench driver**: `apps/bench-runner/src/locomo/` with
  sha256-pinned dataset (`docs/bench-history/datasets/locomo10.meta.json`)
  and `alaya-bench-runner locomo` subcommand. Archives land under
  `docs/bench-history/public-locomo/`.
- **Inspector Memory Browser + cmd-K palette**:
  `apps/inspector/web/src/pages/MemoryBrowser.tsx` with filter chips
  and an evidence drawer reading
  `/api/pointers/:workspaceId/:objectId`;
  `apps/inspector/web/src/components/CommandPalette.tsx` provides
  cmd-K page jumps + clipboard-only CLI verb reminders.
- **Embedding provider env wiring**: `OPENAI_EMBEDDING_PROVIDER_URL`
  + `OPENAI_EMBEDDING_MODEL` + `ALAYA_OPENAI_SECRET_REF` continue to
  drive `OpenAIEmbeddingClient`; documented recipe for yunwu.ai
  `/v1/embeddings` (`text-embedding-3-small`, 1536-d) lives in
  `docs/v0.3/v0.3.8/README.md`.

Closed backlog: #BL-039 / #BL-040 / #BL-041 / #BL-042 / #BL-045 /
#BL-046 (see `docs/handbook/backlog.md`). #BL-044 deferred to v0.3.9
by user directive.

Workspace packages bumped `0.3.7` -> `0.3.8`. See `docs/v0.3/v0.3.8/`.

## v0.3.7 Release (2026-05-15)

Patch-internal dynamic recall, benchmark archive, and Inspector repair
slice. No MCP tool names or descriptions, MCP request/response schemas,
protocol zod schemas, EventLog payload schemas, runtime config schemas,
or storage migrations changed.

Status: implementation checkpoint in **honest-baseline rewrite** mode.
The earlier R@5 = 70.0% disabled-100 number came from a build that
included LongMemEval-question-shape heuristics in `packages/core`;
those heuristics have been removed and the post-removal disabled-100
archive is the new honest baseline (see
`docs/v0.3/v0.3.7/reports/v0.3.7-closeout.md`). Disabled-500,
env-embedding staged floor evidence, and the first `public-multiturn`
and `live` archives are explicitly out of scope for this checkpoint
and are tracked in the follow-up plan.

New / changed runtime-visible surfaces:

- Core recall now has deterministic query probes, multi-plane
  no-embedding candidate admission, read-side graph/path expansion, and
  internal recall diagnostics. These diagnostics remain internal to the
  core/bench harness and are not added to the MCP response schema.
- Bench history archive **contract** now defines
  `docs/bench-history/public-multiturn/` for repeated LongMemEval
  recall/report-context-usage rounds in one workspace per question
  (with its own `latest-baseline.json`), and
  `docs/bench-history/live/` for normalized strict-real entries
  alongside `self/` and `public/`. No v0.3.7-era entries in those
  directories yet; first archives are follow-up work.
- LongMemEval entries may include a secret-free
  `longmemeval-diagnostics.json` sidecar with candidate admission
  planes, rank/drop status, miss classification, and closed provider
  state/rate fields. Env-embedding KPI payloads may include
  `r_at_5_overall`, `r_at_5_with_embedding_returned`, and provider
  returned/pending/failed rates.
- `alaya-bench-runner live` and `alaya-bench-runner
  longmemeval-multiturn` are wired and unit-tested; first invocations
  on the current v0.3.7 code are follow-up work.
- `@do-soul/alaya-eval` accepts `bench_name="live"`,
  `bench_name="public-multiturn"`, `split="strict-real"` /
  LongMemEval splits, and `harness_mode="live_strict_real"` for these
  archive surfaces.
- Inspector Overview reads `self`, `public`, `public-multiturn`, and
  `live` bench summaries.
- `alaya inspect` injects the managed daemon's `ALAYA_REQUEST_TOKEN` into
  the Inspector child process, fixing graph/memory actions that require
  daemon request-token protection. External daemons do not inherit a
  parent `ALAYA_REQUEST_TOKEN`; the explicit external bridge is
  `ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN`.
- Inspector frontend error handling now surfaces backend string or
  structured error messages instead of generic HTTP status text.
- `scripts/build-existing.mjs` now builds `packages/eval` and
  `apps/bench-runner`, preventing stale eval/bench declarations during
  `rtk pnpm build`.

Workspace packages bumped `0.3.6` -> `0.3.7`. See `docs/v0.3/v0.3.7/`.

## v0.3.6 Release (2026-05-14)

Patch-internal UI + bench feedback-loop release. No MCP tool names or
descriptions, MCP request/response schemas, EventLog payload schemas,
runtime config schemas, or storage migrations changed.

New runtime-visible surfaces:

- Inspector overview surface (`apps/inspector/web/src/pages/Overview.tsx`)
  with daemon health pill, pending proposals card, recall stats card,
  tier distribution, and per-split latest bench cards.
- Inspector recall utilization UI (`apps/inspector/web/src/pages/Recall.tsx`)
  consuming `RecallUtilizationService` via the new
  `GET /workspaces/:workspaceId/recall-stats` daemon route + the
  `/api/recall-stats/:workspaceId` Inspector proxy.
- Bench harness (self) — `@do-soul/alaya-bench-runner self` runs the 8
  inline synthetic scenarios through the real MCP `propose+review`
  chain in an in-process daemon.
- Bench harness (public LongMemEval-Oracle + LongMemEval-S) —
  `@do-soul/alaya-bench-runner longmemeval --variant {oracle|s}` runs
  the HuggingFace dataset (sha256-pinned under
  `docs/bench-history/datasets/<variant>.meta.json`) through the
  same in-process daemon.
- Bench history archive (`docs/bench-history/{self,public}/`) —
  bench-keyed entries with `kpi.json`, `report.md`, optional
  `findings.md`. The bench-wide `latest-baseline.json` pointer tracks
  the newest entry across all splits; split-aware comparison lives in
  the `readLatest(layout, bench, { split })` API which scans entries
  and ignores the pointer when a split filter is provided.

Workspace packages bumped `0.3.5` -> `0.3.6`. See `docs/v0.3/v0.3.6/`.

## v0.3.2 Release (2026-05-13)

Patch-internal memory-quality release. No MCP tool names or descriptions,
MCP request/response schemas, EventLog payload schemas, runtime config
schemas, or storage migrations changed. The release adds internal recall
evidence packs for fixture-level selected ids / source channels / score
factors / budget state / evidence pointers / delivery usage links,
normalizes Garden candidate signals with internal schema-grounded
`raw_payload` metadata, defers invalid schema-grounded signals in
`SignalService`, blocks invalid field/value payloads in
`MaterializationRouter` before memory / claim writes, and adds read/write
integration fixtures for exact fact, current state, negative query,
relation query, thematic recall, and Chinese preference / constraint
recall. Workspace packages bumped `0.3.1` -> `0.3.2`. See
`docs/v0.3/v0.3.2/`.

## v0.3.1 Release (2026-05-13)

Patch-safe recall/code-quality release. No MCP tool names or descriptions,
MCP request/response schemas, EventLog payload schemas, runtime config
schemas, or storage migrations changed. The release extracts recall
candidate construction and delivery-budget rebuilds from `RecallService`,
unifies storage keyword-search row plumbing, splits daemon recall result
shaping out of `mcp-memory-tool-handler.ts`, registers the host-autonomy
witness export script as an explicit hygiene-visible package script, and
bumps workspace packages `0.3.0` -> `0.3.1`. The later v0.3.2
read/write integrated memory-quality work is recorded above. See
`docs/v0.3/v0.3.1/`.

## v0.3.0 Release (2026-05-13)

Closes `#BL-009` (OS keychain for secrets — `keychain:<service>:<account>`
refs, `alaya install --keychain` migration, doctor readiness; the libsecret
/ macOS `security` / Windows `PasswordVault` adapters are code-reviewed and
the libsecret one degrades correctly without a secret service, but an actual
keychain write→read is not runtime-exercised anywhere yet — the dev box is
WSL2 with no secret service, no maintainer has a macOS/Windows host;
`env:` / `file:` secret refs are the runtime-verified path — see
`docs/handbook/maintenance.md`), `#BL-038` (host autonomy —
`agent-used` for `soul.recall` + `soul.report_context_usage` via a
live-usage EventLog witness + offline regression), and confirms `#BL-037`
closed as negative proof (Codex 0.130.0 has no third-party fixed slash
registry). Adds: `ALAYA_GARDEN_PROVIDER_KIND` / `install --non-interactive`
`garden_provider_kind` operator entry for `provider_kind=host_worker`; an
`ALAYA_AGENT_TARGET` stamp on the attach-written MCP entry so recall/usage
telemetry attributes to the `claude-code` / `codex` trust surface (re-run
`alaya attach` after upgrading to pick it up; `alaya doctor` flags a stale
attach as drifted). Workspace packages bumped `0.2.0` → `0.3.0` (the new
`secret_ref_kind: "keychain"` EventLog value is a public-surface change per
invariant §25). See `docs/v0.3/v0.3.0/`.

## v0.1.0 Release (2026-05-05)

The `v0.1-closeout` integration branch landed on `main` after a
6-lens D2 multi-lens review (reviewer / red-team / spec-compliance /
domain-language / architect / Codex) plus a 2-round Codex-only
fix-loop converged on zero Blocking and zero Important findings.
The release diff vs. the previous `v0.1.0` framing absorbs:

- **A1** — HITL daemon backbone (`soul.list_pending_proposals` MCP
  tool, `alaya review pending|accept|reject` CLI, `reviewer_identity`
  on review records, Inspector "Pending Proposals" view).
- **A2** — `EventPublisher.appendManyWithMutation` atomic primitive +
  14 producer migrations, closing `#BL-022`. Legacy
  `publishWithMutation` / `publishManyWithMutation` survived only until
  Gate-5F, which removed the final Garden adapter dependency (`#BL-026`).
- **A3** — Path-axis plasticity feedback loop:
  `PathPlasticityService` consumes `MEMORY_USAGE_REPORTED` →
  emits `PathRelationReinforced/Weakened/Retired` runtime-governance
  events → `RecallService` factors a plasticity weight into recall
  scoring. Gate-5F later wired the fourth named plasticity op,
  `direction_bias` redirection (`#BL-029`).
- **C1** — Post-port hygiene wave: protocol `phase-*.ts` → domain
  names (e.g. `events/runtime-governance.ts`); oversized files split;
  `knip` unused-export check pinned; `code-map.md` refreshed.

D2 fix-loop additionally closed five red-team / architect / codex
findings inline (cross-workspace recall poisoning via
`soul.report_context_usage` (`B3`), cross-tick reapplication of
plasticity receipts via in-process watermark (`B2`), CLI review
`ALAYA_RUN_ID` override, Inspector POST `null` body TypeError,
`assertProposalContext` over-loosening, `proposed_changes.content`
size cap, etc.) and opened ten Gate-5F backlog cards
(`#BL-027`..`#BL-036`) for Gate-5F — each with explicit close
conditions per `feedback_no_backlog`, and each resolved before Phase 6.

End-to-end verification at the merge commit:
`rtk pnpm build` exit 0; `rtk pnpm test` 258 test files / 1996 tests
green. Convergence rule (Blocking + Important double-zero) holds.

The end-to-end verification gate at HEAD `78d8a91` runs clean (same
shape as Round 2):
`rtk pnpm install`, `rtk pnpm build`, `rtk pnpm exec vitest run` (248 files
/ 1916 tests pass), `rtk pnpm alaya doctor`, `rtk pnpm alaya install --non-interactive`,
`rtk pnpm alaya attach codex --yes`, `rtk pnpm alaya status`, `rtk pnpm alaya tools list`,
and `rtk pnpm alaya tools call soul.recall '<full-json>' --json` all
succeed. Convergence rule (Blocking + Important double-zero) is met for
the system-review wave; remaining Important items (bounded zod schemas,
DRY MCP catalog from zod, `SoulOpenPointerResponse` projection,
shutdown drain, doctor `schema_ok`, EventPublisher port extension) are
non-blocking and tracked for a follow-up wave.

## v0.1.3 Inspector Workspace Bootstrap (2026-05-10)

Patch release. Three fixes wired together so `alaya inspect --open`
shows live data on a fresh install instead of 404-ing the Strategy /
Soul / Environment config sections:

- `alaya inspect` now lists `/workspaces` from the daemon at start. If
  exactly one active workspace exists it is auto-selected; zero exits
  with `'alaya install' inside your project root first`; multiple
  prints the candidate ids and requires `--workspace <id>`.
  `--workspace` is implemented as a CLI flag and the chosen
  `workspaceId` is encoded into the loopback URL as `&workspaceId=...`
  alongside the existing `?token=...`.
- `apps/inspector/web/src/pages/Config.tsx` and `Graph.tsx` removed
  the silent `?? "default"` fallback that produced the 404 path. They
  now mirror `Proposals.tsx` and render the `common:noWorkspace`
  banner when `getWorkspaceId()` returns null.
- `setWorkspaceId` widened to `string | null` so test surfaces and
  any future "detach from workspace" flow can clear it cleanly.

Follow-up review tightened the trust boundary: the CLI-selected
workspace is now passed to the Inspector child as
`ALAYA_INSPECTOR_WORKSPACE_ID`, and the Inspector backend rejects
workspace-scoped API paths whose path workspace does not match that
launch context. Automated evidence covers the route-backed CLI
`/workspaces` contract, Inspector proxy mismatch rejection, stale
frontend workspace clearing, and Graph no-workspace rendering. Manual
browser smoke remains useful, but it is not the source of authority for
the token-bound workspace rule.

## v0.1.2 Distribution (2026-05-09)

Distribution path moved off npm: v0.1.2 ships exclusively as a
checksum-verified source tarball attached to each GitHub Release. The end-user installer
(`scripts/install.sh`) downloads `do-soul-alaya-${VERSION}.tar.gz` +
`SHA256SUMS`, verifies the checksum locally, then runs `pnpm install
--frozen-lockfile && pnpm build` inside `~/.local/share/do-soul-alaya`
(or `$ALAYA_HOME`) and symlinks `bin/alaya.mjs` into `~/.local/bin`.
Rationale: v0.1.1 publish was blocked by npm auth and the monorepo
+ pnpm workspace shape does not graft cleanly under `npm install -g`.
GitHub-only distribution removes the secret-management surface and
keeps the install path readable end-to-end (clone → checksum → build).
Release workflow lives at `.github/workflows/release.yml`; on `git
push tag v*` it runs CI, generates the tarball + `SHA256SUMS` via
`git archive HEAD`, and uploads both to the GitHub Release.

## Gate Definitions

- **Gate-0**: Handbook complete, INDEX complete, task cards written for
  all of Phase 1-5, port-source snapshot frozen at upstream commit
  `6ed846341f66ff98bfcddbb940db74cfc10133ca`, monorepo shell in place.
  (Snapshot directory removed after v0.1.0 by Phase E vendor cleanup.)
- **Gate-1**: All Phase 1 leaves ported and `rtk pnpm build` + `rtk pnpm test`
  pass.
- **Gate-2**: All Phase 2 services / repos / Garden / security
  ported; integration tests pass on the producer → consumer paths
  inside core.
- **Gate-3**: ConversationService memory orchestration works in unit tests;
  MCP discovery is functional in tests; Phase 3 closes
  `implementation-ready`, not `live-event-ready`.
- **Gate-4**: `rtk pnpm exec alaya install` → `rtk pnpm exec alaya attach codex`
  → MCP `tools/list` shows the full P4-mcp-memory-tools `soul.*`
  catalog → `soul.recall` → `soul.open_pointer` →
  `soul.report_context_usage` → candidate signal → proposal →
  governance reject → Garden background pass; entire flow works
  against a real daemon and asserts Garden EventLog + health-journal
  evidence. `mcp-callable` requires this SDK-driven attached-agent
  proof, not P4-mcp-tooling alone; `agent-used` requires real host
  autonomy and is deferred to v0.2.2 / #BL-038. Current proof:
  `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon attached-agent-mcp-proof`.
- **Gate-5 (v0.1.0 release)**: Gate-4 plus graph contract derived
  from real PathRelation data, full E2E proof, and final multi-lens
  review with zero Blocking / Important findings. Benchmark fixtures
  are archived Phase 6 artifacts and not active Gate-6 acceptance.
- **Gate-6 (v0.1.1 MCP agent-use proof)**: passed 2026-05-06 for release
  acceptance, with evidence in
  `docs/archive/v0.1-port-record/phase-6-briefs/reports/gate-6-closeout.md`. Gate-5F plus
  tools-only MCP instructions, strengthened attach/install profile text,
  accept-as-apply proposal governance, recall explainability fields,
  operator-state CLI language, cwd-derived workspace startup,
  attach-started Garden cleanup, package/profile proof, and a live
  agent-path harness are covered; GitHub Release packaging/version
  stamping remains a separate release operation.
- **Gate-5F (backlog closeout)**: backlog items `#BL-025` through
  `#BL-036` resolved; final review reported zero Blocking / Important
  findings; `rtk pnpm build`,
  `rtk pnpm exec tsc --noEmit -p packages/core/tsconfig.json`, and
  `rtk pnpm test` passed on the integrated branch.
