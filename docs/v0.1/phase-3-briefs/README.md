# Phase 3 — Wave 3: ConversationService + MCP Tooling + Run Lifecycle

Phase 3 ports the editing / conversation orchestration layer that ties
Phase 2's services together. The headline card is ConversationService
(2,133 lines in upstream — the largest single file in core), plus the
MCP tooling layer that lets the daemon expose memory ops as MCP tools.

Phase 3 has fewer parallel slots (3-5 codex) because the cards depend
on each other and on most of Phase 2.

## Cards

| Card ID | Subject | Notes |
|---|---|---|
| P3-conversation | ConversationService port (~2,133 LOC) | Highest-LOC single card; depends on most of Phase 2 |
| P3-mcp-tooling | daemon-mcp-tooling + mcp-runtime-registry + mcp-catalog | MCP tool surface registration; defines the runtime contract for MCP / CLI parity |
| P3-mcp-discovery | McpToolDiscoveryService + ExtensionRegistryService | Dynamic discovery of external MCP tools from connected agents |
| P3-task-surface-builder | TaskSurfaceBuilder + WorkerRunLifecycleService + RunService + SerialDelegationService | Run / worker coordination |
| P3-misc-services | ConstitutionalFragmentService + CanonicalAliasService + ProjectMappingService + remaining smaller services | Cleanup of unmapped core services |

## Gate-3 Acceptance

- All Phase 3 cards land with reviewer-pass closure.
- Full conversation path (Memory → Recall → ContextPack →
  ConversationService → output) works in unit + integration tests.
- MCP tool registration succeeds in tests; tool descriptors are
  retrievable.
- Code-map and runtime-status updated.

## Parallelism Notes

- P3-conversation depends on Phase 2 (almost all of it). It can start
  only after Gate-2 closes.
- P3-mcp-tooling and P3-mcp-discovery can run in parallel with each
  other and with P3-conversation.
- P3-task-surface-builder depends on RunService being available
  (which lives inside this card or P3-conversation).
- P3-misc-services can run anytime.
