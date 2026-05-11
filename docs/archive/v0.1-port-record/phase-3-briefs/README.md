# Phase 3 — Wave 3: Memory Orchestration + MCP Tool Surface

Phase 3 ports the orchestration layer between Phase 2 services and the
daemon. After review (P0-3.5), the headline ConversationService card
is `adapt-and-port` (chat-specific orchestration removed; only the
memory path retained per user decision 2026-04-28). MCP tool surface
work is **moved to Phase 4** because the upstream files
(`daemon-mcp-tooling.ts`, `mcp-runtime-registry.ts`, `mcp-catalog.ts`)
live in `apps/core-daemon/src/`, not `packages/core/src/`.

Phase 3 has fewer parallel slots (3-4 codex) because the cards depend
on each other and on most of Phase 2. Dispatch starts with
`P3-misc-foundation`; shared docs, reports, and `packages/core/src/index.ts`
remain controller-owned.

Status: **done**. Gate-3 passed after all 6 cards had completion reports,
fresh build/test evidence, forbidden upstream/SSE/chat surface sweeps, and
review/fix-loop closure. See `reports/gate-3-closeout.md`.

## Cards

| Card ID | Subject | Port mode | Closing label |
|---|---|---|---|
| P3-misc-foundation | `packages/core/src/{tool-spec-service.ts,strong-ref-service.ts,dirty-state-panic-service.ts,file-path.ts,message-history.ts}`. Foundation helpers required by MCP discovery, lifecycle, and ConversationService. | adapt-and-port | implementation-ready |
| P3-mcp-discovery | `packages/core/src/{mcp-tool-discovery-service.ts,extension-registry-service.ts}`. Dynamic discovery of external MCP tools registered by connected agents; replace upstream SSE broadcaster calls with Alaya runtime-notifier-compatible ports. | adapt-and-port | implementation-ready |
| P3-run-lifecycle | `packages/core/src/{worker-run-lifecycle-service.ts,worker-run-state-machine.ts,run-service.ts,run-hot-state-service.ts,serial-delegation-service.ts,serial-delegation-event-intake.ts,serial-delegation-recovery.ts}`. Run / worker coordination skeletons. Depends on `P3-misc-foundation` for StrongRef and DirtyState panic helpers. | adapt-and-port | implementation-ready |
| P3-misc-services | Remaining support clusters: surface/workspace, policy/claims, graph, budget, dynamics, security status, and prompt/node helpers. Foundation helpers are excluded and owned by `P3-misc-foundation`; upstream slash command/discovery services are pruned from Alaya scope because they are not part of the memory plugin core. | adapt-and-port | implementation-ready |
| P3-conversation | `packages/core/src/conversation-service.ts` (~2,133 LOC) plus `packages/core/src/context-lens-assembler.ts`. Adapt-and-port: drop worker-dispatch / tool-substrate / runtime-adapter / chat-specific message threading; retain candidate→recall→context lens→govern→durable orchestration so P4-mcp-memory-tools has a recall-to-model producer. See task-card-template Worked Example B. | adapt-and-port | implementation-ready |
| P3-core-barrel | Update `packages/core/src/index.ts` to export every Phase 2 + Phase 3 service. Sequential; runs after all P2 + P3 cards close. | adapt-and-port | implementation-ready |

## Notes

- **Daemon-side MCP files** (`daemon-mcp-tooling.ts`, `mcp-runtime-registry.ts`, `mcp-catalog.ts`) — moved to Phase 4 (`P4-mcp-tooling`). They depend on the Hono router and the daemon DI container, neither of which exists until Phase 4.
- **ConversationService scope** — see Worked Example B in `docs/handbook/task-card-template.md` for the canonical Adapter Points table format. The card author MUST fill in concrete source line ranges before dispatch (the example uses `(TBD by card author)` placeholders).

## Gate-3 Acceptance

- All Phase 3 cards close with reviewer-pass.
- Full memory-orchestration path (Memory → Recall → Evidence →
  Green → ContextLens / ContextPack → ConversationService →
  governance → durable) works in unit + integration tests.
- Phase 3 closes as `implementation-ready`; `live-event-ready` waits for
  Phase 4 daemon/MCP wiring and attached-agent proof.
- `packages/core/src/index.ts` exports every public symbol the Phase
  4 daemon needs.
- Code-map and runtime-status updated.

## Parallelism

- `P3-misc-foundation` runs first.
- `P3-mcp-discovery` and `P3-run-lifecycle` may run after
  `P3-misc-foundation` closes.
- Remaining `P3-misc-services` clusters may run after
  `P3-misc-foundation`; split internally only when write sets are disjoint.
- `P3-conversation` starts after `P3-run-lifecycle` and the required misc
  helpers close.
- `P3-core-barrel` runs sequentially after all feature cards close.
