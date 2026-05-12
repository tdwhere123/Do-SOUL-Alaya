# Runtime Status

Single source of truth for what is wired and what is not. Update after
each Phase Gate.

## Readiness Vocabulary

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
| v0.2.0 | pi-mono Garden provider path, recall scoring refinements, Trustworthy Loop trace anchoring, and invariant §25 SemVer contract | **candidate**: deterministic pi-mono resolver/extractor tests pass, recall refinements `live-event-ready`, Trustworthy Loop trace `live-event-ready`, SemVer snapshot `docs-truth-ready`; provider-transport live smoke is recorded, but the full daemon `POST_TURN_EXTRACT` + EventLog AC7 live smoke is not yet proven | `docs/v0.2/v0.2.0/`; release acceptance pending full Slice 3 AC7 live daemon smoke |

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
| SignalService | `implementation-ready` | `live-event-ready` | P2-svc-signal |
| GlobalMemoryRecallService | `implementation-ready` | `live-event-ready` | P2-svc-global-recall |
| TaskSurfaceBuilder | `implementation-ready` | `implementation-ready` | P2-svc-task-surface-builder-prelude |
| RecallService | `live-event-ready`; v0.2.0 adds budget `pressure_ratio` scoring, per-call `host_context.tokenizer_hint` estimation, and deterministic `domain_weight_overrides` audit factors | `live-event-ready` | P2-svc-recall + v0.2.0-slice-5..7 |
| EmbeddingRecallService | `implementation-ready` | `live-event-ready` | P2-svc-embedding-recall |
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
| Garden compute providers / pi-mono + local heuristics | `implementation-ready`; `OfficialApiGardenProvider` routes extraction through `packages/soul/src/garden/pi-mono-extractor.ts`, with lazy daemon credential/config resolution through `GardenComputeProviderResolver`; deterministic daemon/config tests pass and provider-transport live smoke is recorded, but full daemon `POST_TURN_EXTRACT` + EventLog live AC7 remains pending | `live-event-ready` | P2-garden-batch-1 + v0.2.0-slice-2..4 |
| Garden materialization / degradation / handoff gap | `implementation-ready`; accepted signals are fenced through persisted `compiled` state before materialization side effects, and replay of `triaged` / `compiled` signals does not rerun materializers, preventing duplicate evidence / memory / claim objects after retry or crash windows | `live-event-ready` | P2-garden-batch-3 |
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
| MCP Agent-Use Protocol | `mcp-callable`; SDK-driven proof covers tool discovery, ordered MCP calls, CLI fallback, pointer open, usage receipt, proposal review, durable update, and post-apply recall. Does NOT yet prove a real host autonomously selects these tools during a live Codex/Claude conversation. Note: durable *capture* no longer depends on host autonomy — v0.2.x auto-extracts server-side from the recall turn text (see POST_TURN_EXTRACT routing) — but autonomous use of `soul.emit_candidate_signal` / `soul.propose_memory_update` remains the deferred claim. | `mcp-callable`; `agent-used` deferred to v0.2.2 / #BL-038 | P6-agent-use-protocol + P6-live-agent-proof |
| Garden compute provider config | `live-event-ready` for deterministic config routing; provider_kind / model_id / provider_url / secret_ref split from embedding config; doctor surfaces credential_source (env / file / embedding-fallback / none) and routing_decision; v0.2.0 hot-applies runtime config patches by refreshing compute routing candidates and lazily rebuilding pi-mono-backed official providers after config/secret changes | `live-event-ready` | P6.1-C1 + P6.1-C2 + v0.2.0-slice-4 |
| Garden host-worker surface | `host-worker-ready`; SQLite-backed task queue with atomic claimAtomic CAS (`packages/storage/src/repos/garden-task-repo.ts`); three MCP tools (`garden.list_pending_tasks`, `garden.claim_task`, `garden.complete_task`) let host CLI agents claim and complete Garden tasks; result candidate_signals flow into the same review queue as `soul.emit_candidate_signal`; `garden.complete_task` persists a completion envelope before candidate-signal persistence so partial-failure retries must use the same signal set and cannot under-report already-persisted side effects | `host-worker-ready` | P6.1-H1 + P6.1-H2 + P6.1-H3 + v0.2.x completion-envelope / migration 067 |
| POST_TURN_EXTRACT routing | `live-event-ready`; v0.2.x makes capture self-bootstrapping — attached MCP stdio sessions without `ALAYA_RUN_ID` first create a canonical session run whose `run_id` equals the process-stable MCP `session_id`; `soul.recall` then enqueues a `POST_TURN_EXTRACT` task from `recent_turn` (or `query`), deduped on `(workspace_id, run_id, turn-text hash)`, and `report_context_usage` enqueues one whenever a `turn_digest` is present (no longer gated on a used object), deduped on `(linked_delivery.workspace_id, linked_delivery.run_id, turn_index)` unless the same normalized user turn already has a recall-origin extract task. Either way the daemon, not the host, drives capture; report-side extraction and recall-hit promotion attribute side effects to the linked delivery rather than the reporter's later MCP context; tasks route to OfficialApiGardenProvider, host_worker (pending for MCP claim), or LocalHeuristics per the live Garden compute config, and a failed extract no longer aborts the background pass | `live-event-ready` | P6.1-H3 + v0.2.x-auto-extract |
| Recall tier widening | `live-event-ready`; coarse filter cascades HOT → WARM → COLD when fine-assessment results stay below `MIN_RECALL_RESULTS`; freshness decay 0.7 / 0.45; `degradation_reason` surfaces `warm_cascade_engaged` / `cold_cascade_engaged`; HOT-only fast path is byte-identical at the response boundary | `live-event-ready` | P6.1-R1 |
| Recall hit → tier promotion | `live-event-ready`; `report_context_usage` with `usage_status="used"` on a non-HOT memory atomically promotes it to HOT and emits `SOUL_MEMORY_TIER_PROMOTED` with `reason="recall_hit"` via `EventPublisher.appendManyWithMutation`; concurrent USED reports collapse to one promotion via storage CAS | `live-event-ready` | P6.1-R2 |
| Trustworthy Memory Loop | `live-event-ready`; accepted memory proposals validate through `MemoryService.validateUpdate`, apply inside an atomic proposal/storage transaction, reject leaves durable memory unchanged, and v0.2.0 carries optional `source_delivery_ids` through agent-originated candidate signals, proposal rows, proposal events, and daemon audit proof after validating anchors against recorded deliveries in the current trusted context | `live-event-ready` | P6-governance-accept-apply + v0.2.0-slice-8..9 |
| Recall explainability + operator control | `schema-ready`; recall results expose selection reason, source channels, score factors, budget state, response strategy mix, and degradation reason; CLI/status names control-plane states distinctly | `schema-ready` | P6-recall-explainability + P6-operator-control |
| Recall utilization telemetry | `live-event-ready`; daemon emits `soul.recall.delivered` (delivery_id / session_id / run_id / agent_target / query_hash / pointer_count / latency_ms) per `soul.recall` MCP call and `soul.context_usage.reported` per `soul.report_context_usage`. session_id is process-stable for `mcp stdio` and per-call for HTTP / CLI surfaces. usage events attribute run_id / agent_target / workspace_id from the linked delivery (not the reporter context) so retries land in the right session. `alaya status --recall-stats --workspace <id> [--since/--until]` aggregates total / unique_sessions / unique_runs / miss_ratio / used_ratio / follow_through_ratio over the EventLog window; aggregation excludes `inspector` / `cli` / `tools-cli` agent_targets by default (configurable via `excludeAgentTargets`); failures of the telemetry append never surface to the MCP caller. | `live-event-ready` | apps/core-daemon/src/services/recall-utilization-service.ts |
| Cross-surface Phase 6 contract parity docs | `docs-truth-ready` | `docs-truth-ready` | P6-contract-parity-reset |
| Graph inspector data contract | `schema-ready`; read-only contract derives from active PathRelation data, no live route | `schema-ready` | P5-graph-contract |

## Known Wiring Gaps

Phase 1 through Phase 3 implementation surfaces are ported and unit-tested.
Phase 4 daemon, CLI, MCP, Inspector server, and Inspector frontend surfaces are
implemented and tested. Gate-4 passed on 2026-05-01 after the attached-agent
MCP proof, Inspector config-write repair, and trust delivery/usage durability
repair all passed targeted verification.

`apps/core-daemon/src/__tests__/gate4-attached-agent-mcp-proof.test.ts`
now resolves `#BL-018`: it runs `alaya install`, `alaya attach codex`,
MCP `tools/list`, `soul.recall`, `soul.open_pointer`,
`soul.report_context_usage`, `soul.emit_candidate_signal`, proposal
creation, governance reject, a Garden background pass with EventLog and
health-journal evidence, `alaya status`, and `alaya doctor` in one daemon
lifetime using the MCP SDK in-memory transport.

Remaining non-blocking follow-up after Gate-4: none for the resolved
trust-state delivery / usage and counter restart-stability repairs.

P5-graph-contract is `schema-ready`: `GraphContractService` derives a
read-only path graph payload from active PathRelation data, with no live
daemon, MCP, CLI, or Inspector route. P5-e2e is `live-event-ready`: the
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
  `final-review-evidence-locks` doc-cite loop, A2's workspace-service
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
  `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon gate4-attached-agent-mcp-proof`.
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
