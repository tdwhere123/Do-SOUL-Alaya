import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
import {
  EngineError,
  EngineErrorKind,
  Phase0EventType,
  StreamingEventType,
  WorkspaceKind,
  type ContextLens,
  type ConversationRequest,
  type EngineBinding,
  type EngineResult,
  type MessageDeltaEvent,
  type AgentRuntimePort,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionConfig,
  type RuntimeTurnInput
} from "@do-what/protocol";
import {
  ConversationService,
  EngineBindingService,
  EventPublisher,
  GovernanceLeaseService,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import {
  bootstrapSurfaceRuntime,
  createSurfaceRuntimeState,
  reduceSurfaceRuntimeState
} from "@do-what/surface-runtime";
import { createApp } from "../app.js";
import { configureWorkspacePrincipalConversationEngine, createUnusedClaimService, createUnusedEvidenceService, createUnusedMemoryService, createUnusedProposalService, createUnusedSignalService, createUnusedSlotService, createUnusedSynthesisService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SqliteWorkspaceEngineConfigRepo } from "../services/workspace-engine-config-repo.js";
import { SseManager } from "../sse/sse-manager.js";

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly engine: MockConversationEngine;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly eventPublisher: EventPublisher;
  readonly governanceLeaseService: GovernanceLeaseService;
  readonly runHotStateService: RunHotStateService;
  readonly sseManager: SseManager;
  readonly sessionOverrideService: {
    clearRun(runId: string): void;
  };
}

interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: any;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  vi.useRealTimers();

  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("run routes", () => {
  it("creates, lists, fetches, and deletes runs for a workspace", async () => {
    const { app, eventLogRepo } = createTestContext();
    const firstWorkspace = await createWorkspace(app, "gamma");
    const secondWorkspace = await createWorkspace(app, "delta");

    const createResponse = await app.request(`/workspaces/${firstWorkspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "first run",
        goal: "exercise lifecycle",
        run_mode: "chat"
      })
    });

    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as any;
    expect(createBody).toMatchObject({
      success: true,
      data: {
        workspace_id: firstWorkspace.workspace_id,
        title: "first run",
        goal: "exercise lifecycle",
        run_mode: "chat",
        run_state: "idle",
        engine_binding_id: expect.any(String),
        current_surface_id: null
      }
    });
    const runId = createBody.data.run_id as string;
    expect(runId.startsWith("run_")).toBe(true);

    const secondRunResponse = await app.request(`/workspaces/${secondWorkspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "other run",
        goal: null,
        run_mode: "review"
      })
    });
    expect(secondRunResponse.status).toBe(201);

    const listResponse = await app.request(`/workspaces/${firstWorkspace.workspace_id}/runs`);
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as any;
    expect(listBody).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          run_id: runId,
          workspace_id: firstWorkspace.workspace_id,
          title: "first run"
        })
      ]
    });
    expect(listBody.data).toHaveLength(1);

    const getResponse = await app.request(`/runs/${runId}`);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        workspace_id: firstWorkspace.workspace_id
      }
    });

    const createEvents = await eventLogRepo.queryByRun(runId);
    expect(createEvents).toHaveLength(1);
    expect(createEvents[0]).toMatchObject({
      event_type: "run.created",
      entity_id: runId,
      workspace_id: firstWorkspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 0,
      payload_json: {
        run_id: runId,
        workspace_id: firstWorkspace.workspace_id,
        run_mode: "chat",
        title: "first run"
      }
    });

    const deleteResponse = await app.request(`/runs/${runId}`, {
      method: "DELETE"
    });
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        workspace_id: firstWorkspace.workspace_id
      }
    });

    const missingResponse = await app.request(`/runs/${runId}`);
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });

    const allEvents = await eventLogRepo.queryByRun(runId);
    expect(allEvents.map((entry) => entry.event_type)).toEqual(["run.created", "run.deleted"]);
  });

  it("inherits the workspace default_engine_class when create-run omits engine_class", async () => {
    const { app } = createTestContext({
      principalCodingEngineAvailable: true
    });
    const workspace = await createWorkspace(app, "engine-default");

    const engineConfigResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "coding_engine"
      })
    });
    expect(engineConfigResponse.status).toBe(200);

    const createResponse = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "inherited engine run"
      })
    });

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        title: "inherited engine run",
        engine_class: "coding_engine"
      }
    });
  });

  it("keeps pre-change conversation runs on their original binding id while new runs pick the rotated default", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "conversation-binding-snapshot");

    const firstCreateResponse = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "run-before-binding-rotation"
      })
    });
    expect(firstCreateResponse.status).toBe(201);
    const firstRunBody = (await firstCreateResponse.json()) as any;
    const firstRunId = firstRunBody.data.run_id as string;
    const firstBindingId = firstRunBody.data.engine_binding_id as string;
    expect(typeof firstBindingId).toBe("string");

    const rotateResponse = await app.request(`/workspaces/${workspace.workspace_id}/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_engine_class: "conversation_engine",
        conversation_binding: {
          provider_type: "custom",
          base_url: "https://proxy.example/v2",
          api_key: "sk-rotated",
          model: "proxy-model-v2",
          config: {}
        }
      })
    });
    expect(rotateResponse.status).toBe(200);

    const secondCreateResponse = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "run-after-binding-rotation"
      })
    });
    expect(secondCreateResponse.status).toBe(201);
    const secondRunBody = (await secondCreateResponse.json()) as any;
    const secondRunId = secondRunBody.data.run_id as string;
    const secondBindingId = secondRunBody.data.engine_binding_id as string;
    expect(typeof secondBindingId).toBe("string");
    expect(secondBindingId).not.toBe(firstBindingId);

    const firstRunGetResponse = await app.request(`/runs/${firstRunId}`);
    expect(firstRunGetResponse.status).toBe(200);
    await expect(firstRunGetResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: firstRunId,
        engine_class: "conversation_engine",
        engine_binding_id: firstBindingId
      }
    });

    const secondRunGetResponse = await app.request(`/runs/${secondRunId}`);
    expect(secondRunGetResponse.status).toBe(200);
    await expect(secondRunGetResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: secondRunId,
        engine_class: "conversation_engine",
        engine_binding_id: secondBindingId
      }
    });
  });

  it("rejects coding_engine run creation when principal coding is unavailable", async () => {
    const { app } = createTestContext({
      principalCodingEngineAvailable: false
    });
    const workspace = await createWorkspace(app, "coding-unavailable", {
      configurePrincipalEngine: false
    });

    const response = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "blocked coding run",
        engine_class: "coding_engine"
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Request conflict"
    });
  });

  it("returns run snapshots and updates hot state after run events", async () => {
    const { app, eventPublisher } = createTestContext();
    const workspace = await createWorkspace(app, "snapshot");

    const createRunResponse = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "snapshot run",
        goal: "check hot state",
        run_mode: "chat"
      })
    });
    const runBody = (await createRunResponse.json()) as any;
    const runId = runBody.data.run_id as string;

    const initialSnapshot = await app.request(`/runs/${runId}/snapshot`);
    expect(initialSnapshot.status).toBe(200);
    await expect(initialSnapshot.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        run_state: "idle",
        active_surface_id: null,
        last_message_at: null,
        engine_status: "idle",
        bootstrap_control_plane_cutoff_event_id: null,
        surface_state: {}
      }
    });

    const event = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "hello",
        message_id: "msg_snapshot"
      }
    });

    const updatedSnapshot = await app.request(`/runs/${runId}/snapshot`);
    expect(updatedSnapshot.status).toBe(200);
    await expect(updatedSnapshot.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        run_state: "active",
        engine_status: "streaming",
        last_message_at: event.created_at,
        bootstrap_control_plane_cutoff_event_id: null,
        surface_state: {}
      }
    });
  });

  it("rehydrates last_message_at from EventLog after a cold start", async () => {
    const { app, database, eventLogRepo, eventPublisher } = createTestContext();
    const workspace = await createWorkspace(app, "rehydrate");
    const runId = await createRun(app, workspace.workspace_id, "rehydrate run");

    const published = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "hydrate me",
        message_id: "msg_rehydrate"
      }
    });

    const restartedRunHotStateService = new RunHotStateService({
      runRepo: new SqliteRunRepo(database),
      eventLogRepo
    });

    await expect(restartedRunHotStateService.getSnapshot(runId)).resolves.toMatchObject({
      run_id: runId,
      run_state: "idle",
      engine_status: "idle",
      last_message_at: published.created_at
    });
  });

  it("returns 404 for snapshots of missing runs", async () => {
    const { app } = createTestContext();

    const response = await app.request("/runs/run_missing/snapshot");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns a compacted surface snapshot payload with the last contributing control-plane cutoff", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "snapshot-bootstrap");
    const runId = await createRun(app, workspace.workspace_id, "bootstrap run");

    await eventLogRepo.append({
      event_type: "run.message.appended",
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      payload_json: {
        run_id: runId,
        role: "user",
        content: "ignored timeline event",
        message_id: "msg-ignored"
      }
    });
    const workerStateChanged = await eventLogRepo.append({
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        workerId: "worker-1",
        state: "active",
        previousState: "init"
      }
    });
    await eventLogRepo.append({
      event_type: "worker.integration_status",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        workerRunId: "worker-1",
        level: "soft_stale",
        reason: "supports_interrupt mismatch",
        detectedAt: "2026-04-14T00:00:02.000Z"
      }
    });
    await eventLogRepo.append({
      event_type: "tool_call.started",
      entity_type: "tool_call",
      entity_id: "tool-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-1",
        workerId: "worker-1",
        toolId: "tools.read_file",
        inputSummary: "read notes-a.md"
      }
    });
    const firstToolCompleted = await eventLogRepo.append({
      event_type: "tool_call.completed",
      entity_type: "tool_call",
      entity_id: "tool-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-1",
        statusKind: "success",
        outputSummary: "notes-a",
        durationMs: 17
      }
    });
    await eventLogRepo.append({
      event_type: "tool_call.started",
      entity_type: "tool_call",
      entity_id: "tool-2",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-2",
        workerId: "worker-1",
        toolId: "tools.read_file",
        inputSummary: "read notes-b.md"
      }
    });
    const secondToolCompleted = await eventLogRepo.append({
      event_type: "tool_call.completed",
      entity_type: "tool_call",
      entity_id: "tool-2",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-2",
        statusKind: "success",
        outputSummary: "notes-b",
        durationMs: 19
      }
    });
    await eventLogRepo.append({
      event_type: "tool_call.started",
      entity_type: "tool_call",
      entity_id: "tool-3",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-3",
        workerId: "worker-1",
        toolId: "tools.read_file",
        inputSummary: "read notes-c.md"
      }
    });
    const toolCompleted = await eventLogRepo.append({
      event_type: "tool_call.completed",
      entity_type: "tool_call",
      entity_id: "tool-3",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-3",
        statusKind: "success",
        outputSummary: "notes-c",
        durationMs: 23
      }
    });
    await eventLogRepo.append({
      event_type: "output.shaping_applied",
      entity_type: "output_shaping",
      entity_id: "shape-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "engine",
      payload_json: {
        shaping_id: "shape-1",
        command_class: "file_read",
        original_count: 3,
        compressed_to: 1,
        compression_mode: "count_summary",
        original_event_ids: [
          firstToolCompleted.event_id,
          secondToolCompleted.event_id,
          toolCompleted.event_id
        ],
        shaped_at: "2026-04-14T00:00:02.500Z"
      }
    });
    const compressionBatch = await eventLogRepo.append({
      event_type: "output.command_compressed",
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "engine",
      payload_json: {
        workspace_id: workspace.workspace_id,
        run_id: runId,
        total_original: 3,
        total_after_shaping: 1,
        compression_ratio: 1 / 3,
        compressed_at: "2026-04-14T00:00:03.000Z"
      }
    });
    await eventLogRepo.append({
      event_type: "governance_spam_fault",
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        runId: runId,
        nodeId: "node-1",
        faultSummary: "too many approvals"
      }
    });
    await eventLogRepo.append({
      event_type: "soul.approval_requested",
      entity_type: "approval",
      entity_id: "approval-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        message_id: "approval-msg-1",
        approval_id: "approval-1",
        description: "Approve file write",
        risk_level: "high",
        run_id: runId
      }
    });
    const approvalResolved = await eventLogRepo.append({
      event_type: "soul.approval_resolved",
      entity_type: "approval",
      entity_id: "approval-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      payload_json: {
        message_id: "approval-msg-1",
        approval_id: "approval-1",
        description: "Approve file write",
        result: "approved",
        resolved_at: "2026-04-14T00:00:03.000Z",
        risk_level: "high",
        run_id: runId
      }
    });
    const ignoredCompletion = await eventLogRepo.append({
      event_type: "message.completed",
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        type: "message.completed",
        runId: runId,
        messageId: "msg-completed",
        content: "ignored completion event",
        finishReason: "stop",
        timestamp: "2026-04-14T00:00:04.000Z"
      }
    });

    const response = await app.request(`/runs/${runId}/snapshot`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        bootstrap_control_plane_cutoff_event_id: approvalResolved.event_id,
        surface_state: {
          workers: [
            {
              worker_id: "worker-1",
              status: "active"
            }
          ],
          worker_integration_statuses: [
            {
              workerRunId: "worker-1",
              level: "soft_stale",
              reason: "supports_interrupt mismatch",
              detectedAt: "2026-04-14T00:00:02.000Z"
            }
          ],
          tools: [
            {
              tool_call_id: "tool-3",
              worker_id: "worker-1",
              tool_id: "tools.read_file",
              input_summary: "3 file_read outputs compressed",
              status_kind: "success",
              output_summary: "3 file_read outputs compressed",
              duration_ms: 59
            }
          ],
          governance_fault: {
            runId: runId,
            nodeId: "node-1",
            faultSummary: "too many approvals"
          },
          approvals: [
            {
              approval_id: "approval-1",
              message_id: "approval-msg-1",
              description: "Approve file write",
              run_id: runId,
              risk_level: "high",
              status: "approved",
              resolved_at: "2026-04-14T00:00:03.000Z"
            }
          ]
        }
      }
    });
    expect(compressionBatch.event_id).not.toBe(toolCompleted.event_id);
    expect(workerStateChanged.event_id).not.toBe(ignoredCompletion.event_id);
  });

  it("preserves an in-flight started tool row in the reconnect snapshot", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "snapshot-in-flight-tool");
    const runId = await createRun(app, workspace.workspace_id, "in-flight tool snapshot");

    const startedEntry = await eventLogRepo.append({
      event_type: "tool_call.started",
      entity_type: "tool_call",
      entity_id: "tool-in-flight",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-in-flight",
        workerId: "worker-1",
        toolId: "tools.read_file",
        inputSummary: "read package.json"
      }
    });

    const response = await app.request(`/runs/${runId}/snapshot`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        bootstrap_control_plane_cutoff_event_id: startedEntry.event_id,
        surface_state: {
          tools: [
            {
              tool_call_id: "tool-in-flight",
              worker_id: "worker-1",
              tool_id: "tools.read_file",
              input_summary: "read package.json",
              status_kind: "running",
              output_summary: null,
              duration_ms: null
            }
          ]
        }
      }
    });
  });

  it("fails open to pass-through completed tool state when the Phase C batch event is missing", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "snapshot-fail-open-tools");
    const runId = await createRun(app, workspace.workspace_id, "fail-open tool snapshot");

    await eventLogRepo.append({
      event_type: "tool_call.started",
      entity_type: "tool_call",
      entity_id: "tool-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-1",
        workerId: "worker-1",
        toolId: "tools.read_file",
        inputSummary: "read README.md"
      }
    });
    await eventLogRepo.append({
      event_type: "tool_call.completed",
      entity_type: "tool_call",
      entity_id: "tool-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-1",
        statusKind: "success",
        outputSummary: "README contents",
        durationMs: 11
      }
    });
    const assistantCompletion = await eventLogRepo.append({
      event_type: "message.completed",
      entity_type: "message",
      entity_id: "msg-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "engine",
      payload_json: {
        type: "message.completed",
        runId: runId,
        messageId: "msg-1",
        content: "done",
        finishReason: "stop",
        timestamp: "2026-04-17T00:00:04.000Z"
      }
    });

    const response = await app.request(`/runs/${runId}/snapshot`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        bootstrap_control_plane_cutoff_event_id: assistantCompletion.event_id,
        surface_state: {
          tools: [
            {
              tool_call_id: "tool-1",
              worker_id: "worker-1",
              tool_id: "tools.read_file",
              input_summary: "read README.md",
              status_kind: "success",
              output_summary: "README contents",
              duration_ms: 11
            }
          ]
        }
      }
    });
  });

  it("reconnects after output.shaping_applied and still ends in the compressed state when the batch lands later", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "snapshot-reconnect-shaped-gap");
    const runId = await createRun(app, workspace.workspace_id, "reconnect shaped gap");

    const firstStarted = await eventLogRepo.append({
      event_type: "tool_call.started",
      entity_type: "tool_call",
      entity_id: "tool-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-1",
        workerId: "worker-1",
        toolId: "tools.read_file",
        inputSummary: "read a.ts"
      }
    });
    const firstCompleted = await eventLogRepo.append({
      event_type: "tool_call.completed",
      entity_type: "tool_call",
      entity_id: "tool-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-1",
        statusKind: "success",
        outputSummary: "a.ts",
        durationMs: 10
      }
    });
    await eventLogRepo.append({
      event_type: "tool_call.started",
      entity_type: "tool_call",
      entity_id: "tool-2",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-2",
        workerId: "worker-1",
        toolId: "tools.read_file",
        inputSummary: "read b.ts"
      }
    });
    const secondCompleted = await eventLogRepo.append({
      event_type: "tool_call.completed",
      entity_type: "tool_call",
      entity_id: "tool-2",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        toolCallId: "tool-2",
        statusKind: "success",
        outputSummary: "b.ts",
        durationMs: 12
      }
    });
    await eventLogRepo.append({
      event_type: "message.completed",
      entity_type: "message",
      entity_id: "msg-gap",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "engine",
      payload_json: {
        type: "message.completed",
        runId: runId,
        messageId: "msg-gap",
        content: "done",
        finishReason: "stop",
        timestamp: "2026-04-17T00:00:04.000Z"
      }
    });
    await eventLogRepo.append({
      event_type: "output.shaping_applied",
      entity_type: "output_shaping",
      entity_id: "shape-gap",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "engine",
      payload_json: {
        shaping_id: "shape-gap",
        command_class: "file_read",
        original_count: 2,
        compressed_to: 1,
        compression_mode: "count_summary",
        original_event_ids: [firstCompleted.event_id, secondCompleted.event_id],
        shaped_at: "2026-04-17T00:00:05.000Z"
      }
    });

    const snapshotResponse = await app.request(`/runs/${runId}/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    const snapshotBody = (await snapshotResponse.json()) as {
      readonly success: true;
      readonly data: import("@do-what/protocol").RunSnapshot;
    };
    expect(snapshotBody.data.bootstrap_control_plane_cutoff_event_id).toBe(firstStarted.event_id);

    let state = createSurfaceRuntimeState();
    state = reduceSurfaceRuntimeState(state, {
      id: firstCompleted.event_id,
      type: "tool_call.completed",
      data: {
        toolCallId: "tool-1",
        statusKind: "success",
        outputSummary: "a.ts",
        durationMs: 10
      }
    });
    state = reduceSurfaceRuntimeState(state, {
      type: "tool_call.started",
      data: {
        toolCallId: "tool-2",
        workerId: "worker-1",
        toolId: "tools.read_file",
        inputSummary: "read b.ts"
      }
    });
    state = reduceSurfaceRuntimeState(state, {
      id: secondCompleted.event_id,
      type: "tool_call.completed",
      data: {
        toolCallId: "tool-2",
        statusKind: "success",
        outputSummary: "b.ts",
        durationMs: 12
      }
    });
    state = reduceSurfaceRuntimeState(state, {
      type: "message.completed",
      data: {
        type: "message.completed",
        runId: runId,
        messageId: "msg-gap",
        content: "done",
        finishReason: "stop",
        timestamp: "2026-04-17T00:00:04.000Z"
      }
    });
    state = reduceSurfaceRuntimeState(state, {
      type: "output.shaping_applied",
      data: {
        shaping_id: "shape-gap",
        command_class: "file_read",
        original_count: 2,
        compressed_to: 1,
        compression_mode: "count_summary",
        original_event_ids: [firstCompleted.event_id, secondCompleted.event_id],
        shaped_at: "2026-04-17T00:00:05.000Z"
      }
    });

    state = bootstrapSurfaceRuntime(state, {
      messages: [],
      runSnapshot: snapshotBody.data
    });
    state = reduceSurfaceRuntimeState(state, {
      type: "output.command_compressed",
      data: {
        workspace_id: workspace.workspace_id,
        run_id: runId,
        total_original: 2,
        total_after_shaping: 1,
        compression_ratio: 0.5,
        compressed_at: "2026-04-17T00:00:06.000Z"
      }
    });

    expect(Object.keys(state.tools)).toEqual(["tool-2"]);
    expect(state.tools["tool-2"]).toMatchObject({
      toolCallId: "tool-2",
      toolId: "tools.read_file",
      statusKind: "success",
      inputSummary: "2 file_read outputs compressed",
      outputSummary: "2 file_read outputs compressed",
      durationMs: 22
    });
  });

  it("fails the snapshot route when compaction encounters malformed control-plane payloads", async () => {
    const { app, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "snapshot-malformed-control-plane");
    const runId = await createRun(app, workspace.workspace_id, "malformed control plane run");

    await eventLogRepo.append({
      event_type: "worker.state_changed",
      entity_type: "worker_run",
      entity_id: "worker-1",
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "system",
      payload_json: {
        workerId: "worker-1",
        state: "not-a-real-state",
        previousState: "init"
      }
    });

    const response = await app.request(`/runs/${runId}/snapshot`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("snapshot")
    });
  });

  it("fails the snapshot route when control-plane compaction wiring is unavailable", async () => {
    const { app } = createTestContext({ disableSnapshotCompaction: true });
    const workspace = await createWorkspace(app, "snapshot-compaction-wiring-missing");
    const runId = await createRun(app, workspace.workspace_id, "snapshot wiring missing");

    const response = await app.request(`/runs/${runId}/snapshot`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("snapshot")
    });
  });

  it("streams run events over SSE and cleans up connections on disconnect", async () => {
    const { app, eventPublisher, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "sse");
    const runId = await createRun(app, workspace.workspace_id, "sse run");

    const streamResponse = await app.request(`/runs/${runId}/events`);
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

    const stream = createSseClient(streamResponse);
    const connected = await stream.readEvent();
    const connectionId = connected.data.connection_id as string;
    expect(connected.event).toBe("connected");
    expect(connected.data).toMatchObject({ run_id: runId, connection_id: connectionId });
    expect(sseManager.connectionCount(runId)).toBe(1);

    const emitted = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "stream me",
        message_id: "msg_stream_1"
      }
    });

    const pushed = await stream.readEvent();
    expect(pushed).toMatchObject({
      id: emitted.event_id,
      event: "run.message.appended",
      data: {
        run_id: runId,
        message_id: "msg_stream_1"
      }
    });

    await stream.close();
    // Normal client disconnect is silently swallowed; verify cleanup via connectionCount.
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
    expect(sseManager.connectionCount(runId)).toBe(0);
  });

  it("replays events after Last-Event-ID on reconnect", async () => {
    const { app, eventPublisher, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "replay");
    const runId = await createRun(app, workspace.workspace_id, "replay run");

    const firstConnection = createSseClient(await app.request(`/runs/${runId}/events`));
    await firstConnection.readEvent();

    const event1 = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "first",
        message_id: "msg_replay_1"
      }
    });
    const event2 = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 2,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "second",
        message_id: "msg_replay_2"
      }
    });
    const event3 = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 3,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "third",
        message_id: "msg_replay_3"
      }
    });

    const streamed1 = await firstConnection.readEvent();
    const streamed2 = await firstConnection.readEvent();
    const streamed3 = await firstConnection.readEvent();
    expect(streamed1.id).toBe(event1.event_id);
    expect(streamed2.id).toBe(event2.event_id);
    expect(streamed3.id).toBe(event3.event_id);

    await firstConnection.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);

    const secondConnection = createSseClient(
      await app.request(`/runs/${runId}/events`, {
        headers: {
          "Last-Event-ID": event2.event_id
        }
      })
    );
    await secondConnection.readEvent();
    const replayed = await secondConnection.readEvent();
    expect(replayed.id).toBe(event3.event_id);
    expect(replayed.data).toMatchObject({
      run_id: runId,
      message_id: "msg_replay_3"
    });

    await secondConnection.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });

  it("broadcasts events to concurrent SSE subscribers", async () => {
    const { app, eventPublisher, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "fanout");
    const runId = await createRun(app, workspace.workspace_id, "fanout run");

    const streamA = createSseClient(await app.request(`/runs/${runId}/events`));
    const streamB = createSseClient(await app.request(`/runs/${runId}/events`));

    await streamA.readEvent();
    await streamB.readEvent();
    expect(sseManager.connectionCount(runId)).toBe(2);

    const firstBroadcast = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "to all clients",
        message_id: "msg_fanout_1"
      }
    });

    const eventA = await streamA.readEvent();
    const eventB = await streamB.readEvent();
    expect(eventA.id).toBe(firstBroadcast.event_id);
    expect(eventB.id).toBe(firstBroadcast.event_id);

    await streamA.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 1);

    const secondBroadcast = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 2,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "only one client left",
        message_id: "msg_fanout_2"
      }
    });

    const remainingEvent = await streamB.readEvent();
    expect(remainingEvent.id).toBe(secondBroadcast.event_id);

    await streamB.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });

  it("keeps EventLog and RunHotState consistent after event publishing", async () => {
    const { app, eventLogRepo, eventPublisher, runHotStateService } = createTestContext();
    const workspace = await createWorkspace(app, "consistency");
    const runId = await createRun(app, workspace.workspace_id, "consistency run");

    const published = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: {
        run_id: runId,
        role: "user",
        content: "sync check",
        message_id: "msg_sync"
      }
    });

    const events = await eventLogRepo.queryByRun(runId);
    const snapshot = await runHotStateService.getSnapshot(runId);

    expect(events.some((event) => event.event_id === published.event_id)).toBe(true);
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      run_id: runId,
      run_state: "active",
      engine_status: "streaming",
      last_message_at: published.created_at,
      updated_at: published.created_at
    });
  });

  it("returns 404 when listing runs for a missing workspace", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing/runs");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("clears session override cache when deleting a run", async () => {
    const sessionOverrideService = {
      clearRun: vi.fn()
    };
    const { app } = createTestContext({ sessionOverrideService });
    const workspace = await createWorkspace(app, "clear-session-overrides");
    const runId = await createRun(app, workspace.workspace_id, "cleanup run");

    const response = await app.request(`/runs/${runId}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(sessionOverrideService.clearRun).toHaveBeenCalledWith(runId);
  });

  it("clears in-process state even when lease release fails during run deletion", async () => {
    const sessionOverrideService = {
      clearRun: vi.fn()
    };
    const budgetBankruptcyService = {
      clearRun: vi.fn()
    };
    const contextLensAssembler = {
      clearLens: vi.fn()
    };
    const { app, governanceLeaseService } = createTestContext({
      sessionOverrideService,
      budgetBankruptcyService,
      contextLensAssembler
    });
    const releaseError = new Error("event log unavailable");
    vi.spyOn(governanceLeaseService, "release").mockRejectedValue(releaseError);
    const workspace = await createWorkspace(app, "delete-run-cleanup");
    const runId = await createRun(app, workspace.workspace_id, "cleanup run");

    const response = await app.request(`/runs/${runId}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(sessionOverrideService.clearRun).toHaveBeenCalledWith(runId);
    expect(budgetBankruptcyService.clearRun).toHaveBeenCalledWith(runId);
    expect(contextLensAssembler.clearLens).toHaveBeenCalledWith(runId);
    expect(governanceLeaseService.release).toHaveBeenCalledWith(runId);
    await expect(app.request(`/runs/${runId}`)).resolves.toMatchObject({
      status: 404
    });
  });

  it("returns 404 when creating a run for a missing workspace", async () => {
    const { app } = createTestContext();

    const response = await app.request("/workspaces/ws_missing/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "missing workspace",
        goal: null,
        run_mode: "chat"
      })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("preserves a provided non-empty title", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "epsilon-provided-title");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Preserved Title",
        run_mode: "chat"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        run_mode: "chat",
        title: "Preserved Title"
      }
    });
  });

  it("creates a run with a local-time formatted auto-generated title", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 5, 6, 7, 8, 0));

    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "epsilon-local-title");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        goal: null,
        run_mode: "chat",
        title: "Run 2026-04-05 06:07"
      }
    });
  });

  it("creates a run with default title and chat mode when payload is empty", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "epsilon");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        goal: null,
        run_mode: "chat",
        title: expect.stringMatching(/^Run \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      }
    });
  });

  it("creates a run with default title and chat mode when only goal is provided", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "epsilon-goal-only");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "goal only payload"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        goal: "goal only payload",
        run_mode: "chat",
        title: expect.stringMatching(/^Run \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      }
    });
  });

  it("uses the auto-generated title when title is whitespace only", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "epsilon-whitespace-title");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "   ",
        run_mode: "chat"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        run_mode: "chat",
        title: expect.stringMatching(/^Run \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      }
    });
  });

  it("rejects invalid run payloads with a 400 envelope", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "epsilon-invalid");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        run_mode: "invalid-mode"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request body"
    });
  });

  it("records the full four-event lifecycle in order", async () => {
    const { app, database } = createTestContext();
    const workspace = await createWorkspace(app, "zeta");

    const createRunResponse = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "full flow",
        goal: "verify event ordering",
        run_mode: "chat"
      })
    });
    const runBody = (await createRunResponse.json()) as any;

    const runId = runBody.data.run_id as string;

    const deleteRunResponse = await app.request(`/runs/${runId}`, { method: "DELETE" });
    expect(deleteRunResponse.status).toBe(200);

    const deleteWorkspaceResponse = await app.request(`/workspaces/${workspace.workspace_id}`, {
      method: "DELETE"
    });
    expect(deleteWorkspaceResponse.status).toBe(200);

    const orderedEvents = database.connection
      .prepare("SELECT event_type, entity_id FROM event_log ORDER BY created_at ASC, rowid ASC")
      .all() as Array<{ readonly event_type: string; readonly entity_id: string }>;

    expect(orderedEvents).toEqual([
      { event_type: "workspace.created", entity_id: workspace.workspace_id },
      { event_type: "workspace.engine_binding.updated", entity_id: workspace.workspace_id },
      { event_type: "workspace.default_engine_class.updated", entity_id: workspace.workspace_id },
      { event_type: "run.created", entity_id: runId },
      { event_type: "run.deleted", entity_id: runId },
      { event_type: "workspace.deleted", entity_id: workspace.workspace_id }
    ]);
  });

  it("lists persisted run messages rebuilt from EventLog", async () => {
    const { app, engine } = createTestContext();
    const workspace = await createWorkspace(app, "message-history");
    const runId = await createRun(app, workspace.workspace_id, "history run");

    engine.setHandler(async () => ({
      message: {
        role: "assistant",
        content: "history reply",
        message_id: "msg_assistant_history"
      },
      finish_reason: "stop"
    }));

    const sendResponse = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "show history" })
    });
    expect(sendResponse.status).toBe(200);
    const sendBody = (await sendResponse.json()) as any;

    const messagesResponse = await app.request(`/runs/${runId}/messages`);
    expect(messagesResponse.status).toBe(200);
    await expect(messagesResponse.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          message_id: sendBody.data.user_message_id,
          role: "user",
          content: "show history"
        },
        {
          message_id: "msg_assistant_history",
          role: "assistant",
          content: "history reply"
        }
      ]
    });
  });
  it("posts a user message, returns the assistant response, and pushes both SSE events in order", async () => {
    const { app, engine, eventLogRepo, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "chat-flow");
    const runId = await createRun(app, workspace.workspace_id, "chat run");

    engine.setHandler(async () => ({
      message: {
        role: "assistant",
        content: "Hello back",
        message_id: "msg_assistant_1"
      },
      finish_reason: "stop"
    }));

    const stream = createSseClient(await app.request(`/runs/${runId}/events`));
    await stream.readEvent();

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Hello" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        assistant_message_id: "msg_assistant_1",
        content: "Hello back",
        finish_reason: "stop"
      }
    });

    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0]).toMatchObject({
      messages: [{ role: "user", content: "Hello" }],
      contextLens: null
    });

    const pushedUser = await stream.readEvent();
    const pushedAssistant = await stream.readEvent();
    expect(pushedUser).toMatchObject({
      event: "run.message.appended",
      data: {
        run_id: runId,
        role: "user",
        content: "Hello"
      }
    });
    expect(pushedAssistant).toMatchObject({
      event: "engine.response.received",
      data: {
        run_id: runId,
        message_id: "msg_assistant_1",
        content: "Hello back",
        finish_reason: "stop"
      }
    });

    const messageEvents = (await eventLogRepo.queryByRun(runId)).filter((event) =>
      event.event_type === "run.message.appended" || event.event_type === "engine.response.received"
    );
    expect(messageEvents.map((event) => event.event_type)).toEqual([
      "run.message.appended",
      "engine.response.received"
    ]);

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });

  it("posts a streaming message and pushes message.delta and message.completed over run SSE", async () => {
    const streamMessage = vi.fn((_request: ConversationRequest) =>
      mockRouteStreamProvider(["streamed ", "reply"])
    );
    const { app, eventLogRepo, sseManager } = createTestContext({ streamMessage });
    const workspace = await createWorkspace(app, "streaming-route");
    const runId = await createRun(app, workspace.workspace_id, "streaming route run");

    const stream = createSseClient(await app.request(`/runs/${runId}/events`));
    await stream.readEvent();

    const response = await app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Hello stream" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        content: "streamed reply",
        finish_reason: "stop"
      }
    });
    expect(streamMessage).toHaveBeenCalledTimes(1);

    const pushedUser = await stream.readEvent();
    const firstDelta = await stream.readEvent();
    const secondDelta = await stream.readEvent();
    const completed = await stream.readEvent();

    expect(pushedUser.event).toBe(Phase0EventType.RUN_MESSAGE_APPENDED);
    expect(firstDelta).toMatchObject({
      event: StreamingEventType.MESSAGE_DELTA,
      data: {
        runId,
        delta: "streamed ",
        index: 0
      }
    });
    expect(secondDelta).toMatchObject({
      event: StreamingEventType.MESSAGE_DELTA,
      data: {
        runId,
        delta: "reply",
        index: 1
      }
    });
    expect(completed).toMatchObject({
      event: StreamingEventType.MESSAGE_COMPLETED,
      data: {
        runId,
        content: "streamed reply",
        finishReason: "stop"
      }
    });
    const completedEntry = (await eventLogRepo.queryByRun(runId)).findLast(
      (event) => event.event_type === StreamingEventType.MESSAGE_COMPLETED
    );
    expect(completedEntry).toBeDefined();

    const snapshot = await app.request(`/runs/${runId}/snapshot`);
    await expect(snapshot.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        engine_status: "idle",
        last_message_at: completedEntry?.created_at
      }
    });

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });

  it("interrupts the active coding runtime session through the daemon route", async () => {
    const promptStarted = createDeferred<void>();
    const promptReleased = createDeferred<void>();
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const runtimeAdapter = createRouteRuntimeAdapter({
      handlers,
      prompt: async () => {
        promptStarted.resolve();
        await promptReleased.promise;
      },
      cancel: async (sessionId) => {
        for (const handler of handlers) {
          handler({
            type: "session_finished",
            session_id: sessionId,
            emitted_at: "2026-04-24T00:00:00.000Z",
            status: "cancelled",
            result_summary: "cancelled by route test"
          });
        }
        promptReleased.resolve();
        return {
          session_id: sessionId,
          status: "cancelled"
        };
      }
    });
    const { app } = createTestContext({ runtimeAdapter });
    const workspace = await createWorkspace(app, "interrupt-route");
    const runId = await createCodingRun(app, workspace.workspace_id, "coding interrupt run");

    const sendPromise = app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "please keep working" })
    });
    await promptStarted.promise;

    const response = await app.request(`/runs/${runId}/interrupt`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        status: "cancelled"
      }
    });
    await expect(sendPromise).resolves.toMatchObject({ status: 200 });
  });

  it("accepts an interrupt while the coding runtime session is still registering", async () => {
    const createSessionStarted = createDeferred<void>();
    const createSessionReleased = createDeferred<void>();
    const runtimeAdapter = createRouteRuntimeAdapter({
      createSession: async () => {
        createSessionStarted.resolve();
        await createSessionReleased.promise;
        return { session_id: "startup-runtime-session" };
      },
      prompt: async () => {
        throw new Error("prompt must not be called after a pending startup interrupt");
      },
      cancel: async (sessionId) => ({
        session_id: sessionId,
        status: "cancelled"
      })
    });
    const { app } = createTestContext({ runtimeAdapter });
    const workspace = await createWorkspace(app, "interrupt-startup");
    const runId = await createCodingRun(app, workspace.workspace_id, "startup interrupt run");

    const sendPromise = app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start and wait" })
    });
    await createSessionStarted.promise;

    const response = await app.request(`/runs/${runId}/interrupt`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        status: "cancelled"
      }
    });

    createSessionReleased.resolve();

    const sendResponse = await sendPromise;
    expect(sendResponse.status).toBe(200);
    await expect(sendResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        content: "",
        finish_reason: "error"
      }
    });
    expect(runtimeAdapter.cancel).toHaveBeenCalledWith("startup-runtime-session");
    expect(runtimeAdapter.prompt).not.toHaveBeenCalled();
  });

  it("reports unsupported when a non-interruptable coding runtime is still registering", async () => {
    const createSessionStarted = createDeferred<void>();
    const createSessionReleased = createDeferred<void>();
    const promptStarted = createDeferred<void>();
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const runtimeAdapter = createRouteRuntimeAdapter({
      handlers,
      capabilities: {
        supports_resume: false,
        supports_interrupt: false,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: false,
        supports_terminal_events: false
      },
      createSession: async () => {
        createSessionStarted.resolve();
        await createSessionReleased.promise;
        return { session_id: "unsupported-startup-session" };
      },
      prompt: async (sessionId) => {
        promptStarted.resolve();
        for (const handler of handlers) {
          handler({
            type: "session_finished",
            session_id: sessionId,
            emitted_at: "2026-04-24T00:00:00.000Z",
            status: "completed",
            result_summary: "completed after unsupported interrupt"
          });
        }
      }
    });
    const { app } = createTestContext({ runtimeAdapter });
    const workspace = await createWorkspace(app, "interrupt-startup-unsupported");
    const runId = await createCodingRun(app, workspace.workspace_id, "startup unsupported interrupt run");

    const sendPromise = app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start unsupported and wait" })
    });
    await createSessionStarted.promise;

    const response = await app.request(`/runs/${runId}/interrupt`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        status: "unsupported"
      }
    });

    createSessionReleased.resolve();
    await promptStarted.promise;
    const sendResponse = await sendPromise;
    expect(sendResponse.status).toBe(200);
    await expect(sendResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        content: "",
        finish_reason: "stop"
      }
    });
    expect(runtimeAdapter.cancel).not.toHaveBeenCalled();
    expect(runtimeAdapter.prompt).toHaveBeenCalledWith(
      "unsupported-startup-session",
      expect.objectContaining({ prompt: expect.any(String) })
    );
  });

  it("returns no_active when the run has no active runtime session", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "interrupt-no-active");
    const runId = await createCodingRun(app, workspace.workspace_id, "idle coding run");

    const response = await app.request(`/runs/${runId}/interrupt`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        status: "no_active"
      }
    });
  });

  it("returns unsupported when the active runtime does not support interrupts", async () => {
    const promptStarted = createDeferred<void>();
    const promptReleased = createDeferred<void>();
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const runtimeAdapter = createRouteRuntimeAdapter({
      handlers,
      capabilities: {
        supports_resume: false,
        supports_interrupt: false,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: false,
        supports_terminal_events: false
      },
      prompt: async () => {
        promptStarted.resolve();
        await promptReleased.promise;
      },
      cancel: async () => {
        throw new Error("cancel must not be called for unsupported runtimes");
      }
    });
    const { app } = createTestContext({ runtimeAdapter });
    const workspace = await createWorkspace(app, "interrupt-unsupported");
    const runId = await createCodingRun(app, workspace.workspace_id, "unsupported coding run");

    void app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start runtime" })
    });
    await promptStarted.promise;

    const response = await app.request(`/runs/${runId}/interrupt`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        status: "unsupported"
      }
    });

    for (const handler of handlers) {
      handler({
        type: "session_finished",
        session_id: "route-runtime-session",
        emitted_at: "2026-04-24T00:00:00.000Z",
        status: "completed",
        result_summary: "done"
      });
    }
    promptReleased.resolve();
  });

  it("returns a sanitized public interrupt failure message", async () => {
    const promptStarted = createDeferred<void>();
    const promptReleased = createDeferred<void>();
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const runtimeAdapter = createRouteRuntimeAdapter({
      handlers,
      prompt: async () => {
        promptStarted.resolve();
        await promptReleased.promise;
      },
      cancel: async () => {
        throw new Error("secret path /tmp/provider-token");
      }
    });
    const { app } = createTestContext({ runtimeAdapter });
    const workspace = await createWorkspace(app, "interrupt-sanitized");
    const runId = await createCodingRun(app, workspace.workspace_id, "sanitized interrupt run");

    const sendPromise = app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start runtime" })
    });
    await promptStarted.promise;

    const response = await app.request(`/runs/${runId}/interrupt`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        status: "failed",
        message: "Run interrupt failed."
      }
    });

    for (const handler of handlers) {
      handler({
        type: "session_finished",
        session_id: "route-runtime-session",
        emitted_at: "2026-04-24T00:00:00.000Z",
        status: "failed",
        result_summary: "done"
      });
    }
    promptReleased.resolve();
    await expect(sendPromise).resolves.toMatchObject({ status: 200 });
  });

  it("returns unsupported while a conversation-engine stream is active", async () => {
    const streamStarted = createDeferred<void>();
    const streamReleased = createDeferred<void>();
    const streamMessage = vi.fn(async function* (_request: ConversationRequest) {
      streamStarted.resolve();
      await streamReleased.promise;
      yield {
        type: "message.delta",
        runId: "run-route-test",
        messageId: "msg-placeholder",
        delta: "done",
        index: 0,
        finishReason: "stop",
        timestamp: new Date().toISOString()
      } satisfies MessageDeltaEvent;
    });
    const { app } = createTestContext({ streamMessage });
    const workspace = await createWorkspace(app, "interrupt-conversation-stream");
    const runId = await createRun(app, workspace.workspace_id, "active conversation run");

    const sendPromise = app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "start conversation stream" })
    });
    await streamStarted.promise;

    const response = await app.request(`/runs/${runId}/interrupt`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        status: "unsupported"
      }
    });

    streamReleased.resolve();
    await expect(sendPromise).resolves.toMatchObject({ status: 200 });
  });

  it("rejects concurrent same-run coding streams before appending another turn", async () => {
    const promptStarted = createDeferred<void>();
    const promptReleased = createDeferred<void>();
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const runtimeAdapter = createRouteRuntimeAdapter({
      handlers,
      prompt: async () => {
        promptStarted.resolve();
        await promptReleased.promise;
      }
    });
    const { app } = createTestContext({ runtimeAdapter });
    const workspace = await createWorkspace(app, "stream-conflict-coding");
    const runId = await createCodingRun(app, workspace.workspace_id, "coding stream conflict");

    const firstSend = app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "first stream" })
    });
    await promptStarted.promise;

    const secondResponse = await app.request(`/runs/${runId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "second stream" })
    });

    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toMatchObject({
      success: false,
      error: "Request conflict"
    });

    for (const handler of handlers) {
      handler({
        type: "session_finished",
        session_id: "route-runtime-session",
        emitted_at: "2026-04-24T00:00:00.000Z",
        status: "completed",
        result_summary: "done"
      });
    }
    promptReleased.resolve();
    await expect(firstSend).resolves.toMatchObject({ status: 200 });
  });

  it("lists slash commands as explicitly unavailable and refuses dispatch without a slash service", async () => {
    const { app } = createTestContext();

    const listResponse = await app.request("/slash-commands");
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        commands: expect.arrayContaining([
          expect.objectContaining({
            name: "/cost",
            available: false,
            dispatchable: false,
            unavailable_reason: expect.any(String)
          })
        ])
      }
    });

    const dispatchResponse = await app.request("/slash-commands/%2Fcost/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(dispatchResponse.status).toBe(200);
    await expect(dispatchResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        name: "/cost",
        status: "unavailable"
      }
    });
  });

  it("lists and dispatches slash commands through the configured slash service", async () => {
    const slashCommandService = {
      listCommands: vi.fn(async () => ({
        commands: [
          {
            name: "/cost",
            description: "Show Claude Code session cost",
            available: true,
            dispatchable: true
          }
        ]
      })),
      dispatchCommand: vi.fn(async () => ({
        name: "/cost",
        status: "dispatched" as const,
        message: "Total cost: $0.01"
      }))
    };
    const { app } = createTestContext({ slashCommandService });

    const listResponse = await app.request("/slash-commands?run_id=run-1");
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        commands: [
          {
            name: "/cost",
            available: true,
            dispatchable: true
          }
        ]
      }
    });
    expect(slashCommandService.listCommands).toHaveBeenCalledWith({ runId: "run-1" });

    const dispatchResponse = await app.request("/slash-commands/%2Fcost/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "run-1" })
    });

    expect(dispatchResponse.status).toBe(200);
    await expect(dispatchResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        name: "/cost",
        status: "dispatched",
        message: "Total cost: $0.01"
      }
    });
    expect(slashCommandService.dispatchCommand).toHaveBeenCalledWith({
      name: "/cost",
      runId: "run-1"
    });
  });

  it("protects run-bound slash discovery before invoking the slash service", async () => {
    const slashCommandService = {
      listCommands: vi.fn(async () => ({
        commands: [
          {
            name: "/cost",
            description: "Show Claude Code session cost",
            available: true,
            dispatchable: true
          }
        ]
      })),
      dispatchCommand: vi.fn()
    };
    const { app } = createTestContext({
      slashCommandService,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "token-123",
        allowDesktopOriginlessRequests: true
      }
    });

    const unprotectedStatic = await app.request("/slash-commands");
    expect(unprotectedStatic.status).toBe(200);

    const missingToken = await app.request("/slash-commands?run_id=run-1", {
      headers: {
        "x-do-what-desktop": "1"
      }
    });
    expect(missingToken.status).toBe(403);
    await expect(missingToken.json()).resolves.toMatchObject({
      success: false,
      error: "X-Request-Token is required"
    });

    const protectedResponse = await app.request("/slash-commands?run_id=run-1", {
      headers: {
        "x-do-what-desktop": "1",
        "x-request-token": "token-123"
      }
    });
    expect(protectedResponse.status).toBe(200);
    expect(slashCommandService.listCommands).toHaveBeenCalledTimes(2);
    expect(slashCommandService.listCommands).toHaveBeenLastCalledWith({ runId: "run-1" });
  });

  it("acquires and releases a governance lease around a run message request", async () => {
    const { app, engine, eventLogRepo, governanceLeaseService } = createTestContext();
    const workspace = await createWorkspace(app, "lease-flow");
    const runId = await createRun(app, workspace.workspace_id, "lease run");

    engine.setHandler(async () => ({
      message: {
        role: "assistant",
        content: "lease reply",
        message_id: "msg_assistant_lease"
      },
      finish_reason: "stop"
    }));

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hold lease" })
    });

    expect(response.status).toBe(200);
    await waitForCondition(async () => !(await governanceLeaseService.isHeld(runId)));
    await expect(governanceLeaseService.isHeld(runId)).resolves.toBe(false);

    const leaseEvents = (await eventLogRepo.queryByRun(runId)).filter((event) =>
      event.event_type.startsWith("soul.governance_lease.")
    );

    expect(leaseEvents).toHaveLength(2);
    expect(leaseEvents[0]).toMatchObject({
      event_type: "soul.governance_lease.acquired",
      run_id: runId,
      workspace_id: workspace.workspace_id,
      payload_json: expect.objectContaining({
        run_id: runId
      })
    });
    expect(leaseEvents[1]).toMatchObject({
      event_type: "soul.governance_lease.released",
      run_id: runId,
      workspace_id: workspace.workspace_id,
      payload_json: expect.objectContaining({
        run_id: runId
      })
    });
  });

  it("releases a held governance lease when deleting a run", async () => {
    const { app, governanceLeaseService } = createTestContext();
    const workspace = await createWorkspace(app, "lease-delete");
    const runId = await createRun(app, workspace.workspace_id, "lease delete run");

    await governanceLeaseService.acquire({
      runId,
      workspaceId: workspace.workspace_id
    });
    await expect(governanceLeaseService.isHeld(runId)).resolves.toBe(true);

    const response = await app.request(`/runs/${runId}`, {
      method: "DELETE"
    });

    expect(response.status).toBe(200);
    await expect(governanceLeaseService.isHeld(runId)).resolves.toBe(false);
  });

  it("releases the governance lease when message processing fails", async () => {
    const { app, engine, governanceLeaseService } = createTestContext();
    const workspace = await createWorkspace(app, "lease-error");
    const runId = await createRun(app, workspace.workspace_id, "lease error run");

    engine.setHandler(async () => {
      throw new EngineError("provider rate limited", EngineErrorKind.RATE_LIMIT);
    });

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "fail under lease" })
    });

    expect(response.status).toBe(502);
    await expect(governanceLeaseService.isHeld(runId)).resolves.toBe(false);
  });

  it("clears the cached context lens when deleting a run", async () => {
    const clearLens = vi.fn();
    const { app } = createTestContext({
      contextLensAssembler: {
        getLastLens: vi.fn(() => null),
        clearLens
      }
    });
    const workspace = await createWorkspace(app, "delete-lens");
    const runId = await createRun(app, workspace.workspace_id, "delete-lens-run");

    const response = await app.request(`/runs/${runId}`, {
      method: "DELETE"
    });

    expect(response.status).toBe(200);
    expect(clearLens).toHaveBeenCalledWith(runId);
  });

  it("returns the last assembled context lens for a run", async () => {
    let runId = "";
    const lens = createContextLensPreview();
    const { app } = createTestContext({
      contextLensAssembler: {
        getLastLens: vi.fn((requestedRunId: string) => (requestedRunId === runId ? lens : null)),
        clearLens: vi.fn()
      }
    });
    const workspace = await createWorkspace(app, "lens-preview");
    runId = await createRun(app, workspace.workspace_id, "run-with-lens");
    const runWithoutLensId = await createRun(app, workspace.workspace_id, "run-without-lens");

    const existingResponse = await app.request(`/runs/${runId}/context-lens`);
    expect(existingResponse.status).toBe(200);
    await expect(existingResponse.json()).resolves.toEqual({ success: true, data: lens });

    const emptyResponse = await app.request(`/runs/${runWithoutLensId}/context-lens`);
    expect(emptyResponse.status).toBe(200);
    await expect(emptyResponse.json()).resolves.toEqual({ success: true, data: null });

    const missingResponse = await app.request("/runs/run_without_lens/context-lens");
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns workspace karma events when the preview port is configured", async () => {
    const karmaEventPreview = {
      findByWorkspaceId: vi.fn(async () => [{ event_id: "karma-1" }])
    };
    const { app } = createTestContext({ karmaEventPreview });
    const workspace = await createWorkspace(app, "karma-preview");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/karma-events`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{ event_id: "karma-1" }]
    });
    expect(karmaEventPreview.findByWorkspaceId).toHaveBeenCalledWith(workspace.workspace_id);
  });

  it("sends full multi-turn history to the engine on the third turn", async () => {
    const { app, engine, eventLogRepo } = createTestContext();
    const workspace = await createWorkspace(app, "test-ws");

    const createRunResponse = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "history run",
        goal: "fix bug",
        run_mode: "build"
      })
    });
    const runBody = (await createRunResponse.json()) as any;
    const runId = runBody.data.run_id as string;

    let turn = 0;
    engine.setHandler(async () => {
      turn += 1;
      return {
        message: {
          role: "assistant",
          content: `assistant ${turn}`,
          message_id: `msg_assistant_${turn}`
        },
        finish_reason: "stop"
      };
    });

    for (const content of ["one", "two", "three"]) {
      const response = await app.request(`/runs/${runId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content })
      });
      expect(response.status).toBe(200);
    }

    const turnEvents = (await eventLogRepo.queryByRun(runId)).filter(
      (event) =>
        event.event_type === "run.message.appended" ||
        event.event_type === "engine.response.received"
    );
    expect(turnEvents).toHaveLength(6);
    expect(engine.requests).toHaveLength(3);
    expect(engine.requests[2].messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "assistant 1" },
      { role: "user", content: "two" },
      { role: "assistant", content: "assistant 2" },
      { role: "user", content: "three" }
    ]);
    expect(engine.requests[2].systemPrompt).toContain("Workspace: test-ws");
    expect(engine.requests[2].systemPrompt).toContain("Run goal: fix bug");
    expect(engine.requests[2].systemPrompt).toContain("Mode: build");
  });

  it("reports streaming during an in-flight request and idle after the assistant response", async () => {
    const { app, engine } = createTestContext();
    const workspace = await createWorkspace(app, "streaming");
    const runId = await createRun(app, workspace.workspace_id, "streaming run");
    const deferred = createDeferred<EngineResult>();

    engine.setHandler(async () => deferred.promise);

    const requestPromise = app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "pending" })
    });

    await waitForCondition(() => engine.requests.length === 1);

    const streamingSnapshot = await app.request(`/runs/${runId}/snapshot`);
    await expect(streamingSnapshot.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        engine_status: "streaming"
      }
    });

    deferred.resolve({
      message: {
        role: "assistant",
        content: "done",
        message_id: "msg_assistant_streaming"
      },
      finish_reason: "stop"
    });

    const response = await requestPromise;
    expect(response.status).toBe(200);

    const idleSnapshot = await app.request(`/runs/${runId}/snapshot`);
    await expect(idleSnapshot.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        engine_status: "idle",
        last_message_at: expect.any(String)
      }
    });
  });

  it("returns 502 on engine failure, marks the run hot state as error, and allows later recovery", async () => {
    const { app, engine } = createTestContext();
    const workspace = await createWorkspace(app, "engine-error");
    const runId = await createRun(app, workspace.workspace_id, "engine error run");

    let shouldFail = true;
    engine.setHandler(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new EngineError("The model provider rate limit was exceeded.", EngineErrorKind.RATE_LIMIT);
      }

      return {
        message: {
          role: "assistant",
          content: "recovered",
          message_id: "msg_assistant_recovered"
        },
        finish_reason: "stop"
      };
    });

    const failedResponse = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "first try" })
    });
    expect(failedResponse.status).toBe(502);
    await expect(failedResponse.json()).resolves.toMatchObject({
      success: false,
      error: "The conversation provider rate limit was reached.",
      kind: EngineErrorKind.RATE_LIMIT
    });

    const errorSnapshot = await app.request(`/runs/${runId}/snapshot`);
    await expect(errorSnapshot.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        engine_status: "error"
      }
    });

    const recoveredResponse = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "second try" })
    });
    expect(recoveredResponse.status).toBe(200);
    await expect(recoveredResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        assistant_message_id: "msg_assistant_recovered",
        content: "recovered"
      }
    });

    const recoveredSnapshot = await app.request(`/runs/${runId}/snapshot`);
    await expect(recoveredSnapshot.json()).resolves.toMatchObject({
      success: true,
      data: {
        run_id: runId,
        engine_status: "idle"
      }
    });
  });

  it("injects the workspace name, run goal, and run mode into the system prompt", async () => {
    const { app, engine } = createTestContext();
    const workspace = await createWorkspace(app, "test-ws");

    const createRunResponse = await app.request(`/workspaces/${workspace.workspace_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "prompt run",
        goal: "fix bug",
        run_mode: "build"
      })
    });
    const runBody = (await createRunResponse.json()) as any;
    const runId = runBody.data.run_id as string;

    engine.setHandler(async () => ({
      message: {
        role: "assistant",
        content: "prompt checked",
        message_id: "msg_assistant_prompt"
      },
      finish_reason: "stop"
    }));

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "inspect prompt" })
    });
    expect(response.status).toBe(200);
    expect(engine.requests).toHaveLength(1);
    expect(engine.requests[0].systemPrompt).toContain("Workspace: test-ws");
    expect(engine.requests[0].systemPrompt).toContain("Run goal: fix bug");
    expect(engine.requests[0].systemPrompt).toContain("Mode: build");
    expect(engine.requests[0].systemPrompt).toContain("soul.emit_candidate_signal");
  });
});

class MockConversationEngine {
  public readonly requests: ConversationRequest[] = [];
  private handler: (request: ConversationRequest) => Promise<EngineResult> = async () => ({
    message: {
      role: "assistant",
      content: "default assistant reply",
      message_id: "msg_assistant_default"
    },
    finish_reason: "stop"
    });

  public setHandler(handler: (request: ConversationRequest) => Promise<EngineResult> | EngineResult): void {
    this.handler = async (request) => await handler(request);
  }

  private streamHandler: (
    request: ConversationRequest
  ) => AsyncGenerator<MessageDeltaEvent, void, unknown> = () => mockRouteStreamProvider([]);

  public setStreamHandler(
    handler: (request: ConversationRequest) => AsyncGenerator<MessageDeltaEvent, void, unknown>
  ): void {
    this.streamHandler = handler;
  }

  public async sendMessage(request: ConversationRequest): Promise<EngineResult> {
    this.requests.push(request);
    return await this.handler(request);
  }

  public async *streamMessage(
    request: ConversationRequest
  ): AsyncGenerator<MessageDeltaEvent, void, unknown> {
    this.requests.push(request);
    yield* this.streamHandler(request);
  }
}

function createDefaultBinding(): EngineBinding {
  return {
    binding_id: "default",
    provider: "openai",
    base_url: null,
    model: "gpt-4o-mini",
    api_key: "sk-test",
    config: {}
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

async function* mockRouteStreamProvider(
  deltas: readonly string[]
): AsyncGenerator<MessageDeltaEvent, void, unknown> {
  for (let i = 0; i < deltas.length; i++) {
    yield {
      type: "message.delta",
      runId: "run-route-test",
      messageId: "msg-placeholder",
      delta: deltas[i]!,
      index: i,
      finishReason: i === deltas.length - 1 ? "stop" : undefined,
      timestamp: new Date().toISOString()
    };
  }
}

interface ContextLensAssemblerPreview {
  getLastLens(runId: string): Readonly<ContextLens> | null;
  clearLens(runId: string): void;
}

interface KarmaEventPreview {
  findByWorkspaceId(workspaceId: string): Promise<readonly { readonly event_id: string }[]>;
}

function createTestContext(options: {
  readonly budgetBankruptcyService?: {
    clearRun(runId: string): void;
  };
  readonly contextLensAssembler?: ContextLensAssemblerPreview;
  readonly disableSnapshotCompaction?: boolean;
  readonly karmaEventPreview?: KarmaEventPreview;
  readonly principalCodingEngineAvailable?: boolean;
  readonly requestProtection?: Parameters<typeof createApp>[0]["requestProtection"];
  readonly runtimeAdapter?: AgentRuntimePort;
  readonly sessionOverrideService?: {
    clearRun(runId: string): void;
  };
  readonly slashCommandService?: Parameters<typeof createApp>[0]["slashCommandService"];
  readonly streamMessage?: (request: ConversationRequest) => AsyncGenerator<MessageDeltaEvent, void, unknown>;
} = {}): TestContext {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const workspaceEngineConfigRepo = new SqliteWorkspaceEngineConfigRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });
  const governanceLeaseService = new GovernanceLeaseService({
    eventLogRepo
  });
  const budgetBankruptcyService = options.budgetBankruptcyService ?? undefined;
  const sessionOverrideService = options.sessionOverrideService ?? {
    clearRun: vi.fn()
  };

  const workspaceService = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher,
    engineConfigRepo: workspaceEngineConfigRepo
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => options.principalCodingEngineAvailable ?? true,
    bindingRepo
  });
  const engineBindingService = new EngineBindingService({
    workspaceRepo,
    bindingRepo,
    eventPublisher,
    engineTester: {
      testBinding: vi.fn()
    }
  });
  const engine = new MockConversationEngine();
  if (options.streamMessage !== undefined) {
    engine.setStreamHandler(options.streamMessage);
  }
  const conversationService = new ConversationService({
    engine,
    eventPublisher,
    runHotStateService,
    runRepo,
    workspaceRepo,
    eventLogRepo,
    resolveBinding: async () => createDefaultBinding(),
    runtimeAdapter: options.runtimeAdapter,
    gardenComputeProvider: {
      provider_kind: "local_heuristics",
      compile: vi.fn(async () => [])
    },
    signalReceiver: {
      receiveSignal: vi.fn(async () => {})
    },
    governanceLeaseService,
    sseBroadcaster: sseManager,
    warn: vi.fn()
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      conversationService,
      principalCodingEngineAvailable: options.principalCodingEngineAvailable ?? true,
      engineBindingService,
      runHotStateService,
      eventLogRepo: options.disableSnapshotCompaction ? undefined : eventLogRepo,
      slashCommandService: options.slashCommandService,
      sseManager,
      signalService: createUnusedSignalService("run route tests") as any,
      evidenceService: createUnusedEvidenceService("run route tests") as any,
      memoryService: createUnusedMemoryService("run route tests") as any,
      governanceLeaseService,
      budgetBankruptcyService,
      sessionOverrideService: sessionOverrideService as any,
      slotService: createUnusedSlotService("run route tests") as any,
      surfaceService: createUnusedSurfaceService("run route tests") as any,
      synthesisService: createUnusedSynthesisService("run route tests") as any,
      claimService: createUnusedClaimService("run route tests") as any,
      proposalService: createUnusedProposalService("run route tests") as any,
      contextLensAssembler: options.contextLensAssembler,
      karmaEventPreview: options.karmaEventPreview as any,
      requestProtection: options.requestProtection
    }),
    database,
    engine,
    eventLogRepo,
    eventPublisher,
    governanceLeaseService,
    runHotStateService,
    sseManager,
    sessionOverrideService
  };
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  name: string,
  options: {
    readonly configurePrincipalEngine?: boolean;
  } = {}
): Promise<{
  readonly workspace_id: string;
}> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  const workspace = body.data;
  if (options.configurePrincipalEngine ?? true) {
    await configureWorkspacePrincipalConversationEngine(app, workspace.workspace_id);
  }
  return workspace;
}

async function createRun(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  title: string
): Promise<string> {
  const response = await app.request(`/workspaces/${workspaceId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      goal: null,
      run_mode: "chat"
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data.run_id as string;
}

async function createCodingRun(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  title: string
): Promise<string> {
  const response = await app.request(`/workspaces/${workspaceId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      goal: null,
      run_mode: "chat",
      engine_class: "coding_engine"
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data.run_id as string;
}

function createRouteRuntimeAdapter(options: {
  readonly handlers?: Set<(event: RuntimeEvent) => void>;
  readonly capabilities?: ReturnType<AgentRuntimePort["getCapabilities"]>;
  readonly createSession?: (config: RuntimeSessionConfig) => Promise<RuntimeSession>;
  readonly prompt?: (sessionId: string, input: RuntimeTurnInput) => Promise<void>;
  readonly cancel?: (sessionId: string) => Promise<{ readonly session_id: string; readonly status: "cancelled" | "not_found" | "already_finished" }>;
} = {}): AgentRuntimePort {
  const handlers = options.handlers ?? new Set<(event: RuntimeEvent) => void>();
  return {
    kind: "route_test_runtime",
    getCapabilities: () =>
      options.capabilities ?? {
        supports_resume: false,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: false,
        supports_terminal_events: false
      },
    createSession: vi.fn(async (config: RuntimeSessionConfig) => {
      if (options.createSession !== undefined) {
        return options.createSession(config);
      }
      return { session_id: "route-runtime-session" };
    }),
    prompt: vi.fn(async (sessionId: string, input: RuntimeTurnInput) => {
      await options.prompt?.(sessionId, input);
    }),
    cancel: vi.fn(async (sessionId: string) => {
      if (options.cancel !== undefined) {
        return options.cancel(sessionId);
      }
      return {
        session_id: sessionId,
        status: "cancelled"
      };
    }),
    onEvent: (handler: (event: RuntimeEvent) => void) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    }
  };
}

function createContextLensPreview() {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "context_lens",
    task_surface_ref: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    expires_at: null,
    derived_from: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    retention_policy: "session_only",
    lens_entries: [
      {
        object_id: "9d599a9a-4940-4f23-a88e-0149f82ab021",
        object_kind: "memory_entry",
        relevance_score: 1,
        manifestation: "full_eligible"
      }
    ],
    not_a_priority_source: true
  } as const;
}

function createSseClient(response: Response): SseTestClient {
  if (response.body === null) {
    throw new Error("Expected SSE response body");
  }

  return new SseTestClient(response.body.getReader());
}

class SseTestClient {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  public constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  public async readEvent(timeoutMs = 2000): Promise<ParsedSseEvent> {
    while (true) {
      const delimiter = this.buffer.indexOf("\n\n");
      if (delimiter >= 0) {
        const frame = this.buffer.slice(0, delimiter);
        this.buffer = this.buffer.slice(delimiter + 2);
        return parseSseFrame(frame);
      }

      const chunk = await readWithTimeout(this.reader, timeoutMs);
      if (chunk.done) {
        throw new Error("SSE stream closed before next event");
      }

      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  public async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for SSE chunk after ${timeoutMs}ms`));
    }, timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parseSseFrame(frame: string): ParsedSseEvent {
  let id = "";
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  const dataText = dataLines.join("\n");

  return {
    id,
    event,
    data: dataText.length === 0 ? null : JSON.parse(dataText)
  };
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (!(await condition())) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("SSE regression: P1-a dedup and P1-b cursor seeding", () => {
  it("does not duplicate events that arrive during the replay window", async () => {
    // Regression for P1-a: event persisted after subscribe() but before markReplayComplete()
    // must appear exactly once — not once from replay and once from the live buffer flush.
    const { app, eventPublisher, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "dedup-ws");
    const runId = await createRun(app, workspace.workspace_id, "dedup run");

    // Publish two events before any client connects.
    const event1 = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: { run_id: runId, role: "user", content: "a", message_id: "msg_dedup_1" }
    });
    const event2 = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 2,
      payload_json: { run_id: runId, role: "user", content: "b", message_id: "msg_dedup_2" }
    });

    // Reconnect with Last-Event-ID pointing before event2 so replay includes it.
    const conn = createSseClient(
      await app.request(`/runs/${runId}/events`, {
        headers: { "Last-Event-ID": event1.event_id }
      })
    );

    // connected frame + replayed event2. If dedup is broken, event2 appears twice.
    const connected = await conn.readEvent();
    expect(connected.event).toBe("connected");

    const replayed = await conn.readEvent();
    expect(replayed.id).toBe(event2.event_id);

    // Publish a new event — should arrive exactly once (live, not from replay).
    const event3 = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 3,
      payload_json: { run_id: runId, role: "user", content: "c", message_id: "msg_dedup_3" }
    });

    const live = await conn.readEvent();
    expect(live.id).toBe(event3.event_id);

    // Stream must be silent now — no duplicate of event2 should arrive.
    await expect(conn.readEvent(200)).rejects.toThrow(/Timed out/);

    await conn.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });

  it("seeds the browser cursor on first connect so reconnect after immediate disconnect replays correctly", async () => {
    // Regression for P1-b: on first connect the connected frame must carry id: so the
    // browser has a Last-Event-ID cursor even if it disconnects before any real event.
    const { app, eventPublisher, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "cursor-ws");
    const runId = await createRun(app, workspace.workspace_id, "cursor run");

    // Pre-populate the event log so there is a latest event ID to seed the cursor with.
    const event1 = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: { run_id: runId, role: "user", content: "pre", message_id: "msg_cursor_1" }
    });

    // First connect (no Last-Event-ID): connected frame must have id: set to latest event.
    const firstConn = createSseClient(await app.request(`/runs/${runId}/events`));
    const connectedFirst = await firstConn.readEvent();
    expect(connectedFirst.event).toBe("connected");
    expect(connectedFirst.id).toBe(event1.event_id);
    await firstConn.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);

    // Reconnect (with Last-Event-ID): connected frame must NOT have id: set.
    const secondConn = createSseClient(
      await app.request(`/runs/${runId}/events`, {
        headers: { "Last-Event-ID": event1.event_id }
      })
    );
    const connectedSecond = await secondConn.readEvent();
    expect(connectedSecond.event).toBe("connected");
    expect(connectedSecond.id).toBe(""); // no id: line on reconnect
    await secondConn.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });

  it("seeds a synthetic cursor on an empty first stream so reconnect replays events created while disconnected", async () => {
    const { app, eventPublisher, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "cursor-empty-ws");
    const runId = await createRun(app, workspace.workspace_id, "cursor empty run");

    const firstConn = createSseClient(await app.request(`/runs/${runId}/events`));
    const connectedFirst = await firstConn.readEvent();
    expect(connectedFirst.event).toBe("connected");
    expect(connectedFirst.id).not.toBe("");
    await firstConn.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);

    const missedEvent = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: { run_id: runId, role: "user", content: "missed", message_id: "msg_cursor_empty_1" }
    });

    const secondConn = createSseClient(
      await app.request(`/runs/${runId}/events`, {
        headers: { "Last-Event-ID": connectedFirst.id }
      })
    );
    const connectedSecond = await secondConn.readEvent();
    expect(connectedSecond.event).toBe("connected");
    expect(connectedSecond.id).toBe("");

    const replayed = await secondConn.readEvent();
    expect(replayed.id).toBe(missedEvent.event_id);

    await secondConn.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });

  it("does not seed first-connect cursor past live events buffered after subscribe and before replay", async () => {
    const { app, eventPublisher, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "cursor-race-ws");
    const runId = await createRun(app, workspace.workspace_id, "cursor race run");

    const event1 = await eventPublisher.publish({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "run",
      entity_id: runId,
      workspace_id: workspace.workspace_id,
      run_id: runId,
      caused_by: "user_action",
      revision: 1,
      payload_json: { run_id: runId, role: "user", content: "pre", message_id: "msg_cursor_race_1" }
    });

    const originalSendConnected = sseManager.sendConnected.bind(sseManager);
    let raceEventId: string | null = null;
    let injectedRaceEvent = false;
    vi.spyOn(sseManager, "sendConnected").mockImplementation(async (connectionId, targetRunId, latestEventId, isReconnect) => {
      await originalSendConnected(connectionId, targetRunId, latestEventId, isReconnect);

      if (targetRunId === runId && !isReconnect && !injectedRaceEvent) {
        injectedRaceEvent = true;
        const raced = await eventPublisher.publish({
          event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
          entity_type: "run",
          entity_id: runId,
          workspace_id: workspace.workspace_id,
          run_id: runId,
          caused_by: "user_action",
          revision: 2,
          payload_json: { run_id: runId, role: "user", content: "raced", message_id: "msg_cursor_race_2" }
        });
        raceEventId = raced.event_id;
      }
    });

    const conn = createSseClient(await app.request(`/runs/${runId}/events`));
    const connected = await conn.readEvent();

    expect(connected.event).toBe("connected");
    expect(connected.id).toBe(event1.event_id);

    const replayedOrBuffered = await conn.readEvent();
    expect(replayedOrBuffered.id).toBe(raceEventId);
    await expect(conn.readEvent(200)).rejects.toThrow(/Timed out/);

    await conn.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });
});
