import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ControlPlaneObjectKind,
  EngineError,
  EngineErrorKind,
  EngineStatus,
  HealthEventKind,
  PhaseCExtensionEventType,
  PhaseCEventType,
  Phase0EventType,
  PhaseA1EventType,
  RetentionPolicy,
  RuntimeMode,
  RunMode,
  RunState,
  type ConversationEnginePort,
  type AgentRuntimePort,
  WorkspaceKind,
  WorkspaceState,
  type ContextLens,
  type WorkingProjection,
  type ConversationRequest,
  type CandidateMemorySignal,
  type EngineBinding,
  type EngineResult,
  type EventLogEntry,
  type RuntimeEvent,
  type Run,
  type Workspace
} from "@do-what/protocol";
import { ConversationService } from "../conversation-service.js";
import { rebuildMessageHistory } from "../message-history.js";
import { OutputShapingService } from "../output-shaping-service.js";
import { StanceResolutionService } from "../stance-resolution-service.js";
import { buildSystemPrompt } from "../system-prompt/template.js";

describe("rebuildMessageHistory", () => {
  it("maps user and assistant events into engine messages in order", () => {
    const events = [
      createEvent({
        event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
        payload_json: {
          run_id: "run_1",
          role: "user",
          content: "first user",
          message_id: "msg_user_1"
        }
      }),
      createEvent({
        event_type: Phase0EventType.ENGINE_RESPONSE_RECEIVED,
        payload_json: {
          run_id: "run_1",
          message_id: "msg_assistant_1",
          content: "first assistant",
          finish_reason: "stop"
        }
      }),
      createEvent({
        event_type: Phase0EventType.RUN_DELETED,
        payload_json: {
          run_id: "run_1",
          workspace_id: "ws_1"
        }
      }),
      createEvent({
        event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
        payload_json: {
          run_id: "run_1",
          role: "user",
          content: "second user",
          message_id: "msg_user_2"
        }
      })
    ];

    expect(rebuildMessageHistory(events)).toEqual([
      { role: "user", content: "first user" },
      { role: "assistant", content: "first assistant" },
      { role: "user", content: "second user" }
    ]);
  });
});

describe("buildSystemPrompt", () => {
  it("includes workspace, goal, mode, and memory signal tools", async () => {
    const prompt = await buildSystemPrompt(createWorkspace(), createRun({ goal: "fix bug", run_mode: RunMode.BUILD }));

    expect(prompt).toContain("Workspace: test-ws");
    expect(prompt).toContain("Run goal: fix bug");
    expect(prompt).toContain("Mode: build");
    expect(prompt).toContain("soul.emit_candidate_signal");
    expect(prompt).toContain("soul.apply_override");
    expect(prompt).toContain("soul.explore_graph");
    // Signal guidelines critical for memory loop correctness
    expect(prompt).toContain("Set `evidence_refs` to [] for new first-time observations");
    expect(prompt).toContain("Set `confidence` based on certainty");
    expect(prompt).toContain("potential_preference");
    expect(prompt).toContain("potential_claim");
  });

  it("falls back to General assistance when the run goal is empty", async () => {
    const prompt = await buildSystemPrompt(createWorkspace(), createRun({ goal: null }));

    expect(prompt).toContain("Run goal: General assistance");
  });
});

describe("ConversationService", () => {
  it("rebuilds history, injects system prompt, and appends user plus assistant events", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const eventLog = [
      createEvent({
        event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
        payload_json: {
          run_id: run.run_id,
          role: "user",
          content: "existing user",
          message_id: "msg_user_existing"
        }
      }),
      createEvent({
        event_type: Phase0EventType.ENGINE_RESPONSE_RECEIVED,
        payload_json: {
          run_id: run.run_id,
          message_id: "msg_assistant_existing",
          content: "existing assistant",
          finish_reason: "stop"
        }
      })
    ];
    const appended: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];
    const eventPublisher = {
      publish: vi.fn(async (event) => {
        appended.push(event);
        return {
          event_id: `evt_${appended.length}`,
          created_at: `2026-03-17T00:00:0${appended.length}.000Z`,
          ...event,
          payload: event.payload_json
        };
      })
    } as any;
    const engineRequests: ConversationRequest[] = [];
    const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: {
              role: "assistant",
              content: "new assistant reply",
              message_id: "msg_assistant_new"
            },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
      eventPublisher,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => eventLog)
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      warn: vi.fn()
    });

    const response = await service.sendMessage(run.run_id, { content: "new user message" });

    expect(response).toMatchObject({
      assistant_message_id: "msg_assistant_new",
      content: "new assistant reply",
      finish_reason: "stop"
    });
    expect(response.user_message_id.startsWith("msg_user_")).toBe(true);

    expect(engineRequests).toHaveLength(1);
    expect(engineRequests[0]).toMatchObject({
      messages: [
        { role: "user", content: "existing user" },
        { role: "assistant", content: "existing assistant" },
        { role: "user", content: "new user message" }
      ],
      contextLens: null,
      runtime_context: expect.objectContaining({
        workspace_id: workspace.workspace_id,
        run_id: run.run_id,
        surface_id: run.current_surface_id,
        user_message_id: response.user_message_id
      }),
      binding: createBinding()
    });
    expect(engineRequests[0].systemPrompt).toContain("Workspace: test-ws");
    expect(engineRequests[0].systemPrompt).toContain("Run goal: fix bug");

    expect(appended).toHaveLength(2);
    expect(appended[0]).toMatchObject({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "message",
      run_id: run.run_id,
      payload_json: {
        run_id: run.run_id,
        role: "user",
        content: "new user message"
      }
    });
    expect(appended[1]).toMatchObject({
      event_type: Phase0EventType.ENGINE_RESPONSE_RECEIVED,
      entity_type: "message",
      entity_id: "msg_assistant_new",
      run_id: run.run_id,
      payload_json: {
        run_id: run.run_id,
        message_id: "msg_assistant_new",
        content: "new assistant reply",
        finish_reason: "stop"
      }
    });
  });

  it("resolves execution stance before dispatching the non-stream engine turn", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const operationOrder: string[] = [];
    const stanceEntries: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];
    const eventPublisher = {
      publish: vi.fn(async (event) => ({
        event_id: `evt_publish_${Date.now()}`,
        created_at: "2026-04-17T00:00:00.000Z",
        ...event,
        payload: event.payload_json
      }))
    } as any;
    const resolveExecutionStance = new StanceResolutionService({
      stancePolicyProvider: {
        getPolicy: vi.fn(async () => null)
      },
      eventLogWriter: {
        append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
          operationOrder.push(`stance:${event.event_type}`);
          stanceEntries.push(event);
          return {
            event_id: `evt_stance_${stanceEntries.length}`,
            created_at: "2026-04-17T00:00:00.000Z",
            ...event
          };
        })
      },
      now: () => "2026-04-17T00:00:00.000Z",
      generateResolutionId: () => "resolution-live-non-stream"
    });
    const resolveSpy = vi.spyOn(resolveExecutionStance, "resolve");
    const engine = createConversationEnginePort(async () => {
      operationOrder.push("engine.sendMessage");
      return {
        message: {
          role: "assistant",
          content: "reply with resolved stance",
          message_id: "msg_assistant_stance"
        },
        finish_reason: "stop"
      } satisfies EngineResult;
    });
    const service = new ConversationService({
      engine,
      eventPublisher,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      resolveExecutionStance,
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      warn: vi.fn()
    });

    await service.sendMessage(run.run_id, { content: "resolve stance before dispatch" });

    expect(resolveSpy).toHaveBeenCalledWith({
      workspaceId: workspace.workspace_id,
      runId: run.run_id,
      candidates: [],
      modelRef: null
    });
    expect(stanceEntries.map((entry) => entry.event_type)).toEqual([
      PhaseCEventType.STANCE_POLICY_EVALUATED,
      PhaseCEventType.STANCE_RESOLUTION_CHANGED
    ]);
    expect(operationOrder).toEqual([
      "stance:stance.policy_evaluated",
      "stance:stance.resolution_changed",
      "engine.sendMessage"
    ]);
  });

  it("publishes shaping events without a second queryByRun scan on the non-streaming turn", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const appended: EventLogEntry[] = [];
    const queryByRun = vi.fn(async () => appended);
    const queryByRunAfterEventId = vi.fn(async (_runId: string, lastEventId: string) => {
      const startIndex = appended.findIndex((entry) => entry.event_id === lastEventId);
      if (startIndex === -1) {
        return appended;
      }
      return appended.slice(startIndex + 1);
    });
    const eventPublisher = {
      publish: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const entry: EventLogEntry = {
          event_id: `evt_${appended.length + 1}`,
          created_at: `2026-04-20T00:00:0${appended.length + 1}.000Z`,
          ...event
        };
        appended.push(entry);

        if (event.event_type === Phase0EventType.ENGINE_RESPONSE_RECEIVED) {
          appended.splice(
            appended.length - 1,
            0,
            createEvent({
              event_type: PhaseA1EventType.TOOL_CALL_STARTED,
              payload_json: {
                toolCallId: "call-1",
                toolId: "tools.search_files",
                inputSummary: "started search 1"
              }
            }),
            createEvent({
              event_type: PhaseA1EventType.TOOL_CALL_COMPLETED,
              payload_json: {
                toolCallId: "call-1",
                statusKind: "success",
                outputSummary: "result alpha",
                durationMs: 5
              }
            }),
            createEvent({
              event_type: PhaseA1EventType.TOOL_CALL_STARTED,
              payload_json: {
                toolCallId: "call-2",
                toolId: "tools.search_files",
                inputSummary: "started search 2"
              }
            }),
            createEvent({
              event_type: PhaseA1EventType.TOOL_CALL_COMPLETED,
              payload_json: {
                toolCallId: "call-2",
                statusKind: "success",
                outputSummary: "result beta",
                durationMs: 5
              }
            })
          );
        }

        return {
          ...entry,
          payload: entry.payload_json
        };
      })
    } as any;
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
        message: {
          role: "assistant",
          content: "shaped reply",
          message_id: "msg_assistant_shape"
        },
        finish_reason: "stop"
      })),
      eventPublisher,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun,
        queryByRunAfterEventId
      },
      resolveBinding: vi.fn(async () => createBinding()),
      outputShapingService: new OutputShapingService({
        rules: [
          {
            command_class: "search",
            min_consecutive: 2,
            compression_mode: "last_only"
          }
        ]
      }),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      warn: vi.fn()
    });

    const response = await service.sendMessage(run.run_id, { content: "shape my search output" });

    expect(response.content).toBe("shaped reply");
    expect(queryByRun).toHaveBeenCalledTimes(1);
    expect(queryByRunAfterEventId).toHaveBeenCalledTimes(1);
    expect(queryByRunAfterEventId).toHaveBeenCalledWith(run.run_id, "evt_1");
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_SHAPING_APPLIED,
        entity_type: "output_shaping",
        run_id: run.run_id,
        caused_by: "engine",
        payload_json: expect.objectContaining({
          command_class: "search",
          original_count: 2,
          compressed_to: 1,
          compression_mode: "last_only"
        })
      })
    );
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_COMMAND_COMPRESSED,
        entity_type: "run",
        entity_id: run.run_id,
        payload_json: expect.objectContaining({
          workspace_id: workspace.workspace_id,
          run_id: run.run_id,
          total_original: 2,
          total_after_shaping: 1,
          compression_ratio: 0.5
        })
      })
    );
  });

  it("falls back to a full queryByRun reread for non-streaming output shaping when incremental lookup is unavailable", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const appended: EventLogEntry[] = [];
    const queryByRun = vi.fn(async () => appended);
    const eventPublisher = {
      publish: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const entry: EventLogEntry = {
          event_id: `evt_${appended.length + 1}`,
          created_at: `2026-04-20T00:00:0${appended.length + 1}.000Z`,
          ...event
        };
        appended.push(entry);

        if (event.event_type === Phase0EventType.ENGINE_RESPONSE_RECEIVED) {
          appended.splice(
            appended.length - 1,
            0,
            createEvent({
              event_type: PhaseA1EventType.TOOL_CALL_STARTED,
              payload_json: {
                toolCallId: "call-1",
                toolId: "tools.search_files",
                inputSummary: "started search 1"
              }
            }),
            createEvent({
              event_type: PhaseA1EventType.TOOL_CALL_COMPLETED,
              payload_json: {
                toolCallId: "call-1",
                statusKind: "success",
                outputSummary: "result alpha",
                durationMs: 5
              }
            }),
            createEvent({
              event_type: PhaseA1EventType.TOOL_CALL_STARTED,
              payload_json: {
                toolCallId: "call-2",
                toolId: "tools.search_files",
                inputSummary: "started search 2"
              }
            }),
            createEvent({
              event_type: PhaseA1EventType.TOOL_CALL_COMPLETED,
              payload_json: {
                toolCallId: "call-2",
                statusKind: "success",
                outputSummary: "result beta",
                durationMs: 5
              }
            })
          );
        }

        return {
          ...entry,
          payload: entry.payload_json
        };
      })
    } as any;
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
        message: {
          role: "assistant",
          content: "shaped reply",
          message_id: "msg_assistant_shape"
        },
        finish_reason: "stop"
      })),
      eventPublisher,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun
      },
      resolveBinding: vi.fn(async () => createBinding()),
      outputShapingService: new OutputShapingService({
        rules: [
          {
            command_class: "search",
            min_consecutive: 2,
            compression_mode: "last_only"
          }
        ]
      }),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      warn: vi.fn()
    });

    const response = await service.sendMessage(run.run_id, { content: "shape my search output" });

    expect(response.content).toBe("shaped reply");
    expect(queryByRun).toHaveBeenCalledTimes(2);
    expect(eventPublisher.publish).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_SHAPING_APPLIED,
        payload_json: expect.objectContaining({
          command_class: "search",
          original_count: 2,
          compressed_to: 1
        })
      })
    );
  });

  it("routes coding_engine sendMessage through the runtime adapter without resolving a conversation binding", async () => {
    const run = createRun({ engine_class: "coding_engine" });
    const workspace = createWorkspace();
    const appended: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const resolveBinding = vi.fn(async () => {
      throw new Error("resolveBinding must not be called for coding_engine sendMessage");
    });
    const runtimeAdapter: AgentRuntimePort = {
      kind: "test_runtime",
      getCapabilities: () => ({
        supports_resume: false,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: false,
        supports_terminal_events: false
      }),
      createSession: vi.fn(async () => ({ session_id: "runtime-session-1" })),
      prompt: vi.fn(async () => {
        for (const handler of handlers) {
          handler({
            type: "message_delta",
            session_id: "runtime-session-1",
            emitted_at: "2026-04-15T00:00:00.000Z",
            delta: "coded reply",
            sequence: 0
          });
          handler({
            type: "session_finished",
            session_id: "runtime-session-1",
            emitted_at: "2026-04-15T00:00:01.000Z",
            status: "completed",
            result_summary: "done"
          });
        }
      }),
      cancel: vi.fn(async () => ({
        session_id: "runtime-session-1",
        status: "cancelled" as const
      })),
      onEvent: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      }
    };
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => {
        throw new Error("conversation engine must not be called for coding_engine sendMessage");
      }),
      eventPublisher: {
        publish: vi.fn()
      } as any,
      runHotStateService: {
        apply: vi.fn(),
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => []),
        append: vi.fn(async (event) => {
          appended.push(event);
          return {
            event_id: `evt_${appended.length}`,
            created_at: `2026-04-15T00:00:0${appended.length}.000Z`,
            ...event
          };
        })
      },
      resolveBinding,
      runtimeAdapter,
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      sseBroadcaster: {
        broadcastEntry: vi.fn(async () => {})
      } as any,
      warn: vi.fn()
    });

    const response = await service.sendMessage(run.run_id, { content: "write a fix" });

    expect(response).toMatchObject({
      content: "coded reply",
      finish_reason: "stop"
    });
    expect(resolveBinding).not.toHaveBeenCalled();
    expect(runtimeAdapter.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "principal",
        permission_policy: "default",
        workspace_id: workspace.workspace_id,
        run_id: run.run_id
      })
    );
    expect(appended.map((entry) => entry.event_type)).toEqual([
      Phase0EventType.RUN_MESSAGE_APPENDED,
      "message.delta",
      "message.completed"
    ]);
  });

  it("resolves allowed_mcp_servers through the runtime seam for coding_engine sessions", async () => {
    const run = createRun({ engine_class: "coding_engine" });
    const workspace = createWorkspace();
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const resolveAllowedMcpServers = vi.fn(async () => ["filesystem", "github"]);
    const runtimeAdapter: AgentRuntimePort = {
      kind: "test_runtime",
      getCapabilities: () => ({
        supports_resume: false,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: false,
        supports_terminal_events: false
      }),
      createSession: vi.fn(async () => ({ session_id: "runtime-session-2" })),
      prompt: vi.fn(async () => {
        for (const handler of handlers) {
          handler({
            type: "session_finished",
            session_id: "runtime-session-2",
            emitted_at: "2026-04-15T00:00:01.000Z",
            status: "completed",
            result_summary: "done"
          });
        }
      }),
      cancel: vi.fn(async () => ({
        session_id: "runtime-session-2",
        status: "cancelled" as const
      })),
      onEvent: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      }
    };
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => {
        throw new Error("conversation engine must not be called for coding_engine sendMessage");
      }),
      eventPublisher: {
        publish: vi.fn()
      } as any,
      runHotStateService: {
        apply: vi.fn(),
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => []),
        append: vi.fn(async (event) => ({
          event_id: "evt-1",
          created_at: "2026-04-15T00:00:00.000Z",
          ...event
        }))
      },
      resolveBinding: vi.fn(async () => createBinding()),
      runtimeAdapter,
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      sseBroadcaster: {
        broadcastEntry: vi.fn(async () => {})
      } as any,
      resolveAllowedMcpServers,
      warn: vi.fn()
    } as any);

    await service.sendMessage(run.run_id, { content: "run external MCP tools" });

    expect(resolveAllowedMcpServers).toHaveBeenCalledWith({
      workspaceId: workspace.workspace_id,
      runId: run.run_id,
      role: "principal"
    });
    expect(runtimeAdapter.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        allowed_mcp_servers: ["filesystem", "github"]
      })
    );
  });

  it("builds coding_engine runtime prompt with recalled context, context lens data, and text attachment contents", async () => {
    const run = createRun({
      engine_class: "coding_engine",
      current_surface_id: "surface://chat/main",
      goal: "fix bug"
    });
    const workspace = createWorkspace();
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const promptInputs: string[] = [];
    const resolveBinding = vi.fn(async () => {
      throw new Error("resolveBinding must not be called for coding_engine sendMessage");
    });
    const runtimeAdapter: AgentRuntimePort = {
      kind: "test_runtime",
      getCapabilities: () => ({
        supports_resume: false,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: false,
        supports_terminal_events: false
      }),
      createSession: vi.fn(async () => ({ session_id: "runtime-session-1" })),
      prompt: vi.fn(async (_sessionId, input) => {
        promptInputs.push(input.prompt);
        for (const handler of handlers) {
          handler({
            type: "message_delta",
            session_id: "runtime-session-1",
            emitted_at: "2026-04-15T00:00:00.000Z",
            delta: "coded with context",
            sequence: 0
          });
          handler({
            type: "session_finished",
            session_id: "runtime-session-1",
            emitted_at: "2026-04-15T00:00:01.000Z",
            status: "completed",
            result_summary: null
          });
        }
      }),
      cancel: vi.fn(async (sessionId: string) => ({
        session_id: sessionId,
        status: "already_finished" as const
      })),
      onEvent: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      }
    };

    const testDir = join(tmpdir(), `conv-svc-coding-prompt-${Date.now()}`);
    const textContent = "attachment body for coding runtime prompt";
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "notes.md"), textContent, "utf-8");

    try {
      const service = new ConversationService({
        engine: createConversationEnginePort(async () => {
          throw new Error("conversation engine must not be called for coding_engine sendMessage");
        }),
        eventPublisher: {
          publish: vi.fn()
        } as any,
        runHotStateService: {
          apply: vi.fn(),
          setEngineStatus: vi.fn()
        } as any,
        runRepo: {
          getById: vi.fn(async () => run)
        },
        workspaceRepo: {
          getById: vi.fn(async () => workspace)
        },
        eventLogRepo: {
          queryByRun: vi.fn(async () => []),
          append: vi.fn(async (event) => ({
            event_id: `evt_${Date.now()}`,
            created_at: "2026-04-15T00:00:00.000Z",
            ...event
          }))
        },
        resolveBinding,
        runtimeAdapter,
        contextLensAssembler: {
          assemble: vi.fn(async () => ({
            contextLens: createContextLens(),
            workingProjection: createWorkingProjection([
              { object_kind: "memory_entry", content_snapshot: "remember this recalled context" }
            ])
          }))
        },
        fileRepo: {
          findById: vi.fn(async (fileId: string) => {
            if (fileId !== "file_txt") {
              return null;
            }
            return {
              file_id: "file_txt",
              filename: "notes.md",
              mime_type: "text/markdown",
              storage_path: "notes.md",
              workspace_id: workspace.workspace_id
            };
          })
        },
        filesDirectory: testDir,
        gardenComputeProvider: {
          provider_kind: "local_heuristics",
          compile: vi.fn(async () => [])
        },
        signalReceiver: {
          receiveSignal: vi.fn(async () => {})
        },
        sseBroadcaster: {
          broadcastEntry: vi.fn(async () => {})
        } as any,
        warn: vi.fn()
      });

      const response = await service.sendMessage(run.run_id, {
        content: "implement using the attached notes",
        file_ids: ["file_txt"]
      });

      expect(response).toMatchObject({
        content: "coded with context",
        finish_reason: "stop"
      });
      expect(resolveBinding).not.toHaveBeenCalled();
      expect(promptInputs).toHaveLength(1);

      const prompt = promptInputs[0]!;
      expect(prompt).toContain("Reply only as the assistant to the final USER message in the transcript.");
      expect(prompt).toContain("<system_prompt>");
      expect(prompt).toContain("Workspace: test-ws");
      expect(prompt).toContain("Run goal: fix bug");
      expect(prompt).toContain("## Recalled Context");
      expect(prompt).toContain("remember this recalled context");
      expect(prompt).toContain("<context_lens>");
      expect(prompt).toContain("lens-runtime-1");
      expect(prompt).toContain("<runtime_context>");
      expect(prompt).toContain(`"run_id": "${run.run_id}"`);
      expect(prompt).toContain("<transcript>");
      expect(prompt).toContain("<message role=\"user\">");
      expect(prompt).toContain("[0] text_file filename=\"notes.md\"");
      expect(prompt).toContain(textContent);
      expect(prompt).not.toContain("[attachments=1]");
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("passes an assembled context lens to the engine when the assembler is wired", async () => {
    const run = createRun({ current_surface_id: "surface://chat/main" });
    const workspace = createWorkspace();
    const eventLog = [] as EventLogEntry[];
    const eventPublisher = {
      publish: vi.fn(async (event) => ({
        event_id: "evt_1",
        created_at: "2026-03-17T00:00:01.000Z",
        ...event,
        payload: event.payload_json
      }))
    } as any;
    const engineRequests: ConversationRequest[] = [];
    const contextLens = createContextLens();
    const contextLensAssembler = {
      assemble: vi.fn(async () => ({
        contextLens,
        workingProjection: createEmptyWorkingProjection()
      }))
    };
    const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: {
              role: "assistant",
              content: "assistant with lens",
              message_id: "msg_assistant_with_lens"
            },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
      eventPublisher,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => eventLog)
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      contextLensAssembler,
      warn: vi.fn()
    });

    const longContent =
      "This message should be truncated before it reaches the assembler because it is intentionally long.";

    await service.sendMessage(run.run_id, {
      content: longContent
    });

    expect(contextLensAssembler.assemble).toHaveBeenCalledWith({
      run,
      surfaceId: "surface://chat/main",
      displayName: longContent.slice(0, 80),
      runtimeMode: RuntimeMode.FULL
    });
    expect(engineRequests[0]?.contextLens).toEqual(contextLens);
  });

  it("falls back to a null context lens when assembly fails", async () => {
    const run = createRun({ current_surface_id: "surface://chat/main" });
    const warn = vi.fn();
    const engineRequests: ConversationRequest[] = [];
    const assemblyError = new Error("lens failed");
    const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: {
              role: "assistant",
              content: "assistant reply",
              message_id: "msg_assistant_new"
            },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      contextLensAssembler: {
        assemble: vi.fn(async () => {
          throw assemblyError;
        })
      },
      warn
    });

    await expect(service.sendMessage(run.run_id, { content: "Hello" })).resolves.toMatchObject({
      assistant_message_id: "msg_assistant_new",
      content: "assistant reply"
    });

    expect(engineRequests[0]?.contextLens).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[ConversationService] ContextLens assembly failed, proceeding without lens",
      expect.objectContaining({
        run_id: run.run_id,
        workspace_id: run.workspace_id,
        error: assemblyError
      })
    );
  });

  it("injects recalled memory content into the system prompt when workingProjection has entries", async () => {
    const run = createRun({ current_surface_id: "surface://chat/main" });
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];
    const contextLens = createContextLens();
    const workingProjection = createWorkingProjection([
      { object_kind: "memory_entry", content_snapshot: "请叫我阿黄" },
      { object_kind: "claim_form", content_snapshot: "不喜欢使用非正式语言" }
    ]);

    const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: { role: "assistant", content: "好的，阿黄！", message_id: "msg_recall" },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: { setEngineStatus: vi.fn() } as any,
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: { queryByRun: vi.fn(async () => []) },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      contextLensAssembler: {
        assemble: vi.fn(async () => ({ contextLens, workingProjection }))
      },
      warn: vi.fn()
    });

    await service.sendMessage(run.run_id, { content: "你还记得我叫什么吗?" });

    const systemPrompt = engineRequests[0]?.systemPrompt ?? "";
    expect(systemPrompt).toContain("## Recalled Context");
    expect(systemPrompt).toContain("<recalled_context>");
    expect(systemPrompt).toContain("</recalled_context>");
    expect(systemPrompt).toContain("[memory_entry] 请叫我阿黄");
    expect(systemPrompt).toContain("[claim_form] 不喜欢使用非正式语言");
    // Entries appear in order
    const idx1 = systemPrompt.indexOf("[memory_entry]");
    const idx2 = systemPrompt.indexOf("[claim_form]");
    expect(idx1).toBeLessThan(idx2);
  });

  it("does not append recalled context section when workingProjection has no entries", async () => {
    const run = createRun({ current_surface_id: "surface://chat/main" });
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];

    const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: { role: "assistant", content: "reply", message_id: "msg_no_recall" },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: { setEngineStatus: vi.fn() } as any,
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: { queryByRun: vi.fn(async () => []) },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      contextLensAssembler: {
        assemble: vi.fn(async () => ({
          contextLens: createContextLens(),
          workingProjection: createEmptyWorkingProjection()
        }))
      },
      warn: vi.fn()
    });

    await service.sendMessage(run.run_id, { content: "Hello" });

    const systemPrompt = engineRequests[0]?.systemPrompt ?? "";
    expect(systemPrompt).not.toContain("## Recalled Context");
  });

  it("marks the hot state as error and rethrows engine failures", async () => {
    const run = createRun();
    const setEngineStatus = vi.fn(async () => {});
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => {
          throw new EngineError("provider rate limited", EngineErrorKind.RATE_LIMIT);
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      warn: vi.fn()
    });

    await expect(service.sendMessage(run.run_id, { content: "Hello" })).rejects.toMatchObject({
      name: "EngineError",
      kind: EngineErrorKind.RATE_LIMIT
    });
    expect(setEngineStatus).toHaveBeenCalledWith(run.run_id, EngineStatus.ERROR);
  });

  it("acquires and releases the governance lease around a successful turn", async () => {
    const run = createRun();
    const compileDeferred = createDeferred<readonly CandidateMemorySignal[]>();
    const governanceLeaseService = {
      acquire: vi.fn(async () => {}),
      release: vi.fn(async () => {})
    };
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: {
            role: "assistant",
            content: "assistant reply",
            message_id: "msg_assistant_new"
          },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => await compileDeferred.promise)
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      governanceLeaseService,
      warn: vi.fn()
    });

    await service.sendMessage(run.run_id, { content: "Hello" });
    // F8: release must stay with Garden until the async compile path settles.
    await flushMicrotasks();

    expect(governanceLeaseService.acquire).toHaveBeenCalledWith({
      runId: run.run_id,
      workspaceId: run.workspace_id
    });
    expect(governanceLeaseService.release).not.toHaveBeenCalled();

    compileDeferred.resolve([]);
    await flushMicrotasks();

    expect(governanceLeaseService.release).toHaveBeenCalledWith(run.run_id);
  });

  it("logs and suppresses governance lease release failures after Garden work", async () => {
    const run = createRun();
    const warn = vi.fn();
    const releaseError = new Error("event log unavailable");
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: {
            role: "assistant",
            content: "assistant reply",
            message_id: "msg_assistant_new"
          },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      governanceLeaseService: {
        acquire: vi.fn(async () => undefined),
        release: vi.fn(async () => {
          throw releaseError;
        })
      },
      warn
    });

    await service.sendMessage(run.run_id, { content: "Hello" });
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      "Failed to release governance lease after Garden work",
      expect.objectContaining({
        run_id: run.run_id,
        error: releaseError
      })
    );
  });

  it("does not fire Garden compile for non-streaming conversation turns that finish with error", async () => {
    const run = createRun();
    const compile = vi.fn(async () => []);
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
        message: {
          role: "assistant",
          content: "blocked by provider",
          message_id: "msg_assistant_error"
        },
        finish_reason: "error"
      } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      warn: vi.fn()
    });

    const response = await service.sendMessage(run.run_id, { content: "Hello" });
    await flushMicrotasks();

    expect(response.finish_reason).toBe("error");
    expect(compile).not.toHaveBeenCalled();
  });

  it("releases the governance lease when turn processing fails", async () => {
    const run = createRun();
    const governanceLeaseService = {
      acquire: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined)
    };
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => {
          throw new EngineError("provider rate limited", EngineErrorKind.RATE_LIMIT);
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn(async () => {})
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      governanceLeaseService,
      warn: vi.fn()
    });

    await expect(service.sendMessage(run.run_id, { content: "Hello" })).rejects.toMatchObject({
      name: "EngineError",
      kind: EngineErrorKind.RATE_LIMIT
    });

    expect(governanceLeaseService.acquire).toHaveBeenCalledWith({
      runId: run.run_id,
      workspaceId: run.workspace_id
    });
    expect(governanceLeaseService.release).toHaveBeenCalledWith(run.run_id);
  });

  it("preserves the original turn failure when direct lease release fails", async () => {
    const run = createRun();
    const releaseError = new Error("event log unavailable");
    const warn = vi.fn();
    const governanceLeaseService = {
      acquire: vi.fn(async () => undefined),
      release: vi.fn(async () => {
        throw releaseError;
      })
    };
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => {
          throw new EngineError("provider rate limited", EngineErrorKind.RATE_LIMIT);
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn(async () => {})
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      governanceLeaseService,
      warn
    });

    await expect(service.sendMessage(run.run_id, { content: "Hello" })).rejects.toMatchObject({
      name: "EngineError",
      kind: EngineErrorKind.RATE_LIMIT
    });
    expect(warn).toHaveBeenCalledWith(
      "Failed to release governance lease after turn processing",
      expect.objectContaining({
        run_id: run.run_id,
        error: releaseError
      })
    );
  });

  it("fires Garden compile asynchronously after a successful turn and forwards emitted signals", async () => {
    const run = createRun();
    const compileDeferred = createDeferred<readonly CandidateMemorySignal[]>();
    const compile = vi.fn(async () => await compileDeferred.promise);
    const receiveSignal = vi.fn(async () => {});
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: {
            role: "assistant",
            content: "assistant reply",
            message_id: "msg_assistant_new"
          },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile
      },
      signalReceiver: {
        receiveSignal
      },
      warn: vi.fn()
    });

    const response = await service.sendMessage(run.run_id, { content: "new user message" });
    await flushMicrotasks();

    expect(response.content).toBe("assistant reply");
    expect(compile).toHaveBeenCalledWith(
      "new user message",
      expect.objectContaining({
        workspace_id: run.workspace_id,
        run_id: run.run_id,
        surface_id: run.current_surface_id,
        turn_messages: [
          expect.objectContaining({ role: "user", content: "new user message" }),
          expect.objectContaining({ role: "assistant", content: "assistant reply" })
        ]
      })
    );
    expect(receiveSignal).not.toHaveBeenCalled();

    compileDeferred.resolve([
      createCandidateSignal("sig_1", "potential_preference"),
      createCandidateSignal("sig_2", "potential_claim")
    ]);
    await flushMicrotasks();

    expect(receiveSignal).toHaveBeenCalledTimes(2);
    expect(receiveSignal).toHaveBeenNthCalledWith(1, expect.objectContaining({ signal_id: "sig_1" }));
    expect(receiveSignal).toHaveBeenNthCalledWith(2, expect.objectContaining({ signal_id: "sig_2" }));
  });

  it("fires session override promotion asynchronously after a successful turn", async () => {
    const run = createRun();
    const evaluateActiveForRun = vi.fn(async () => undefined);
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: {
            role: "assistant",
            content: "assistant reply",
            message_id: "msg_assistant_new"
          },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      sessionOverridePromotion: {
        evaluateActiveForRun
      },
      warn: vi.fn()
    });

    await service.sendMessage(run.run_id, { content: "new user message" });
    await flushMicrotasks();

    expect(evaluateActiveForRun).toHaveBeenCalledWith({
      runId: run.run_id,
      workspaceId: run.workspace_id
    });
  });

  it("logs warn for files that cannot be statted and does not traverse outside filesDirectory", async () => {
    const run = createRun();
    const workspace = createWorkspace();

    const fileRepo = {
      findById: vi.fn(async (fileId: string) => {
        if (fileId === "file_img") {
          return {
            file_id: "file_img",
            filename: "photo.png",
            mime_type: "image/png",
            storage_path: "file_img.png",
            workspace_id: "ws_1"
          };
        }
        if (fileId === "file_txt") {
          return {
            file_id: "file_txt",
            filename: "notes.md",
            mime_type: "text/markdown",
            storage_path: "file_txt.md",
            workspace_id: "ws_1"
          };
        }
        return null;
      })
    };

    // Provide an in-memory readFile by stubbing the module import via a temp directory.
    // Since we can't easily stub node:fs/promises in vitest without a virtual FS,
    // we test the path-resolution guard instead: pass an absolute filesDirectory and
    // a storage_path that escapes it — the attachment should be skipped with a warning.
    const warn = vi.fn();
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: { role: "assistant", content: "reply", message_id: "msg_assistant_1" },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: { setEngineStatus: vi.fn() } as any,
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: { queryByRun: vi.fn(async () => []) },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      fileRepo,
      // Use a non-existent directory so stat will fail; the key check is that
      // the path resolves correctly (no traversal) and the stat failure is logged.
      filesDirectory: "/tmp/test-files-dir",
      warn
    });

    await service.sendMessage(run.run_id, { content: "look at these files", file_ids: ["file_img", "file_txt"] });

    // Warn was called for both files (stat fails because /tmp/test-files-dir doesn't exist),
    // but no unsupported warning about path resolution itself (storage_path is relative, valid).
    expect(warn).toHaveBeenCalledWith(
      "[ConversationService] Failed to stat file attachment, skipping",
      expect.objectContaining({ file_id: "file_img" })
    );
    expect(warn).toHaveBeenCalledWith(
      "[ConversationService] Failed to stat file attachment, skipping",
      expect.objectContaining({ file_id: "file_txt" })
    );
    // Path traversal: path resolution warning should NOT appear for valid relative paths.
    const pathWarns = warn.mock.calls.filter(([msg]) => msg === "[ConversationService] Cannot resolve file path, skipping attachment");
    expect(pathWarns).toHaveLength(0);
  });

  it("skips attachments with path-traversal storage_path and logs a warning", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const warn = vi.fn();
    const engineRequests: ConversationRequest[] = [];

    const fileRepo = {
      findById: vi.fn(async () => ({
        file_id: "file_evil",
        filename: "evil.txt",
        mime_type: "text/plain",
        storage_path: "../../../etc/passwd",
        workspace_id: "ws_1"
      }))
    };

    const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: { role: "assistant", content: "reply", message_id: "msg_1" },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: { setEngineStatus: vi.fn() } as any,
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: { queryByRun: vi.fn(async () => []) },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      fileRepo,
      filesDirectory: "/tmp/test-files-dir",
      warn
    });

    await service.sendMessage(run.run_id, { content: "look", file_ids: ["file_evil"] });

    expect(warn).toHaveBeenCalledWith(
      "[ConversationService] Cannot resolve file path, skipping attachment",
      expect.objectContaining({ file_id: "file_evil", storage_path: "../../../etc/passwd" })
    );
    // Engine still gets called — the attachment is an unsupported placeholder, not a crash.
    expect(engineRequests).toHaveLength(1);
  });

  it("includes resolved attachments in the engine request when files exist on disk", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];

    const testDir = join(tmpdir(), `conv-svc-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    const textContent = "hello from file";
    await writeFile(join(testDir, "notes.md"), textContent, "utf-8");

    try {
      const fileRepo = {
        findById: vi.fn(async (fileId: string) => {
          if (fileId === "file_txt") {
            return {
              file_id: "file_txt",
              filename: "notes.md",
              mime_type: "text/markdown",
              storage_path: "notes.md",
              workspace_id: "ws_1"
            };
          }
          return null;
        })
      };

      const service = new ConversationService({
        engine: createConversationEnginePort(async (request) => {
            engineRequests.push(request);
            return {
              message: { role: "assistant", content: "reply", message_id: "msg_1" },
              finish_reason: "stop"
            } satisfies EngineResult;
          }),
        eventPublisher: {
          publish: vi.fn(async (event) => ({
            event_id: "evt_1",
            created_at: "2026-03-17T00:00:01.000Z",
            ...event,
            payload: event.payload_json
          }))
        } as any,
        runHotStateService: { setEngineStatus: vi.fn() } as any,
        runRepo: { getById: vi.fn(async () => run) },
        workspaceRepo: { getById: vi.fn(async () => workspace) },
        eventLogRepo: { queryByRun: vi.fn(async () => []) },
        resolveBinding: vi.fn(async () => createBinding()),
        gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
        signalReceiver: { receiveSignal: vi.fn(async () => {}) },
        fileRepo,
        filesDirectory: testDir,
        warn: vi.fn()
      });

      await service.sendMessage(run.run_id, { content: "check the file", file_ids: ["file_txt"] });

      expect(engineRequests).toHaveLength(1);
      const lastMessage = engineRequests[0].messages.at(-1);
      expect(lastMessage).toMatchObject({
        role: "user",
        content: "check the file",
        attachments: [{ type: "text_file", filename: "notes.md", content: textContent }]
      });
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("includes image attachments when they are under the 10 MiB size limit", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];
    const warn = vi.fn();
    const imageBytes = Buffer.from("small-image-payload");

    const testDir = join(tmpdir(), `conv-svc-image-under-limit-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "small.png"), imageBytes);

    try {
      const fileRepo = {
        findById: vi.fn(async () => ({
          file_id: "file_img_small",
          filename: "small.png",
          mime_type: "image/png",
          storage_path: "small.png",
          workspace_id: workspace.workspace_id
        }))
      };

      const service = new ConversationService({
        engine: createConversationEnginePort(async (request) => {
            engineRequests.push(request);
            return {
              message: { role: "assistant", content: "reply", message_id: "msg_1" },
              finish_reason: "stop"
            } satisfies EngineResult;
          }),
        eventPublisher: {
          publish: vi.fn(async (event) => ({
            event_id: "evt_1",
            created_at: "2026-03-17T00:00:01.000Z",
            ...event,
            payload: event.payload_json
          }))
        } as any,
        runHotStateService: { setEngineStatus: vi.fn() } as any,
        runRepo: { getById: vi.fn(async () => run) },
        workspaceRepo: { getById: vi.fn(async () => workspace) },
        eventLogRepo: { queryByRun: vi.fn(async () => []) },
        resolveBinding: vi.fn(async () => createBinding()),
        gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
        signalReceiver: { receiveSignal: vi.fn(async () => {}) },
        fileRepo,
        filesDirectory: testDir,
        warn
      });

      await service.sendMessage(run.run_id, { content: "use image", file_ids: ["file_img_small"] });

      expect(engineRequests).toHaveLength(1);
      const lastMessage = engineRequests[0].messages.at(-1);
      expect(lastMessage).toMatchObject({
        role: "user",
        content: "use image",
        attachments: [
          {
            type: "image",
            mime_type: "image/png",
            data: imageBytes.toString("base64")
          }
        ]
      });
      const oversizeWarns = warn.mock.calls.filter(([msg]) => msg === "[ConversationService] File attachment exceeds size limit, skipping");
      expect(oversizeWarns).toHaveLength(0);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("returns unsupported when a text attachment exceeds the 1 MiB size limit", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];
    const warn = vi.fn();
    const textOverLimitBytes = 1 * 1024 * 1024 + 1;

    const testDir = join(tmpdir(), `conv-svc-text-over-limit-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "too-large.md"), "a".repeat(textOverLimitBytes), "utf-8");

    try {
      const fileRepo = {
        findById: vi.fn(async () => ({
          file_id: "file_txt_big",
          filename: "too-large.md",
          mime_type: "text/markdown",
          storage_path: "too-large.md",
          workspace_id: workspace.workspace_id
        }))
      };

      const service = new ConversationService({
        engine: createConversationEnginePort(async (request) => {
            engineRequests.push(request);
            return {
              message: { role: "assistant", content: "reply", message_id: "msg_1" },
              finish_reason: "stop"
            } satisfies EngineResult;
          }),
        eventPublisher: {
          publish: vi.fn(async (event) => ({
            event_id: "evt_1",
            created_at: "2026-03-17T00:00:01.000Z",
            ...event,
            payload: event.payload_json
          }))
        } as any,
        runHotStateService: { setEngineStatus: vi.fn() } as any,
        runRepo: { getById: vi.fn(async () => run) },
        workspaceRepo: { getById: vi.fn(async () => workspace) },
        eventLogRepo: { queryByRun: vi.fn(async () => []) },
        resolveBinding: vi.fn(async () => createBinding()),
        gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
        signalReceiver: { receiveSignal: vi.fn(async () => {}) },
        fileRepo,
        filesDirectory: testDir,
        warn
      });

      await service.sendMessage(run.run_id, { content: "use file", file_ids: ["file_txt_big"] });

      expect(warn).toHaveBeenCalledWith(
        "[ConversationService] File attachment exceeds size limit, skipping",
        expect.objectContaining({
          file_id: "file_txt_big",
          mime_type: "text/markdown",
          file_size_bytes: textOverLimitBytes,
          max_size_bytes: 1 * 1024 * 1024
        })
      );

      expect(engineRequests).toHaveLength(1);
      const lastMessage = engineRequests[0].messages.at(-1);
      expect(lastMessage).toMatchObject({
        role: "user",
        content: "use file",
        attachments: [
          {
            type: "unsupported",
            filename: "too-large.md",
            mime_type: "text/markdown"
          }
        ]
      });
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("returns unsupported when an image attachment exceeds the 10 MiB size limit", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];
    const warn = vi.fn();
    const imageOverLimitBytes = 10 * 1024 * 1024 + 1;

    const testDir = join(tmpdir(), `conv-svc-image-over-limit-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "too-large.png"), Buffer.alloc(imageOverLimitBytes, 1));

    try {
      const fileRepo = {
        findById: vi.fn(async () => ({
          file_id: "file_img_big",
          filename: "too-large.png",
          mime_type: "image/png",
          storage_path: "too-large.png",
          workspace_id: workspace.workspace_id
        }))
      };

      const service = new ConversationService({
        engine: createConversationEnginePort(async (request) => {
            engineRequests.push(request);
            return {
              message: { role: "assistant", content: "reply", message_id: "msg_1" },
              finish_reason: "stop"
            } satisfies EngineResult;
          }),
        eventPublisher: {
          publish: vi.fn(async (event) => ({
            event_id: "evt_1",
            created_at: "2026-03-17T00:00:01.000Z",
            ...event,
            payload: event.payload_json
          }))
        } as any,
        runHotStateService: { setEngineStatus: vi.fn() } as any,
        runRepo: { getById: vi.fn(async () => run) },
        workspaceRepo: { getById: vi.fn(async () => workspace) },
        eventLogRepo: { queryByRun: vi.fn(async () => []) },
        resolveBinding: vi.fn(async () => createBinding()),
        gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
        signalReceiver: { receiveSignal: vi.fn(async () => {}) },
        fileRepo,
        filesDirectory: testDir,
        warn
      });

      await service.sendMessage(run.run_id, { content: "use file", file_ids: ["file_img_big"] });

      expect(warn).toHaveBeenCalledWith(
        "[ConversationService] File attachment exceeds size limit, skipping",
        expect.objectContaining({
          file_id: "file_img_big",
          mime_type: "image/png",
          file_size_bytes: imageOverLimitBytes,
          max_size_bytes: 10 * 1024 * 1024
        })
      );

      expect(engineRequests).toHaveLength(1);
      const lastMessage = engineRequests[0].messages.at(-1);
      expect(lastMessage).toMatchObject({
        role: "user",
        content: "use file",
        attachments: [
          {
            type: "unsupported",
            filename: "too-large.png",
            mime_type: "image/png"
          }
        ]
      });
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("returns unsupported when file stat fails before reading an attachment", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];
    const warn = vi.fn();

    const fileRepo = {
      findById: vi.fn(async () => ({
        file_id: "file_missing",
        filename: "missing.md",
        mime_type: "text/markdown",
        storage_path: "missing.md",
        workspace_id: workspace.workspace_id
      }))
    };

    const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: { role: "assistant", content: "reply", message_id: "msg_1" },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: { setEngineStatus: vi.fn() } as any,
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: { queryByRun: vi.fn(async () => []) },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      fileRepo,
      filesDirectory: "/tmp/conv-svc-stat-missing",
      warn
    });

    await service.sendMessage(run.run_id, { content: "check file", file_ids: ["file_missing"] });

    expect(warn).toHaveBeenCalledWith(
      "[ConversationService] Failed to stat file attachment, skipping",
      expect.objectContaining({
        file_id: "file_missing",
        mime_type: "text/markdown"
      })
    );
    expect(warn).not.toHaveBeenCalledWith(
      "[ConversationService] Failed to read file attachment, skipping",
      expect.any(Object)
    );

    expect(engineRequests).toHaveLength(1);
    const lastMessage = engineRequests[0].messages.at(-1);
    expect(lastMessage).toMatchObject({
      role: "user",
      content: "check file",
      attachments: [
        {
          type: "unsupported",
          filename: "missing.md",
          mime_type: "text/markdown"
        }
      ]
    });
  });

  it("rejects files from a different workspace and logs a warning", async () => {
    const run = createRun(); // workspace_id: "ws_1"
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];
    const warn = vi.fn();

    const fileRepo = {
      findById: vi.fn(async () => ({
        file_id: "file_foreign",
        filename: "secret.md",
        mime_type: "text/markdown",
        storage_path: "secret.md",
        workspace_id: "ws_other" // different workspace
      }))
    };

    const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: { role: "assistant", content: "reply", message_id: "msg_1" },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: { setEngineStatus: vi.fn() } as any,
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: { queryByRun: vi.fn(async () => []) },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      fileRepo,
      filesDirectory: "/tmp/test-files-dir",
      warn
    });

    await service.sendMessage(run.run_id, { content: "use foreign file", file_ids: ["file_foreign"] });

    expect(warn).toHaveBeenCalledWith(
      "[ConversationService] File belongs to a different workspace, skipping attachment",
      expect.objectContaining({ file_id: "file_foreign", file_workspace_id: "ws_other", run_workspace_id: "ws_1" })
    );
    // Engine is still called — foreign file is silently skipped, not a crash.
    expect(engineRequests).toHaveLength(1);
    // No attachments in the engine request message.
    const lastMessage = engineRequests[0].messages.at(-1);
    expect((lastMessage as any).attachments).toBeUndefined();
  });

  it("persists file_ids in the RUN_MESSAGE_APPENDED event when files are attached", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const appended: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];

    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: { role: "assistant", content: "reply", message_id: "msg_1" },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => {
          appended.push(event);
          return {
            event_id: `evt_${appended.length}`,
            created_at: "2026-03-17T00:00:01.000Z",
            ...event,
            payload: event.payload_json
          };
        })
      } as any,
      runHotStateService: { setEngineStatus: vi.fn() } as any,
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: { queryByRun: vi.fn(async () => []) },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      warn: vi.fn()
    });

    await service.sendMessage(run.run_id, { content: "check file", file_ids: ["file_a", "file_b"] });

    const userEvent = appended.find((e) => e.event_type === Phase0EventType.RUN_MESSAGE_APPENDED);
    expect(userEvent?.payload_json).toMatchObject({
      role: "user",
      content: "check file",
      file_ids: ["file_a", "file_b"]
    });
  });

  it("rebuilds historical text-file attachments for a later turn", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const engineRequests: ConversationRequest[] = [];
    const eventLog: EventLogEntry[] = [];
    const fileId = "file_txt";
    const textContent = "# Notes\nremember the attachment history";
    const testDir = join(tmpdir(), `conv-svc-history-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "notes.md"), textContent, "utf-8");

    try {
      const eventPublisher = {
        publish: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
          const entry: EventLogEntry = {
            event_id: `evt_${eventLog.length + 1}`,
            created_at: `2026-03-17T00:00:0${eventLog.length + 1}.000Z`,
            ...event
          };
          eventLog.push(entry);
          return {
            ...entry,
            payload: entry.payload_json
          };
        })
      } as any;
      const fileRepo = {
        findById: vi.fn(async (candidateId: string) => {
          if (candidateId !== fileId) {
            return null;
          }
          return {
            file_id: fileId,
            filename: "notes.md",
            mime_type: "text/markdown",
            storage_path: "notes.md",
            workspace_id: workspace.workspace_id
          };
        })
      };
      const service = new ConversationService({
      engine: createConversationEnginePort(async (request) => {
          engineRequests.push(request);
          return {
            message: {
              role: "assistant",
              content: `reply ${engineRequests.length}`,
              message_id: `msg_assistant_${engineRequests.length}`
            },
            finish_reason: "stop"
          } satisfies EngineResult;
        }),
        eventPublisher,
        runHotStateService: { setEngineStatus: vi.fn() } as any,
        runRepo: { getById: vi.fn(async () => run) },
        workspaceRepo: { getById: vi.fn(async () => workspace) },
        eventLogRepo: { queryByRun: vi.fn(async () => eventLog) },
        resolveBinding: vi.fn(async () => createBinding()),
        gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
        signalReceiver: { receiveSignal: vi.fn(async () => {}) },
        fileRepo,
        filesDirectory: testDir,
        warn: vi.fn()
      });

      await service.sendMessage(run.run_id, {
        content: "please keep this attachment",
        file_ids: [fileId]
      });

      await service.sendMessage(run.run_id, {
        content: "what did the note say?"
      });

      expect(engineRequests).toHaveLength(2);
      expect(engineRequests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "please keep this attachment",
            attachments: [
              {
                type: "text_file",
                filename: "notes.md",
                content: textContent
              }
            ]
          }),
          expect.objectContaining({
            role: "assistant",
            content: "reply 1"
          })
        ])
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("swallows Garden compile failures and signal delivery failures", async () => {
    const run = createRun();
    const warn = vi.fn();
    const receiveSignal = vi.fn(async (_signal: CandidateMemorySignal) => {});
    receiveSignal.mockRejectedValueOnce(new Error("signal store unavailable"));
    const compile = vi
      .fn(async (): Promise<readonly CandidateMemorySignal[]> => [])
      .mockResolvedValueOnce([createCandidateSignal("sig_1", "potential_preference")])
      .mockRejectedValueOnce(new Error("garden failed"));
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: {
            role: "assistant",
            content: "assistant reply",
            message_id: "msg_assistant_new"
          },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => createWorkspace())
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => [])
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile
      },
      signalReceiver: {
        receiveSignal
      },
      warn
    });

    await expect(service.sendMessage(run.run_id, { content: "Hello" })).resolves.toMatchObject({
      assistant_message_id: "msg_assistant_new",
      content: "assistant reply"
    });
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      "Garden signal delivery failed.",
      expect.objectContaining({
        run_id: run.run_id,
        workspace_id: run.workspace_id,
        signal_id: "sig_1",
        error: expect.any(Error)
      })
    );

    await expect(service.sendMessage(run.run_id, { content: "Hello again" })).resolves.toMatchObject({
      assistant_message_id: "msg_assistant_new",
      content: "assistant reply"
    });
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledWith(
      "Garden compile failed.",
      expect.objectContaining({
        run_id: run.run_id,
        workspace_id: run.workspace_id,
        error: expect.any(Error)
      })
    );
  });

  it("emits official provider call started and completed artifacts at the caller boundary", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const appended: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];
    const healthJournalRecorder = {
      record: vi.fn(async () => {})
    };
    const compile = vi.fn(async (): Promise<readonly CandidateMemorySignal[]> => []);
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: {
            role: "assistant",
            content: "assistant reply",
            message_id: "msg_assistant_new"
          },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: `evt_publish_${appended.length + 1}`,
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => []),
        append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
          appended.push(event);
          return {
            event_id: `evt_call_${appended.length}`,
            created_at: `2026-03-17T00:00:0${appended.length}.000Z`,
            ...event,
            payload: event.payload_json
          };
        })
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "official_api",
        compile
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      healthJournalRecorder,
      resolveExecutionStance: {
        resolve: vi.fn(async () => ({
          resolution_id: "stance_resolution_1",
          workspace_id: workspace.workspace_id,
          run_id: run.run_id,
          verification_attention: "standard",
          conservatism: "balanced",
          contributing_candidate_ids: [],
          model_ref: {
            provider: "official_api",
            model_id: "gpt-4.1-mini",
            adapter: "garden.official_api"
          },
          resolved_at: "2026-04-23T00:00:00.000Z"
        } as const))
      },
      warn: vi.fn()
    });

    await expect(service.sendMessage(run.run_id, { content: "Hello" })).resolves.toMatchObject({
      assistant_message_id: "msg_assistant_new",
      content: "assistant reply"
    });
    await flushMicrotasks();

    const providerEvents = appended.filter((entry) =>
      entry.event_type.startsWith("compute.provider.call_")
    );
    expect(providerEvents.map((entry) => entry.event_type)).toEqual([
      PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_STARTED,
      PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_COMPLETED
    ]);

    const startedEntry = providerEvents[0]!;
    const completedEntry = providerEvents[1]!;
    const startedPayload = startedEntry.payload_json as {
      readonly call_id: string;
      readonly workspace_id: string;
      readonly run_id: string;
      readonly provider_kind: string;
      readonly model_id: string;
      readonly operation: string;
      readonly started_at: string;
    };
    const completedPayload = completedEntry.payload_json as {
      readonly call_id: string;
      readonly latency_ms: number;
      readonly completed_at: string;
    };

    expect(startedEntry).toMatchObject({
      entity_type: "compute_provider_call",
      caused_by: "system",
      workspace_id: workspace.workspace_id,
      run_id: run.run_id
    });
    expect(startedPayload).toMatchObject({
      workspace_id: workspace.workspace_id,
      run_id: run.run_id,
      provider_kind: "official_api",
      model_id: "gpt-4.1-mini",
      operation: "garden.compile"
    });
    expect(startedPayload.started_at).toEqual(expect.any(String));
    expect(completedPayload).toMatchObject({
      call_id: startedPayload.call_id
    });
    expect(completedPayload.completed_at).toEqual(expect.any(String));
    expect(completedPayload.latency_ms).toBeGreaterThanOrEqual(0);
    expect(healthJournalRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.PROVIDER_CALL,
        workspace_id: workspace.workspace_id,
        run_id: run.run_id,
        detail_json: expect.objectContaining({
          status: "completed",
          call_id: startedPayload.call_id,
          provider_kind: "official_api",
          model_id: "gpt-4.1-mini",
          operation: "garden.compile"
        })
      })
    );
  });

  it("uses the routed compute provider as the provider/model telemetry authority", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const appended: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];
    const routedCompile = vi.fn(async (): Promise<readonly CandidateMemorySignal[]> => []);
    const fallbackCompile = vi.fn(async (): Promise<readonly CandidateMemorySignal[]> => []);
    const warn = vi.fn();
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
        message: {
          role: "assistant",
          content: "assistant reply",
          message_id: "msg_assistant_new"
        },
        finish_reason: "stop"
      } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: `evt_publish_${appended.length + 1}`,
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => []),
        append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
          appended.push(event);
          return {
            event_id: `evt_call_${appended.length}`,
            created_at: `2026-03-17T00:00:0${appended.length}.000Z`,
            ...event,
            payload: event.payload_json
          };
        })
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "official_api",
        compile: fallbackCompile
      },
      resolveGardenComputeProvider: {
        resolve: vi.fn(async () => ({
          provider_kind: "local_heuristics" as const,
          compile: routedCompile
        }))
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      resolveExecutionStance: {
        resolve: vi.fn(async () => ({
          resolution_id: "stance_resolution_1",
          workspace_id: workspace.workspace_id,
          run_id: run.run_id,
          verification_attention: "standard",
          conservatism: "balanced",
          contributing_candidate_ids: [],
          model_ref: {
            provider: "stub",
            model_id: "local-heuristics",
            adapter: "garden.local_heuristics"
          },
          resolved_at: "2026-04-23T00:00:00.000Z"
        } as const))
      },
      warn
    });

    await expect(service.sendMessage(run.run_id, { content: "Hello" })).resolves.toMatchObject({
      assistant_message_id: "msg_assistant_new",
      content: "assistant reply"
    });
    await flushMicrotasks();

    expect(routedCompile).toHaveBeenCalledTimes(1);
    expect(fallbackCompile).not.toHaveBeenCalled();
    expect(appended.filter((entry) => entry.event_type.startsWith("compute.provider.call_"))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Garden materialization batch processed.",
      expect.objectContaining({
        provider_kind: "local_heuristics"
      })
    );
  });

  it("emits official provider call started and failed artifacts when Garden compile rejects", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const appended: Array<Omit<EventLogEntry, "event_id" | "created_at">> = [];
    const providerFailure = Object.assign(new Error("upstream 503"), {
      kind: "provider_failure"
    });
    const healthJournalRecorder = {
      record: vi.fn(async () => {})
    };
    const service = new ConversationService({
      engine: createConversationEnginePort(async () => ({
          message: {
            role: "assistant",
            content: "assistant reply",
            message_id: "msg_assistant_new"
          },
          finish_reason: "stop"
        } satisfies EngineResult)),
      eventPublisher: {
        publish: vi.fn(async (event) => ({
          event_id: `evt_publish_${appended.length + 1}`,
          created_at: "2026-03-17T00:00:01.000Z",
          ...event,
          payload: event.payload_json
        }))
      } as any,
      runHotStateService: {
        setEngineStatus: vi.fn()
      } as any,
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => []),
        append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
          appended.push(event);
          return {
            event_id: `evt_call_${appended.length}`,
            created_at: `2026-03-17T00:00:0${appended.length}.000Z`,
            ...event,
            payload: event.payload_json
          };
        })
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: {
        provider_kind: "official_api",
        compile: vi.fn(async (): Promise<readonly CandidateMemorySignal[]> => {
          throw providerFailure;
        })
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => {})
      },
      healthJournalRecorder,
      resolveExecutionStance: {
        resolve: vi.fn(async () => ({
          resolution_id: "stance_resolution_1",
          workspace_id: workspace.workspace_id,
          run_id: run.run_id,
          verification_attention: "standard",
          conservatism: "balanced",
          contributing_candidate_ids: [],
          model_ref: {
            provider: "official_api",
            model_id: "gpt-4.1-mini",
            adapter: "garden.official_api"
          },
          resolved_at: "2026-04-23T00:00:00.000Z"
        } as const))
      },
      warn: vi.fn()
    });

    await expect(service.sendMessage(run.run_id, { content: "Hello" })).resolves.toMatchObject({
      assistant_message_id: "msg_assistant_new",
      content: "assistant reply"
    });
    await flushMicrotasks();

    const providerEvents = appended.filter((entry) =>
      entry.event_type.startsWith("compute.provider.call_")
    );
    expect(providerEvents.map((entry) => entry.event_type)).toEqual([
      PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_STARTED,
      PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_FAILED
    ]);

    const startedPayload = providerEvents[0]!.payload_json as {
      readonly call_id: string;
    };
    const failedPayload = providerEvents[1]!.payload_json as {
      readonly call_id: string;
      readonly latency_ms: number;
      readonly error_kind: string;
      readonly error_message: string;
      readonly failed_at: string;
    };

    expect(failedPayload).toMatchObject({
      call_id: startedPayload.call_id,
      error_kind: "provider_failure",
      error_message: "upstream 503"
    });
    expect(failedPayload.failed_at).toEqual(expect.any(String));
    expect(failedPayload.latency_ms).toBeGreaterThanOrEqual(0);
    expect(
      providerEvents.some(
        (entry) => entry.event_type === PhaseCExtensionEventType.COMPUTE_PROVIDER_CALL_COMPLETED
      )
    ).toBe(false);
    expect(healthJournalRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.PROVIDER_CALL,
        workspace_id: workspace.workspace_id,
        run_id: run.run_id,
        detail_json: expect.objectContaining({
          status: "failed",
          call_id: startedPayload.call_id,
          provider_kind: "official_api",
          model_id: "gpt-4.1-mini",
          operation: "garden.compile",
          error_kind: "provider_failure",
          error_message: "upstream 503"
        })
      })
    );
  });
});

function createBinding(): EngineBinding {
  return {
    binding_id: "default",
    provider: "openai",
    base_url: null,
    model: "gpt-4o-mini",
    api_key: "sk-test",
    config: {}
  };
}

function createWorkspace(): Workspace {
  return {
    workspace_id: "ws_1",
    name: "test-ws",
    root_path: "/tmp/test-ws",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    repo_path: null,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE,
    created_at: "2026-03-17T00:00:00.000Z",
    archived_at: null
  };
}

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run_1",
    workspace_id: "ws_1",
    title: "test run",
    goal: "fix bug",
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null,
    created_at: "2026-03-17T00:00:00.000Z",
    last_active_at: "2026-03-17T00:00:00.000Z",
    ...overrides
  };
}

function createEvent({
  event_type,
  payload_json
}: {
  readonly event_type: EventLogEntry["event_type"];
  readonly payload_json: EventLogEntry["payload_json"];
}): EventLogEntry {
  return {
    event_id: `${event_type}_1`,
    event_type,
    entity_type: "message",
    entity_id: "entity_1",
    workspace_id: "ws_1",
    run_id: "run_1",
    caused_by: "test",
    revision: 0,
    payload_json,
    created_at: "2026-03-17T00:00:00.000Z"
  };
}

function createConversationEnginePort(
  sendMessage: ConversationEnginePort["sendMessage"]
): ConversationEnginePort {
  return {
    sendMessage,
    streamMessage: defaultStreamMessage
  };
}

const defaultStreamMessage: ConversationEnginePort["streamMessage"] = async function* () {
  throw new Error("streamMessage should not be called in non-streaming conversation-service tests");
};

function createCandidateSignal(
  signalId: string,
  signalKind: "potential_preference" | "potential_claim"
): CandidateMemorySignal {
  return {
    signal_id: signalId,
    workspace_id: "ws_1",
    run_id: "run_1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: signalKind,
    signal_state: "emitted",
    object_kind: signalKind === "potential_preference" ? "preference" : "decision",
    scope_hint: null,
    domain_tags: [],
    confidence: 0.5,
    evidence_refs: [],
    raw_payload: {
      excerpt: "garden extracted signal"
    },
    created_at: "2026-03-17T00:00:00.000Z"
  } as const;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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


function createContextLens(): ContextLens {
  return {
    runtime_id: "lens-runtime-1",
    object_kind: ControlPlaneObjectKind.CONTEXT_LENS,
    task_surface_ref: "task-surface-runtime-1",
    expires_at: "2026-03-17T00:30:00.000Z",
    derived_from: "task-surface-runtime-1",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    lens_entries: [
      {
        object_id: "memory-1",
        object_kind: "memory_entry",
        relevance_score: 0.9,
        manifestation: "full_eligible"
      }
    ],
    not_a_priority_source: true
  };
}

function createEmptyWorkingProjection(): WorkingProjection {
  return {
    runtime_id: "proj-runtime-1",
    object_kind: ControlPlaneObjectKind.WORKING_PROJECTION,
    task_surface_ref: "task-surface-runtime-1",
    expires_at: "2026-03-17T00:30:00.000Z",
    derived_from: "lens-runtime-1",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    entries: [],
    total_token_estimate: 0,
    recall_policy_ref: null
  };
}

function createWorkingProjection(
  entries: readonly { object_kind: string; content_snapshot: string }[]
): WorkingProjection {
  return {
    ...createEmptyWorkingProjection(),
    entries: entries.map((e, i) => ({
      object_id: `obj-${i}`,
      object_kind: e.object_kind,
      content_snapshot: e.content_snapshot,
      token_estimate: Math.ceil(e.content_snapshot.length / 4)
    })),
    total_token_estimate: entries.reduce((sum, e) => sum + Math.ceil(e.content_snapshot.length / 4), 0)
  };
}
