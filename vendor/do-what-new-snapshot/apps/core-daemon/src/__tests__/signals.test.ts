import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from "node:stream/web";
import { APIConversationEngine, McpBridge } from "@do-what/engine-gateway";
import {
  ClaimService,
  ConversationService,
  EventPublisher,
  EvidenceService,
  HealthJournalService,
  MemoryService,
  RunHotStateService,
  RunService,
  SessionOverrideService,
  SignalService,
  StanceResolutionService,
  SynthesisService,
  WorkspaceService
} from "@do-what/core";
import {
  ComputeRoutingService,
  LocalHeuristics,
  MaterializationRouter,
  OFFICIAL_API_GARDEN_MODEL,
  OfficialApiGardenProvider,
  SessionOverrideRemediation,
  SoulSignalHandler
} from "@do-what/soul";
import {
  SqliteEngineBindingRepo,
  SqliteClaimFormRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteHealthJournalRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteSynthesisCapsuleRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import {
  ComputeProviderPriority,
  FormationKind,
  HealthEventKind,
  MemoryDimension,
  PhaseCExtensionEventType,
  PhaseCEventType,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind
} from "@do-what/protocol";
import { createApp } from "../app.js";
import { createComputeRoutingExecutionStanceResolver } from "../compute-routing-resolver.js";
import { configureWorkspacePrincipalConversationEngine, createStubEngineBindingService, createUnusedProposalService, createUnusedSlotService,
  createUnusedSurfaceService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";
import { SqliteWorkspaceEngineConfigRepo } from "../services/workspace-engine-config-repo.js";

interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: any;
}

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("signal routes and A-track integration", () => {
  it("creates and lists signals for a run via the debug API", async () => {
    const { app } = createTestContext();
    const workspace = await createWorkspace(app, "signals-route");
    const runId = await createRun(app, workspace.workspace_id, "signals route run");

    const createResponse = await app.request(`/runs/${runId}/signals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: workspace.workspace_id,
        run_id: runId,
        surface_id: null,
        signal_kind: "potential_preference",
        object_kind: "preference",
        scope_hint: null,
        domain_tags: ["typescript"],
        confidence: 0.8,
        evidence_refs: ["msg_debug_1"],
        raw_payload: {
          excerpt: "Prefer strict mode."
        }
      })
    });

    expect(createResponse.status).toBe(201);
    const createBody = (await createResponse.json()) as any;
    expect(createBody).toMatchObject({
      success: true,
      data: {
        status: "emitted"
      }
    });

    const listResponse = await app.request(`/runs/${runId}/signals`);
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          workspace_id: workspace.workspace_id,
          run_id: runId,
          source: "user_seed",
          signal_kind: "potential_preference",
          signal_state: "triaged"
        })
      ]
    });
  });

  it("routes model tool_use through the MCP bridge and emits a signal event over SSE", async () => {
    const { app, eventLogRepo, openaiProvider, sseManager } = createTestContext();
    const workspace = await createWorkspace(app, "atrack");
    const runId = await createRun(app, workspace.workspace_id, "atrack run");

    openaiProvider.send.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        message_id: "msg_tool_loop"
      },
      finish_reason: "stop",
      tool_uses: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "soul.emit_candidate_signal",
          input: {
            workspace_id: workspace.workspace_id,
            run_id: runId,
            surface_id: null,
            signal_kind: "potential_claim",
            object_kind: "constraint",
            scope_hint: null,
            domain_tags: ["security"],
            confidence: 0.5,
            evidence_refs: ["msg_user_1"],
            raw_payload: {
              excerpt: "Never print secrets."
            }
          }
        }
      ]
    });
    openaiProvider.continueWithToolResults.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "Recorded the signal.",
        message_id: "msg_assistant_final"
      },
      finish_reason: "stop"
    });

    const stream = createSseClient(await app.request(`/runs/${runId}/events`));
    await stream.readEvent();

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Remember that we never print secrets." })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        assistant_message_id: "msg_assistant_final",
        content: "Recorded the signal."
      }
    });

    const pushedUser = await stream.readEvent();
    const pushedSignalEmitted = await stream.readEvent();
    const pushedSignalTriaged = await stream.readEvent();
    const pushedAssistant = await stream.readEvent();

    expect(pushedUser.event).toBe("run.message.appended");
    expect(pushedSignalEmitted).toMatchObject({
      event: "soul.signal.emitted",
      data: {
        workspace_id: workspace.workspace_id,
        run_id: runId,
        source: "model_tool",
        signal_kind: "potential_claim"
      }
    });
    expect(pushedSignalTriaged).toMatchObject({
      event: "soul.signal.triaged",
      data: {
        workspace_id: workspace.workspace_id,
        run_id: runId,
        triage_result: "accepted"
      }
    });
    expect(pushedAssistant.event).toBe("engine.response.received");

    const signalEvents = await eventLogRepo.queryByType("soul.signal.emitted");
    expect(signalEvents).toHaveLength(1);
    expect(signalEvents[0]).toMatchObject({
      workspace_id: workspace.workspace_id,
      run_id: runId
    });

    const listSignals = await app.request(`/runs/${runId}/signals`);
    await expect(listSignals.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          source: "model_tool",
          signal_kind: "potential_claim",
          signal_state: "triaged"
        })
      ]
    });

    await stream.close();
    await waitForCondition(() => sseManager.connectionCount(runId) === 0);
  });

  it("routes soul.apply_override through the MCP bridge with the current user message as evidence", async () => {
    const { app, eventLogRepo, openaiProvider, sessionOverrideService } = createTestContext();
    const workspace = await createWorkspace(app, "override-atrack");
    const runId = await createRun(app, workspace.workspace_id, "override atrack run");

    openaiProvider.send.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        message_id: "msg_tool_override"
      },
      finish_reason: "stop",
      tool_uses: [
        {
          type: "tool_use",
          id: "toolu_override",
          name: "soul.apply_override",
          input: {
            target_object: "memory:build-style",
            correction: "Use pnpm instead of npm.",
            priority: 2
          }
        }
      ]
    });
    openaiProvider.continueWithToolResults.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "Will use pnpm.",
        message_id: "msg_assistant_override"
      },
      finish_reason: "stop"
    });

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "No, use pnpm instead of npm." })
    });

    expect(response.status).toBe(200);
    const overrides = await sessionOverrideService.getActiveFor(runId);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      target_object: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      derived_from: expect.stringMatching(/^msg_user_/)
    });

    const appliedEvents = await eventLogRepo.queryByType("soul.session_override.applied");
    expect(appliedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspace.workspace_id,
          run_id: runId,
          entity_type: "session_override"
        })
      ])
    );
  });

  it("resolves promotion dimension from the target memory object during async override promotion", async () => {
    const { app, eventLogRepo, memoryService, openaiProvider } = createTestContext();
    const workspace = await createWorkspace(app, "override-promotion-dimension");
    const runId = await createRun(app, workspace.workspace_id, "override promotion dimension run");
    const targetMemory = await memoryService.create({
      created_by: "user_action",
      dimension: MemoryDimension.FACT,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content: "Use pnpm for build commands.",
      domain_tags: ["tooling"],
      evidence_refs: [],
      workspace_id: workspace.workspace_id,
      run_id: runId,
      surface_id: null,
      storage_tier: StorageTier.HOT
    });

    openaiProvider.send.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        message_id: "msg_tool_override_promote"
      },
      finish_reason: "stop",
      tool_uses: [
        {
          type: "tool_use",
          id: "toolu_override_promote",
          name: "soul.apply_override",
          input: {
            target_object: targetMemory.object_id,
            correction: "Always treat this correction as the factual rule.",
            priority: 2
          }
        }
      ]
    });
    openaiProvider.continueWithToolResults.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "Understood.",
        message_id: "msg_assistant_override_promote"
      },
      finish_reason: "stop"
    });

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "No, this should be treated as a factual rule from now on." })
    });

    expect(response.status).toBe(200);

    await waitForCondition(async () => {
      const promotedEvents = await eventLogRepo.queryByType("soul.session_override.promoted");
      return promotedEvents.some(
        (entry) =>
          entry.run_id === runId &&
          entry.payload_json["target_object"] === targetMemory.object_id &&
          entry.payload_json["dimension"] === MemoryDimension.FACT
      );
    });

    const promotedEvents = await eventLogRepo.queryByType("soul.session_override.promoted");
    expect(promotedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: runId,
          payload_json: expect.objectContaining({
            target_object: targetMemory.object_id,
            dimension: MemoryDimension.FACT,
            promotion_outcome: "candidate"
          })
        })
      ])
    );
  });

  it("emits B-track signals from normal conversation turns without MCP tool_use", async () => {
    const { app, openaiProvider } = createTestContext();
    const workspace = await createWorkspace(app, "btrack");
    const runId = await createRun(app, workspace.workspace_id, "btrack run");

    openaiProvider.send.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "Noted.",
        message_id: "msg_assistant_btrack"
      },
      finish_reason: "stop"
    });

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "I always use TypeScript strict mode." })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        assistant_message_id: "msg_assistant_btrack",
        content: "Noted."
      }
    });

    await waitForCondition(async () => {
      const listSignals = await app.request(`/runs/${runId}/signals`);
      const body = (await listSignals.json()) as any;
      return (
        Array.isArray(body.data) &&
        body.data.some(
          (signal: { source?: string; signal_kind?: string }) =>
            signal.source === "garden_compile" && signal.signal_kind === "potential_preference"
        )
      );
    });

    const listSignals = await app.request(`/runs/${runId}/signals`);
    await expect(listSignals.json()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          source: "garden_compile",
          signal_kind: "potential_preference",
          object_kind: "preference",
          signal_state: "triaged"
        })
      ]
    });
  });

  it("materializes triaged signals into ontology objects when router is enabled", async () => {
    const { app, openaiProvider } = createTestContext({ enableMaterialization: true });
    const workspace = await createWorkspace(app, "materialization");
    const runId = await createRun(app, workspace.workspace_id, "materialization run");

    openaiProvider.send.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        message_id: "msg_tool_materialize"
      },
      finish_reason: "stop",
      tool_uses: [
        {
          type: "tool_use",
          id: "toolu_materialize",
          name: "soul.emit_candidate_signal",
          input: {
            workspace_id: workspace.workspace_id,
            run_id: runId,
            surface_id: null,
            signal_kind: "potential_claim",
            object_kind: "constraint",
            scope_hint: null,
            domain_tags: ["security"],
            confidence: 0.8,
            evidence_refs: ["msg_user_materialize"],
            raw_payload: {
              excerpt: "Never print secrets in logs."
            }
          }
        }
      ]
    });
    openaiProvider.continueWithToolResults.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "Materialized.",
        message_id: "msg_assistant_materialize"
      },
      finish_reason: "stop"
    });

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Track this as a durable constraint." })
    });

    expect(response.status).toBe(200);

    await waitForCondition(async () => {
      const listSignals = await app.request(`/runs/${runId}/signals`);
      const body = (await listSignals.json()) as {
        readonly data?: ReadonlyArray<{ readonly signal_state?: string }>;
      };
      return (body.data ?? []).some((signal) => signal.signal_state === "materialized");
    });

    const signalsResponse = await app.request(`/runs/${runId}/signals`);
    await expect(signalsResponse.json()).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          signal_state: "materialized",
          signal_kind: "potential_claim"
        })
      ])
    });

    const evidenceResponse = await app.request(`/runs/${runId}/evidence`);
    await expect(evidenceResponse.json()).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          object_kind: "evidence_capsule",
          run_id: runId
        })
      ])
    });

    const memoriesResponse = await app.request(`/runs/${runId}/memories`);
    await expect(memoriesResponse.json()).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          object_kind: "memory_entry",
          run_id: runId
        })
      ])
    });

    const claimsResponse = await app.request(`/workspaces/${workspace.workspace_id}/claims`);
    await expect(claimsResponse.json()).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          object_kind: "claim_form",
          workspace_id: workspace.workspace_id
        })
      ])
    });
  });
  it("surfaces both A-track and B-track signals for the same conversation run", async () => {
    const { app, eventLogRepo, openaiProvider } = createTestContext();
    const workspace = await createWorkspace(app, "gate");
    const runId = await createRun(app, workspace.workspace_id, "gate run");

    openaiProvider.send.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "",
        message_id: "msg_tool_gate"
      },
      finish_reason: "stop",
      tool_uses: [
        {
          type: "tool_use",
          id: "toolu_gate",
          name: "soul.emit_candidate_signal",
          input: {
            workspace_id: workspace.workspace_id,
            run_id: runId,
            surface_id: null,
            signal_kind: "potential_claim",
            object_kind: "constraint",
            scope_hint: null,
            domain_tags: ["security"],
            confidence: 0.7,
            evidence_refs: ["msg_user_gate"],
            raw_payload: {
              excerpt: "Never print secrets."
            }
          }
        }
      ]
    });
    openaiProvider.continueWithToolResults.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "Captured both signals.",
        message_id: "msg_assistant_gate"
      },
      finish_reason: "stop"
    });

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "I always use TypeScript strict mode. Never print secrets."
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        assistant_message_id: "msg_assistant_gate",
        content: "Captured both signals."
      }
    });

    await waitForCondition(async () => {
      const listSignals = await app.request(`/runs/${runId}/signals`);
      const body = (await listSignals.json()) as {
        readonly data?: ReadonlyArray<{ readonly source?: string }>;
      };
      const sources = new Set((body.data ?? []).map((signal) => signal.source));
      return sources.has("model_tool") && sources.has("garden_compile");
    });

    const listSignals = await app.request(`/runs/${runId}/signals`);
    await expect(listSignals.json()).resolves.toMatchObject({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          source: "model_tool",
          signal_kind: "potential_claim",
          signal_state: "triaged"
        }),
        expect.objectContaining({
          source: "garden_compile",
          signal_kind: "potential_preference",
          signal_state: "triaged"
        })
      ])
    });

    const signalEvents = (await eventLogRepo.queryByType("soul.signal.emitted")).filter((entry) => entry.run_id === runId);
    expect(signalEvents).toHaveLength(2);
    expect(signalEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run_id: runId,
          caused_by: "model_tool"
        }),
        expect.objectContaining({
          run_id: runId,
          caused_by: "garden_compile"
        })
      ])
    );
  });

  it("routes official provider calls through the real daemon event and health-journal seams on success", async () => {
    const officialFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ signals: [] })
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );
    const { app, eventLogRepo, openaiProvider } = createTestContext({
      officialGarden: {
        fetchImpl: officialFetch
      }
    });
    const workspace = await createWorkspace(app, "official-provider-success");
    const runId = await createRun(app, workspace.workspace_id, "official provider success");

    openaiProvider.send.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "Official provider background compile should run.",
        message_id: "msg_official_success"
      },
      finish_reason: "stop"
    });

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "remember that I prefer strict mode" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        assistant_message_id: "msg_official_success"
      }
    });

    await waitForCondition(async () => {
      const events = await eventLogRepo.queryByRun(runId);
      return events.some(
        (entry) => entry.event_type === PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_COMPLETED
      );
    });

    const runEvents = await eventLogRepo.queryByRun(runId);
    const routedEvent = runEvents.find((entry) => entry.event_type === PhaseCEventType.COMPUTE_PROVIDER_ROUTED);
    const startedEvent = runEvents.find(
      (entry) => entry.event_type === PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_STARTED
    );
    const completedEvent = runEvents.find(
      (entry) => entry.event_type === PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_COMPLETED
    );

    expect(officialFetch).toHaveBeenCalledTimes(1);
    expect(routedEvent).toMatchObject({
      payload_json: expect.objectContaining({
        selected_provider: ComputeProviderPriority.OFFICIAL_API,
        model_id: OFFICIAL_API_GARDEN_MODEL
      })
    });
    expect(startedEvent).toBeDefined();
    expect(completedEvent).toBeDefined();

    const startedPayload = startedEvent!.payload_json as {
      readonly call_id: string;
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly provider_kind: string;
      readonly model_id: string;
      readonly operation: string;
    };
    const completedPayload = completedEvent!.payload_json as {
      readonly call_id: string;
      readonly latency_ms: number;
    };

    expect(startedPayload).toMatchObject({
      workspace_id: workspace.workspace_id,
      run_id: runId,
      provider_kind: "official_api",
      model_id: OFFICIAL_API_GARDEN_MODEL,
      operation: "garden.compile"
    });
    expect(completedPayload.call_id).toBe(startedPayload.call_id);
    expect(completedPayload.latency_ms).toBeGreaterThanOrEqual(0);

    const journalResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/health-journal?kind=${HealthEventKind.PROVIDER_CALL}`
    );
    expect(journalResponse.status).toBe(200);
    await expect(journalResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        entries: expect.arrayContaining([
          expect.objectContaining({
            event_kind: HealthEventKind.PROVIDER_CALL,
            workspace_id: workspace.workspace_id,
            run_id: runId,
            detail_json: expect.objectContaining({
              status: "completed",
              call_id: startedPayload.call_id,
              provider_kind: "official_api",
              model_id: OFFICIAL_API_GARDEN_MODEL,
              operation: "garden.compile"
            })
          })
        ])
      }
    });
  });

  it("routes official provider failures through the real daemon event and health-journal seams", async () => {
    const officialFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" }
      })
    );
    const { app, eventLogRepo, openaiProvider } = createTestContext({
      officialGarden: {
        fetchImpl: officialFetch
      }
    });
    const workspace = await createWorkspace(app, "official-provider-failure");
    const runId = await createRun(app, workspace.workspace_id, "official provider failure");

    openaiProvider.send.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: "The turn still succeeds even if background compile fails.",
        message_id: "msg_official_failure"
      },
      finish_reason: "stop"
    });

    const response = await app.request(`/runs/${runId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "remember that I prefer pnpm" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        assistant_message_id: "msg_official_failure"
      }
    });

    await waitForCondition(async () => {
      const events = await eventLogRepo.queryByRun(runId);
      return events.some(
        (entry) => entry.event_type === PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_FAILED
      );
    });

    const runEvents = await eventLogRepo.queryByRun(runId);
    const startedEvent = runEvents.find(
      (entry) => entry.event_type === PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_STARTED
    );
    const failedEvent = runEvents.find(
      (entry) => entry.event_type === PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_FAILED
    );
    const completedEvent = runEvents.find(
      (entry) => entry.event_type === PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_COMPLETED
    );

    expect(officialFetch).toHaveBeenCalledTimes(1);
    expect(startedEvent).toBeDefined();
    expect(failedEvent).toBeDefined();
    expect(completedEvent).toBeUndefined();

    const startedPayload = startedEvent!.payload_json as {
      readonly call_id: string;
    };
    const failedPayload = failedEvent!.payload_json as {
      readonly call_id: string;
      readonly error_kind: string;
      readonly error_message: string;
      readonly latency_ms: number;
    };

    expect(failedPayload).toMatchObject({
      call_id: startedPayload.call_id,
      error_kind: "provider_failure",
      error_message: "Official garden provider request failed with status 503."
    });
    expect(failedPayload.latency_ms).toBeGreaterThanOrEqual(0);

    const journalResponse = await app.request(
      `/workspaces/${workspace.workspace_id}/health-journal?kind=${HealthEventKind.PROVIDER_CALL}`
    );
    expect(journalResponse.status).toBe(200);
    await expect(journalResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        entries: expect.arrayContaining([
          expect.objectContaining({
            event_kind: HealthEventKind.PROVIDER_CALL,
            workspace_id: workspace.workspace_id,
            run_id: runId,
            detail_json: expect.objectContaining({
              status: "failed",
              call_id: startedPayload.call_id,
              provider_kind: "official_api",
              model_id: OFFICIAL_API_GARDEN_MODEL,
              operation: "garden.compile",
              error_kind: "provider_failure",
              error_message: "Official garden provider request failed with status 503."
            })
          })
        ])
      }
    });
  });
});

function createTestContext(options: {
  readonly enableMaterialization?: boolean;
  readonly officialGarden?: {
    readonly fetchImpl: typeof fetch;
  };
} = {}): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly memoryService: MemoryService;
  readonly openaiProvider: {
    readonly send: ReturnType<typeof vi.fn>;
    readonly continueWithToolResults: ReturnType<typeof vi.fn>;
  };
  readonly sessionOverrideService: SessionOverrideService;
  readonly sseManager: SseManager;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const workspaceEngineConfigRepo = new SqliteWorkspaceEngineConfigRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const synthesisCapsuleRepo = new SqliteSynthesisCapsuleRepo(database);
  const claimFormRepo = new SqliteClaimFormRepo(database);
  const healthJournalRepo = new SqliteHealthJournalRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });
  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo,
    eventLogRepo,
    sseBroadcaster: sseManager
  });
  const memoryService = new MemoryService({
    memoryEntryRepo,
    evidenceService,
    eventLogRepo,
    sseBroadcaster: sseManager
  });
  const synthesisService = new SynthesisService({
    synthesisCapsuleRepo,
    evidenceService,
    memoryService,
    eventLogRepo,
    sseBroadcaster: sseManager
  });
  const claimService = new ClaimService({
    claimFormRepo,
    eventLogRepo,
    sseBroadcaster: sseManager
  });
  const materializationRouter = new MaterializationRouter({
    evidenceService,
    memoryService,
    synthesisService,
    claimService
  });
  const signalService = new SignalService({
    eventLogRepo,
    signalRepo,
    sseBroadcaster: sseManager,
    ...(options.enableMaterialization === true
      ? {
          postTriageMaterializer: {
            materialize: async (signal) => await materializationRouter.materializeSignal(signal)
          }
        }
      : {})
  });
  const sessionOverrideService = new SessionOverrideService({
    eventLogRepo
  });
  const sessionOverrideRemediation = new SessionOverrideRemediation({
    memoryService,
    claimService,
    eventLogRepo,
    targetObjectResolver: {
      resolveDimension: async (targetObject) => {
        const memory = await memoryService.findById(targetObject);
        return memory?.dimension ?? null;
      }
    }
  });
  const soulHandler = new SoulSignalHandler({
    receiveSignal: async (signal) => {
      await signalService.receiveSignal(signal);
    },
    applyOverride: async (params) =>
      await sessionOverrideService.apply({
        runId: params.runId,
        workspaceId: params.workspaceId,
        targetObject: params.targetObject,
        correction: params.correction,
        priority: params.priority,
        derivedFrom: params.derivedFrom
      })
  });
  const mcpBridge = new McpBridge({
    soulHandler: async (toolUse, runtimeContext) => await soulHandler.handleToolUse(toolUse, runtimeContext)
  });
  const openaiProvider = {
    send: vi.fn(),
    continueWithToolResults: vi.fn()
  };
  const engine = new APIConversationEngine({
    getEnv: () => "sk-openai",
    mcpBridge,
    openaiProvider
  });
  const localHeuristicsProvider = new LocalHeuristics();
  const officialGardenProvider =
    options.officialGarden === undefined
      ? null
      : new OfficialApiGardenProvider({
          apiKey: "sk-official-test",
          model: OFFICIAL_API_GARDEN_MODEL,
          fetchImpl: options.officialGarden.fetchImpl
        });
  const gardenComputeProvider = officialGardenProvider ?? localHeuristicsProvider;
  const healthJournalService = new HealthJournalService({
    repo: healthJournalRepo,
    eventLogRepo,
    sseBroadcaster: sseManager
  });
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
    isPrincipalCodingEngineAvailable: () => true,
    bindingRepo
  });
  const resolveExecutionStance =
    officialGardenProvider === null
      ? undefined
      : createComputeRoutingExecutionStanceResolver({
          computeRoutingService: new ComputeRoutingService({
            providers: [
              {
                kind: ComputeProviderPriority.OFFICIAL_API,
                provider: officialGardenProvider,
                model_id: OFFICIAL_API_GARDEN_MODEL,
                adapter: "garden.official_api"
              },
              {
                kind: ComputeProviderPriority.STUB,
                provider: localHeuristicsProvider,
                model_id: "local-heuristics",
                adapter: "garden.local_heuristics"
              }
            ]
          }),
          eventLogWriter: eventLogRepo,
          stanceResolutionService: new StanceResolutionService({
            stancePolicyProvider: {
              getPolicy: vi.fn(async () => null)
            },
            eventLogWriter: eventLogRepo
          })
        });
  const conversationService = new ConversationService({
    engine,
    eventPublisher,
    runHotStateService,
    runRepo,
    workspaceRepo,
    eventLogRepo,
    resolveBinding: async () => ({
      binding_id: "binding-default",
      provider: "openai",
      base_url: null,
      model: "gpt-4o-mini",
      api_key: "sk-openai",
      config: {}
    }),
    gardenComputeProvider,
    signalReceiver: signalService,
    sessionOverridePromotion: {
      evaluateActiveForRun: async ({ runId, workspaceId }) => {
        await sessionOverrideRemediation.evaluatePending({
          runId,
          workspaceId,
          overrides: await sessionOverrideService.getActiveFor(runId)
        });
      }
    },
    healthJournalRecorder: healthJournalService,
    resolveExecutionStance,
    warn: vi.fn()
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      principalCodingEngineAvailable: true,
      conversationService,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService,
      evidenceService,
      memoryService,
      healthJournalService,
      sessionOverrideService,
      slotService: createUnusedSlotService("signal route tests") as any,
      surfaceService: createUnusedSurfaceService("signal route tests") as any,
      synthesisService,
      claimService,
      proposalService: createUnusedProposalService("signal route tests") as any
    } as any),
    database,
    eventLogRepo,
    memoryService,
    openaiProvider,
    sessionOverrideService,
    sseManager
  };
}
async function createWorkspace(app: ReturnType<typeof createApp>, name: string): Promise<{
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
  await configureWorkspacePrincipalConversationEngine(app, workspace.workspace_id);
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

async function waitForCondition(condition: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();

  while (!(await condition())) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}




