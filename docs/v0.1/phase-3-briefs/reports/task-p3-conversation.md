# Task P3-conversation Report

## Scope Compliance

- Card: `docs/v0.1/phase-3-briefs/task-p3-conversation.md`
- Port mode: `adapt-and-port`
- Source files:
  - `vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/context-lens-assembler.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-service.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/conversation-streaming.test.ts`
  - `vendor/do-what-new-snapshot/packages/core/src/__tests__/context-lens-assembler.test.ts`
- Target files:
  - `packages/core/src/conversation-service.ts`
  - `packages/core/src/context-lens-assembler.ts`
  - `packages/core/src/__tests__/conversation-service.test.ts`
  - `packages/core/src/__tests__/context-lens-assembler.test.ts`

No shared barrel, phase README, INDEX, runtime-status, code-map, package
manifest, vendor, or `node_modules` files were edited. The forbidden
`packages/core/src/__tests__/conversation-streaming.test.ts` target was not
created because the upstream streaming surface was pruned/fail-closed.

## Port Summary

`ContextLensAssembler` is mechanically ported from source with namespace rewrite
from the upstream protocol namespace to `@do-soul/alaya-protocol`. The only behavior
adapter is removal of the upstream daemon-preview SSE broadcaster dependency;
the recall-to-model projection, `getLastLens` preview cache, explicit clear,
degradation, budget bankruptcy, and audit append behavior remain.

`ConversationService` keeps the source memory-orchestration pieces needed by
P4 MCP memory tools:

- run/workspace lookup and message history reconstruction;
- `ConversationContextLensAssemblerPort` and `assembleMemoryContext`;
- ContextLens failure fallback with warning;
- Garden compile fire-and-forget orchestration;
- governance lease acquire/release around memory-turn orchestration;
- candidate signal parsing and delivery to `SignalService`;
- session override promotion;
- official provider call started/completed/failed telemetry and health journal
  recording.

Chat execution surfaces fail closed:

- `sendMessage` throws `CoreError("CONFLICT", ...)`;
- `sendMessageStreaming` throws `CoreError("CONFLICT", ...)`;
- `interruptRun` returns `unsupported`.
- the fail-closed methods return `Promise<never>` and no exported chat request /
  response DTO remains for P3-core-barrel to re-export.

## Imports And Public Exports

Kept imports:

- protocol memory/control types and schemas:
  `CandidateMemorySignalSchema`, `ContextLens`, `WorkingProjection`,
  `ConversationMessage`, `Run`, `Workspace`, `RuntimeMode`,
  `ExecutionStanceModelRef`, `ExecutionStanceResolution`,
  `GardenProviderKind`, `HealthJournalRecordPort`, provider telemetry schemas,
  and `RunInterruptResult`;
- local `CoreError`, `rebuildConversationMessages`, `SignalServiceReceiveResult`;
- `ContextLensAssembler` imports from `@do-soul/alaya-protocol`,
  `RecallService`, `TaskSurfaceBuilder`, and `getNextRevision`.

Deleted imports:

- `ConversationEnginePort`, `EngineBinding`, `EnginePortMessage`,
  `EngineError`, `EngineStatus`, `MessageDeltaEvent`,
  `StreamingEventType`, `MessageDeltaEventSchema`,
  `MessageCompletedEventSchema`, `RunMessageAppendedPayloadSchema`,
  `EngineResponseReceivedPayloadSchema`, `OutputShaping*`,
  `AgentRuntimePort`, file attachment helpers, `buildSystemPrompt`,
  the SSE broadcaster port, and all runtime-adapter/chat prompt dependencies.

Kept public exports:

- `ConversationService`
- `ConversationRunRepoPort`
- `ConversationWorkspaceRepoPort`
- `ConversationEventLogRepoPort`
- `ConversationGardenComputeProviderPort`
- `ConversationGardenComputeProviderResolverPort`
- `ConversationSignalReceiverPort`
- `ConversationWarnPort`
- `ConversationGovernanceLeasePort`
- `ConversationSessionOverridePromotionPort`
- `ConversationContextLensAssemblerPort`
- `ConversationBudgetBankruptcyPort`
- `ConversationExecutionStanceResolverParams`
- `ConversationExecutionStanceResolverPort`
- `ConversationServiceDependencies`
- `MemoryContextAssemblyInput`
- `MemoryContextAssemblyResult`
- `MemoryTurnOrchestrationInput`
- `MemoryTurnOrchestrationResult`
- `ContextLensAssembler` and its source ports/result types.

Deleted public exports:

- `ConversationFileRecord`
- `ConversationFileRepoPort`
- `SendMessageInput`
- `ConversationResponse`
- streaming/runtime session helper types.

## Adapter Deviations

- Source lines 417-479: interrupt runtime-session branch fails closed as
  `unsupported`; no active runtime session map is retained.
- Source lines 527-545 and 610-668: SSE user/completion broadcasts deleted.
- Source lines 715-946 and 995-1031: streaming generator, runtime-adapter,
  message-delta, and cancellation paths deleted/fail closed.
- Source lines 1259-1310: completed-turn threading is adapted to explicit
  `orchestrateMemoryTurn` input. Durable promotion remains outside the chat
  path and goes through signal delivery / governance services.
- Review fix B1: Garden provider resolution/setup is included in the
  fire-and-forget try/finally path, so a resolver failure records a warning and
  still releases the transferred governance lease.
- Review fix I1: fail-closed chat APIs no longer export chat/attachment DTOs;
  `sendMessage` and `sendMessageStreaming` are unsupported-only methods with
  `Promise<never>` return type.
- Source lines 1784-2114: message-history attachment and principal prompt
  helpers pruned because Alaya has no chat runtime surface and the upstream
  `system-prompt/` dependency is not in this card's write ownership.
- `context-lens-assembler.ts` daemon-preview cache: retained `getLastLens` /
  `clearLens`; removed the SSE degraded-event broadcast.
- Product-Scope Prune Rule: chat execution, runtime adapter integration,
  concrete prompt assembly, file attachments, and streaming tests are pruned,
  not deferred.

## Verification

- Source existence check: passed.
- `rtk pnpm build`: passed.
- `rtk pnpm exec tsc --noEmit -p packages/core`: passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "conversation|memory orchestration|context lens"`: passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/conversation-service.test.ts packages/core/src/__tests__/context-lens-assembler.test.ts`: passed.

## Readiness Impact

Closing readiness is `implementation-ready`. This card does not claim
`live-event-ready`, `mcp-consumable`, or `cli-consumable`; daemon/MCP wiring
and attached-agent proof remain Phase 4 work.

## Pruned Scope

No backlog issue. The pruned chat execution paths are outside the Alaya memory
plugin core.

## Post-Landing Note

Any later edit to this report or the task card must land as a separate
`docs(P3-conversation):` commit per R4.
