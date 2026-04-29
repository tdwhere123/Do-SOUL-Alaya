# Implementation Brief: Task P3-conversation — Port ConversationService memory orchestration only

> - **Phase**: 3
> - **Wave**: 3
> - **Card ID**: P3-conversation
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/context-lens-assembler.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-streaming.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/context-lens-assembler.test.ts`
> - **Target**: `packages/core/src/conversation-service.ts`, `packages/core/src/context-lens-assembler.ts`, `packages/core/src/__tests__/conversation-service.test.ts`, `packages/core/src/__tests__/context-lens-assembler.test.ts`
> - **Size**: L
> - **Prerequisite**: Gate-2, P2-svc-memory, P2-svc-recall, P2-svc-evidence, P2-svc-green, P2-svc-governance-lease, P2-svc-session-override, P2-svc-output-shaping
> - **Blocks**: P4-daemon-startup-ordering, P4-mcp-tooling, P4-mcp-memory-tools
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-3-briefs/README.md` row "P3-conversation";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port ConversationService memory orchestration only,
including the ContextLensAssembler producer that turns recall results
into model-consumable context for P4-mcp-memory-tools.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts` | `packages/core/src/conversation-service.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/context-lens-assembler.ts` | `packages/core/src/context-lens-assembler.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-service.test.ts` | `packages/core/src/__tests__/conversation-service.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-streaming.test.ts` | `packages/core/src/__tests__/conversation-streaming.test.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/context-lens-assembler.test.ts` | `packages/core/src/__tests__/context-lens-assembler.test.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Points

| # | Source line range | Change | Justification |
|---|---|---|---|
| 1 | lines 417-479 interrupt runtime-session branches | Delete or fail closed outside Alaya memory path | No live conversation runtime session surface |
| 2 | lines 527-545 user-message SSE broadcast branch | Delete SSE broadcast and retain audit behavior | Invariant §11 |
| 3 | lines 610-668 assistant message completion SSE branch | Delete chat streaming output | Invariant §21 |
| 4 | lines 715-946 engine streaming generator path | Remove streaming chat path; retain memory orchestration inputs | MCP calls are request/response |
| 5 | lines 995-1031 message_delta handling | Delete message delta path | No delta consumer |
| 6 | lines 1259-1310 completed turn threading | Adapt to explicit memory evidence/governance path only | Durable promotion must be explicit |
| 7 | lines 1784-2114 message-history/assistant prompt helpers | Remove if only used by deleted chat paths | Chat prompt assembly out of scope |
| 8 | `context-lens-assembler.ts` daemon-preview cache | Retain recall-to-model projection and last-lens preview behavior without adding SSE or GUI consumers | P4-mcp-memory-tools needs a producer for delivery records and model-consumable context |

## 3. Deferred

- Chat-specific orchestration (worker-dispatch, tool-substrate, runtime-adapter integration, message-thread streaming) — deferred to backlog #BL-004.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/context-lens-assembler.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-streaming.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/context-lens-assembler.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "conversation|memory orchestration|context lens"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-3-briefs/reports/task-p3-conversation.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/context-lens-assembler.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-streaming.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/context-lens-assembler.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "conversation|memory orchestration|context lens"`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel owns exports.

**Prerequisite**: Gate-2, P2-svc-memory, P2-svc-recall, P2-svc-evidence, P2-svc-green, P2-svc-governance-lease, P2-svc-session-override, P2-svc-output-shaping.
**Blocks**: P4-daemon-startup-ordering, P4-mcp-tooling, P4-mcp-memory-tools.
