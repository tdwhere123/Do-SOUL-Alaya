# Phase 3 — Wave 3: Memory Orchestration + MCP Tool Surface

Phase 3 ports the orchestration layer between Phase 2 services and the
daemon. After review (P0-3.5), the headline ConversationService card
is `adapt-and-port` (chat-specific orchestration removed; only the
memory path retained per user decision 2026-04-28). MCP tool surface
work is **moved to Phase 4** because the upstream files
(`daemon-mcp-tooling.ts`, `mcp-runtime-registry.ts`, `mcp-catalog.ts`)
live in `apps/core-daemon/src/`, not `packages/core/src/`.

Phase 3 has fewer parallel slots (3-4 codex) because the cards depend
on each other and on most of Phase 2.

## Cards

| Card ID | Subject | Port mode | Closing label |
|---|---|---|---|
| P3-conversation | `packages/core/src/conversation-service.ts` (~2,133 LOC). Adapt-and-port: drop worker-dispatch / tool-substrate / runtime-adapter / chat-specific message threading; retain candidate→recall→govern→durable orchestration. See task-card-template Worked Example B. | adapt-and-port | live-event-ready |
| P3-mcp-discovery | `packages/core/src/{mcp-tool-discovery-service.ts, extension-registry-service.ts}`. Dynamic discovery of external MCP tools registered by connected agents. | trivial-copy | implementation-ready |
| P3-run-lifecycle | `packages/core/src/{task-surface-builder.ts, worker-run-lifecycle-service.ts, run-service.ts, serial-delegation-service.ts}`. Run / worker coordination skeletons. Worker code paths used only by ConversationService memory orchestration; chat-specific paths are dropped per P3-conversation. | adapt-and-port | implementation-ready |
| P3-misc-services | `packages/core/src/{constitutional-fragment-service.ts, canonical-alias-service.ts, project-mapping-service.ts}` + remaining smaller services not assigned to P2 or P4. | trivial-copy | implementation-ready |
| P3-core-barrel | Update `packages/core/src/index.ts` to export every Phase 2 + Phase 3 service. Sequential; runs after all P2 + P3 cards close. | adapt-and-port | implementation-ready |

## Notes

- **Daemon-side MCP files** (`daemon-mcp-tooling.ts`, `mcp-runtime-registry.ts`, `mcp-catalog.ts`) — moved to Phase 4 (`P4-mcp-tooling`). They depend on the Hono router and the daemon DI container, neither of which exists until Phase 4.
- **ConversationService scope** — see Worked Example B in `docs/handbook/task-card-template.md` for the canonical Adapter Points table format. The card author MUST fill in concrete source line ranges before dispatch (the example uses `(TBD by card author)` placeholders).

## Gate-3 Acceptance

- All Phase 3 cards close with reviewer-pass.
- Full memory-orchestration path (Memory → Recall → Evidence →
  Green → ContextPack → ConversationService → governance → durable)
  works in unit + integration tests.
- `packages/core/src/index.ts` exports every public symbol the Phase
  4 daemon needs.
- Code-map and runtime-status updated.

## Parallelism

- P3-conversation depends on Phase 2 services (per its frontmatter).
  Starts only after Gate-2 closes.
- P3-mcp-discovery, P3-run-lifecycle, P3-misc-services run in parallel
  with each other and with P3-conversation.
- P3-core-barrel runs sequentially after all four feature cards close.
