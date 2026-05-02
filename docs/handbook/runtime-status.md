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
| `mcp-consumable` | exposed as an MCP tool / resource and proven to work for at least one connected agent (Codex or Claude Code) |
| `cli-consumable` | exposed via CLI command and proven by at least one E2E run |

## v0.1 Phase Status

| Phase | Scope | Status | Gate |
|---|---|---|---|
| Phase 0 | Reset, vendor snapshot, handbook, INDEX, task cards | **done** | Gate-0 passed |
| Phase 1 | Wave 1 leaves: protocol, migrations, storage shared, config, topology, engine-gateway | **done** | Gate-1 passed |
| Phase 2 | Wave 2: storage repos batches + core services + Garden + security defense | **done** | Gate-2 passed |
| Phase 3 | Wave 3: foundation helpers, ConversationService, MCP discovery, run lifecycle, misc services, core barrel | **done** | Gate-3 passed |
| Phase 4 | Wave 4: Core daemon, routes, MCP server transport, real profile mutation, CLI bridge, secrets, Inspector server, Inspector frontend | MCP memory surface `mcp-consumable`; Inspector config-write and trust delivery/usage durability fixes verified | Gate-4 passed 2026-05-01 |
| Phase 5 | Wave 5: full E2E, graph contract, final review | **done**: graph contract `schema-ready`; release E2E `live-event-ready`; final review `mcp-consumable` | Gate-5 passed 2026-05-02 |

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
| RecallService | `implementation-ready` | `live-event-ready` | P2-svc-recall |
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
| Garden compute providers / local heuristics | `implementation-ready` | `live-event-ready` | P2-garden-batch-1 |
| Garden materialization / degradation / handoff gap | `implementation-ready` | `live-event-ready` | P2-garden-batch-3 |
| Garden bootstrapping / remediation / backlog telemetry | `implementation-ready` | `live-event-ready` | P2-garden-batch-4 |
| Soul package skeleton + governance leaves | `schema-ready` | `schema-ready` | P1-soul-skeleton |
| Soul topology leaves | `implementation-ready` | `implementation-ready` | P1-topology |
| Permission policy stack | `implementation-ready` | `implementation-ready` | P2-security-1 |
| Worker safety / trust | `implementation-ready` | `implementation-ready` | P2-security-2 |
| ConversationService | `implementation-ready` | `implementation-ready` in P3; `live-event-ready` after Phase 4 daemon/MCP proof | P3-conversation + P4-mcp-memory-tools |
| Engine gateway MCP/provider skeleton | `implementation-ready` | `implementation-ready` | P1-engine-gateway-mcp |
| First-party MCP memory tool contract | `implementation-ready` | `implementation-ready` | P4-mcp-memory-tools |
| MCP discovery services | `implementation-ready` | `implementation-ready` | P3-mcp-discovery |
| MCP tool surface | `mcp-consumable` via single-daemon attached-agent MCP harness | `mcp-consumable` | P3-mcp-discovery + P4-mcp-tooling + P4-mcp-memory-tools + P4-mcp-server + Gate-4 proof harness |
| Core daemon | `implementation-ready` | `live-event-ready` | P4-daemon-skeleton + P4-daemon-startup-ordering + P4-sse-strip |
| Profile mutation (Codex/Claude attach) | `implementation-ready` | `cli-consumable` | P4-profile-mutation |
| CLI commands (doctor / install / attach / status / tools / inspect / detach) | mixed: install, attach, status, doctor, and tools list/call are proven by release E2E; inspect/detach remain covered by targeted command tests only | `cli-consumable` | P4-cli-bridge + P4-mcp-memory-tools + P4-cli-* + P5-e2e |
| Trust state delivery / usage | `live-event-ready`; SQL-backed delivery and usage records survive daemon restart | `live-event-ready` | P4-trust-state + #BL-015 repair |
| Secret refs (env / local-file / paste-to-file) | `live-event-ready`; Inspector writes proxy daemon runtime config and are audited through EventLog | `live-event-ready` | P4-secrets + #BL-019 repair |
| Operations (backup, export, import) | mixed: backup/export are proven by release E2E; import remains covered by targeted operations tests only | `cli-consumable` | P4-operations + P5-e2e |
| Memory Inspector | `live-event-ready`; server/frontend exist, token-gated routes pass, and Provider/Config writes proxy daemon runtime config | `live-event-ready` for the inspector surface | P4-inspector-server + P4-cli-inspect + P4-inspector-frontend + #BL-019 repair |
| Marketing benchmark harness | `not-started` | `implementation-ready` | P6-bench-adapter + P6-bench-harness + P6-bench-baselines + P6-bench-resume + P6-bench-readme (Phase 6, post-v0.1.0; ships in v0.1.1) |
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

The post-port hygiene sweep tracked by `#BL-017` is now startable as a
dedicated post-v0.1 hygiene wave and was not executed inside Phase 5.
Benchmark fixtures belong to Phase 6 / Gate-6 / v0.1.1 and are not a
Gate-5 requirement. The older HTTP proposal review route transaction
hardening is tracked by `#BL-024`; it is not part of Gate-5 MCP/CLI
release acceptance.

## Gate Definitions

- **Gate-0**: Handbook complete, INDEX complete, task cards written for
  all of Phase 1-5, vendor snapshot frozen, monorepo shell in place.
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
  evidence. `mcp-consumable` requires this attached-agent proof, not
  P4-mcp-tooling alone. Current proof:
  `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon gate4-attached-agent-mcp-proof`.
- **Gate-5 (v0.1.0 release)**: Gate-4 plus graph contract derived
  from real PathRelation data, full E2E proof, and final multi-lens
  review with zero Blocking / Important findings. Benchmark fixtures
  are Phase 6 / Gate-6 / v0.1.1 scope.
