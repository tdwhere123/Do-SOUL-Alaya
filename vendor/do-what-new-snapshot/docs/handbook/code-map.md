# Code Map

This page is the maintained implementation map for agents. Refresh it whenever
package layout, migrations, repos, routes, or service ownership changes.
Readiness, gate status, and wiring gaps belong in `runtime-status.md`.

## Top Level

```text
apps/
  tui/            Ink terminal UI
  app/            React + Vite UI — web entry surface
  core-daemon/    Hono API, SSE manager, service wiring, background bootstrap

packages/
  protocol/         zod schemas and shared domain types
  storage/          SQLite migrations, repos, cascade delete helpers
  core/             services, EventLog publisher, conversation pipeline,
                    worker runtime adapters
  soul/             Garden, signal handling, heuristics, maintenance roles
  engine-gateway/   conversation AI SDK Core boundary; provider adapters and MCP bridge
  ui-sdk/           typed HTTP client and injectable browser/Node SSE transports
  surface-runtime/  framework-neutral runtime adapter
```

## Core Runtime Paths

| Concern | Primary files |
|---|---|
| Principal message routing and conversation pipeline | `packages/core/src/conversation-service.ts`, `packages/core/src/run-service.ts` |
| EventLog-first publishing | `packages/core/src/event-publisher.ts` |
| Run hot state | `packages/core/src/run-hot-state-service.ts`, `packages/protocol/src/run-hot-state.ts` |
| Worker lifecycle | `packages/core/src/worker-run-lifecycle-service.ts`, `packages/core/src/worker-run-state-machine.ts` |
| Runtime event normalization | `packages/core/src/runtime-event-normalizer.ts`, `packages/protocol/src/events/phase-a3.ts` |
| Serial delegation | `packages/core/src/serial-delegation-service.ts`, `packages/storage/src/repos/worker-run-repo.ts` |
| Deferred obligation and constraint proxy | `packages/core/src/deferred-obligation-service.ts`, `packages/core/src/constraint-proxy.ts`, `packages/storage/src/repos/deferred-obligation-repo.ts`, `packages/protocol/src/deferred-obligation.ts`, `packages/protocol/src/events/phase-b.ts` |
| Dirty-state panic and dossier | `packages/core/src/dirty-state-panic-service.ts`, `packages/storage/src/repos/dirty-state-dossier-repo.ts`, `packages/protocol/src/dirty-state-dossier.ts`, `packages/protocol/src/events/phase-b.ts` |
| Strong refs and target revalidation | `packages/core/src/strong-ref-service.ts`, `packages/core/src/target-revalidate-service.ts`, `packages/storage/src/repos/strong-ref-repo.ts`, `packages/protocol/src/strong-ref.ts` |
| Worker trust and narrative budget | `packages/core/src/worker-trust-assessor.ts`, `packages/core/src/narrative-budget-service.ts`, `packages/protocol/src/worker-trust.ts`, `packages/protocol/src/events/phase-b.ts` |
| Backend-owned worker prompt assembly | `packages/core/src/system-prompt/worker-dispatch-prompt.ts`, `packages/core/src/prompt-asset-registry.ts`, `packages/core/src/system-prompt/constitutional-fragments.ts` |
| Worker baseline safety | `packages/core/src/worker-safety-gate.ts`, `packages/protocol/src/worker-safety-port.ts`, `packages/soul/src/worker-safety-reader.ts`, `packages/soul/src/worker-safety-adapter.ts` |
| Integration gate and zero-day augmentation | `packages/core/src/integration-gate.ts`, `packages/core/src/zero-day-security-layer.ts`, `packages/protocol/src/zero-day-security.ts` |
| Anthropic Claude runtime adapter (principal + worker roles) | `packages/core/src/runtime-adapters/claude-runtime-adapter.ts`, `packages/core/src/runtime-adapters/claude-event-mapper.ts` |
| Runtime SDK seam and role-specific tool profiles | `packages/core/src/runtime-adapters/claude-sdk-client.ts`, `packages/core/src/runtime-adapters/node-claude-sdk-client.ts` |
| Worker prompt assets and constitutional fragments | `packages/protocol/src/prompt-asset.ts`, `packages/core/src/prompt-asset-registry.ts`, `packages/core/src/system-prompt/constitutional-fragments.ts` |
| ToolSpec registration | `packages/core/src/tool-spec-service.ts`, `packages/storage/src/repos/tool-spec-repo.ts` |
| Tool execution substrate | `packages/core/src/tool-substrate/tool-substrate.ts`, `packages/core/src/tool-substrate/tool-execution-context.ts` |
| Tool execution fast path | `packages/core/src/tool-hot-path/fast-path.ts`, `packages/core/src/tool-hot-path/shared-execution.ts`, `packages/storage/src/repos/tool-execution-record-repo.ts` |
| Tool full hot path orchestration | `packages/core/src/tool-hot-path/hot-path-full.ts`, `packages/core/src/tool-hot-path/conversation-tool-executor.ts`, `packages/core/src/tool-hot-path/tool-path-guards.ts`, `packages/core/src/tool-hot-path/fast-path.ts`, `packages/core/src/tool-hot-path/shared-execution.ts` |
| Approval and circuit breaker posture | `packages/core/src/tool-hot-path/approval-sink.ts`, `packages/core/src/tool-hot-path/circuit-breaker.ts` |
| Tool permission policy | `packages/core/src/permission-policy/permission-policy-service.ts`, `packages/core/src/permission-policy/permission-decision.ts` |
| Tool governance query | `packages/core/src/ports/tool-governance-client.ts`, `packages/soul/src/tool-governance-adapter.ts`, `packages/protocol/src/tool-governance-port.ts` |
| Node template resolution | `packages/core/src/node-template-resolver.ts`, `packages/protocol/src/node-template.ts`, `packages/protocol/src/node-instance.ts`, `packages/storage/src/repos/node-instance-repo.ts` |
| Extension descriptor registration | `packages/core/src/extension-registry-service.ts`, `packages/storage/src/repos/extension-descriptor-repo.ts`, `packages/protocol/src/soul/extension-descriptors.ts` |
| Surface drift leases | `packages/core/src/surface-drift-service.ts`, `packages/core/src/surface-binding-service.ts`, `packages/core/src/surface-service.ts`, `packages/storage/src/repos/drift-lease-repo.ts`, `packages/protocol/src/soul/surface-drift.ts` |
| Workspace bootstrapping records | `packages/core/src/workspace-service.ts`, `packages/soul/src/garden/bootstrapping-service.ts`, `packages/storage/src/repos/bootstrapping-record-repo.ts`, `packages/protocol/src/soul/bootstrapping.ts` |
| Context assembly | `packages/core/src/context-lens-assembler.ts`, `packages/core/src/manifestation-resolver.ts` |
| Auditor ports and orphan records | `packages/protocol/src/auditor-ports.ts`, `packages/soul/src/garden/auditor.ts` |
| Recall | `packages/core/src/recall-service.ts` |
| Budget bankruptcy | `packages/core/src/budget-bankruptcy-service.ts` |
| Governance lease | `packages/core/src/governance-lease-service.ts` |
| System prompt | `packages/core/src/system-prompt/template.ts`, `packages/core/src/system-prompt/workspace-context.ts` |
| Runtime test doubles | `packages/core/src/test-doubles/` |

## Daemon Paths

| Concern | Primary files |
|---|---|
| Startup and dependency wiring | `apps/core-daemon/src/index.ts` (`ConversationToolExecutor` DI, `ToolHotPathFull` injection, live A3 worker runtime wiring including `SqliteWorkerRunRepo`, `WorkerRunLifecycleService`, `RuntimeEventNormalizer`, `WorkerSafetyGate`, `ZeroDaySecurityLayer`, `IntegrationGate`, `ClaudeRuntimeAdapter`, and `SerialDelegationService`) |
| Manifestation budget pre-assembler seam | `apps/core-daemon/src/index.ts`, `apps/core-daemon/src/manifestation-context-lens-assembler.ts` |
| Principal coding-engine readiness gating | `apps/core-daemon/src/services/principal-coding-availability.ts`, `apps/core-daemon/src/services/environment-status-service.ts`, `apps/core-daemon/src/index.ts` |
| File-tool runtime validation | `apps/core-daemon/src/index.ts`, `packages/protocol/src/file-tools.ts` |
| Hono app composition | `apps/core-daemon/src/app.ts` |
| Run routes and run SSE | `apps/core-daemon/src/routes/runs.ts` |
| Worker dispatch route | `apps/core-daemon/src/routes/worker-dispatch.ts` |
| Worker dispatch Phase B safety/governance wiring | `apps/core-daemon/src/index.ts`, `apps/core-daemon/src/routes/worker-dispatch.ts`, `packages/core/src/serial-delegation-service.ts` |
| Embedding status posture | `apps/core-daemon/src/routes/embedding-status.ts`, `apps/core-daemon/src/services/embedding-status-service.ts`, `packages/protocol/src/soul/embedding-status.ts` |
| Path graph snapshotting and Librarian trend review | `apps/core-daemon/src/index.ts` (scheduler orchestration + EventLog-first persistence + same-cycle post-persist history review), `packages/soul/src/garden/path-graph-snapshotter.ts` (active-path aggregate builder + history reviewer), `packages/storage/src/repos/path-graph-snapshot-repo.ts` |
| SOUL topology query audit route | `apps/core-daemon/src/routes/soul.ts` (`GET /soul/workspaces/:workspaceId/topology` + append-only query audit), `apps/core-daemon/src/app.ts`, `apps/core-daemon/src/index.ts` |
| Workspace principal-engine config route | `apps/core-daemon/src/routes/workspaces.ts` |
| SSE broadcast manager | `apps/core-daemon/src/sse/sse-manager.ts` |
| Background intervals | `apps/core-daemon/src/background/bootstrap.ts` |
| Orphan detection SQL adapter | `apps/core-daemon/src/orphan-query.ts` |
| Handoff/gap persistence adapter | `apps/core-daemon/src/handoff-gap-adapter.ts` |
| Request protection and route middleware | `apps/core-daemon/src/middleware/error-handler.ts` |

Route files live in `apps/core-daemon/src/routes/`. Use existing route files as
the pattern for request parsing, service calls, and response shape.

## SOUL And Garden Paths

| Concern | Primary files |
|---|---|
| Candidate signal handling | `packages/soul/src/signal-handler.ts` |
| Materialization routing | `packages/soul/src/garden/materialization-router.ts` |
| Local heuristic extraction | `packages/soul/src/garden/local-heuristics.ts` |
| Garden scheduler | `packages/soul/src/garden/scheduler.ts` |
| Garden background data production adapters | `packages/storage/src/repos/garden-data-ports.ts`, `apps/core-daemon/src/index.ts` |
| Auditor | `packages/soul/src/garden/auditor.ts` |
| Janitor | `packages/soul/src/garden/janitor.ts` |
| Librarian | `packages/soul/src/garden/librarian.ts` |
| Path graph aggregate builder and history reviewer | `packages/soul/src/garden/path-graph-snapshotter.ts` |
| SOUL topology derived view | `packages/soul/src/garden/topology-service.ts`, `packages/protocol/src/soul/path-anchor-identity.ts`, `apps/core-daemon/src/services/soul-topology-audit-service.ts` |
| Degradation pipeline | `packages/soul/src/garden/degradation-pipeline.ts` |
| Session override remediation | `packages/soul/src/garden/session-override-remediation.ts` |
| Worker baseline safety projection and adapter | `packages/soul/src/worker-safety-reader.ts`, `packages/soul/src/worker-safety-adapter.ts` |

## Storage Paths

SQLite migrations live in `packages/storage/src/migrations/`. Current migration
range is `001` through `055`; `029-handoff-gap-records.sql` adds durable
handoff/gap tables, `030-handoff-gap-fk-constraints.sql` tightens their FK
behavior, `031` through `035` add the A1 runtime-foundation tables, `036`
persists nullable per-run `engine_class`, `037` persists workspace
`default_engine_class`, `038` adds deferred obligations, `039` adds dirty-state
dossiers, `040` adds strong refs, `041` rebuilds `strong_refs` with the
workspace-scoped compound-key/index shape, `042` adds path relations, `043`
adds path graph snapshots, `044` adds extension descriptors, `045` adds drift
leases, `046` adds bootstrapping records, `047` adds the drift-lease operation
uniqueness repair, `048` adds path-relation and EventLog indexes, `049`
upgrades memory FTS to trigram, `050` and `051` add the global memory source
plane, `052` adds memory embeddings, `053` adds workspace repo binding, `054`
adds tool-execution affected paths, and `055` adds the
`global_memory_recall_cache.global_object_id` index.

Repos live in `packages/storage/src/repos/`. Use these patterns:

- Repo pattern: `packages/storage/src/repos/slot-repo.ts`
- ToolSpec repo: `packages/storage/src/repos/tool-spec-repo.ts`
- Tool execution record repo: `packages/storage/src/repos/tool-execution-record-repo.ts`
- Worker run repo: `packages/storage/src/repos/worker-run-repo.ts`
- Node instance repo: `packages/storage/src/repos/node-instance-repo.ts`
- Deferred obligation repo: `packages/storage/src/repos/deferred-obligation-repo.ts`
- Dirty-state dossier repo: `packages/storage/src/repos/dirty-state-dossier-repo.ts`
- Strong ref repo: `packages/storage/src/repos/strong-ref-repo.ts`
- Path relation repo: `packages/storage/src/repos/path-relation-repo.ts`
- Path graph snapshot repo: `packages/storage/src/repos/path-graph-snapshot-repo.ts`
- Extension descriptor repo: `packages/storage/src/repos/extension-descriptor-repo.ts`
- Drift lease repo: `packages/storage/src/repos/drift-lease-repo.ts`
- Bootstrapping record repo: `packages/storage/src/repos/bootstrapping-record-repo.ts`
- Garden background data ports: `packages/storage/src/repos/garden-data-ports.ts`
- Mechanical EventLog persistence helper: `packages/storage/src/repos/shared/event-log-writer.ts`
- Deep-freeze helper: `packages/storage/src/repos/shared/deep-freeze.ts`
- Cascade deletion: `packages/storage/src/repos/cascade-delete.ts`

## Surface Paths

| Concern | Primary files |
|---|---|
| surface-runtime entrypoints | `packages/surface-runtime/src/index.ts`, `packages/surface-runtime/src/bootstrap.ts`, `packages/surface-runtime/src/normalize.ts`, `packages/surface-runtime/src/reduce.ts`, `packages/surface-runtime/src/types.ts` |
| surface-runtime reducers | `packages/surface-runtime/src/reducers/` |
| SSE transport seam | `packages/ui-sdk/src/sse-transport.ts`, `packages/ui-sdk/src/sse-client.ts` |
| Node SSE transport | `packages/ui-sdk/src/node-sse-transport.ts` |
| Workspace engine-config client calls | `packages/ui-sdk/src/client.ts` |
| Root startup CLI | `bin/do-what.mjs` |
| TUI app entry | `apps/tui/src/index.tsx` |
| TUI components | `apps/tui/src/components/`, `apps/tui/src/components/EngineSetup.tsx`, `apps/tui/src/components/WorkspaceList.tsx` |

## GUI Paths (`apps/app`, web entry surface)

| Concern | Primary files |
|---|---|
| App shell | `apps/app/src/App.tsx` |
| Design tokens | `apps/app/src/global.css` |
| Timeline | `apps/app/src/components/Timeline/` |
| Context drawer | `apps/app/src/components/ContextDrawer/` |
| Soul drawer | `apps/app/src/components/SoulDrawer/` |
| Settings | `apps/app/src/components/Settings/` |
| Run SSE hook | `apps/app/src/hooks/useRunEvents.ts` |
| Run snapshot load | `apps/app/src/hooks/useRunSnapshot.ts`, `apps/core-daemon/src/routes/runs.ts` (`GET /runs/:id/snapshot` control-plane compaction) |
| Query/data adapter seam | `apps/app/src/query/` |
| Workspace/run list query hooks | `apps/app/src/hooks/useWorkspaces.ts`, `apps/app/src/hooks/useRuns.ts` |
| Run ViewModel adapter | `apps/app/src/view-models/run.ts` |
| Soul data hook | `apps/app/src/hooks/useSoulData.ts` |
| URL selection sync | `apps/app/src/selection-url.ts` |

## Client And Provider Paths

| Concern | Primary files |
|---|---|
| HTTP client | `packages/ui-sdk/src/client.ts` |
| SSE client | `packages/ui-sdk/src/sse-client.ts`, `packages/ui-sdk/src/sse-transport.ts`, `packages/ui-sdk/src/node-sse-transport.ts` |
| Conversation provider AI SDK Core boundary | `packages/engine-gateway/src/provider/provider-registry.ts` |
| Non-streaming adapter | `packages/engine-gateway/src/provider/ai-sdk-non-streaming.ts` |
| Streaming adapter | `packages/engine-gateway/src/provider/ai-sdk-streaming.ts` |
| Conversation-engine file tools | `packages/engine-gateway/src/tools/registry.ts`, `packages/engine-gateway/src/tools/read-file-tool.ts`, `packages/engine-gateway/src/tools/list-directory-tool.ts`, `packages/engine-gateway/src/tools/search-files-tool.ts`, `packages/engine-gateway/src/tools/write-file-tool.ts`, `packages/engine-gateway/src/tools/exec-shell-tool.ts`, `packages/engine-gateway/src/tools/shared.ts` |
| Internal AI SDK helper fence | `packages/engine-gateway/src/provider/internal/ai-sdk-helpers.ts` |
| Tool definitions | `packages/engine-gateway/src/provider/ai-sdk-tools.ts` |
| Provider engine loop | `packages/engine-gateway/src/api-conversation-engine.ts` |
| MCP bridge | `packages/engine-gateway/src/mcp-bridge.ts` |
| Protocol-owned file tool schemas | `packages/protocol/src/file-tools.ts` |

The Anthropic worker runtime SDK seam is intentionally listed under Core
Runtime Paths instead of this section. Phase A3 keeps that SDK boundary inside
`packages/core`, while the main conversation-provider SDK path remains in
`packages/engine-gateway`.

## Refresh Commands

```bash
find packages/storage/src/migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n'
find apps/core-daemon/src/routes -maxdepth 1 -type f -name '*.ts' -printf '%f\n'
find packages/storage/src/repos -maxdepth 1 -type f -name '*.ts' -printf '%f\n'
rg -n "new GardenScheduler|new Janitor|new Auditor|new Librarian|orphanDetectionPort" apps/core-daemon/src/index.ts
```
