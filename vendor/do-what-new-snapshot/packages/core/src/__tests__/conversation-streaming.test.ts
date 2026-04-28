import { describe, expect, it, vi } from "vitest";
import {
  EngineError,
  EngineErrorKind,
  EngineStatus,
  Phase0EventType,
  PhaseA1EventType,
  PhaseCEventType,
  StreamingEventType,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type AgentRuntimePort,
  type ConversationRequest,
  type EngineBinding,
  type EventLogEntry,
  type MessageDeltaEvent,
  type RuntimeEvent,
  type RuntimeSessionConfig,
  type Run,
  type Workspace
} from "@do-what/protocol";
import { ConversationService } from "../conversation-service.js";
import { StanceResolutionService } from "../stance-resolution-service.js";
import { OutputShapingService } from "../output-shaping-service.js";
import type { TestMock } from "./mock-types.js";

type EventLogDraft = Omit<EventLogEntry, "event_id" | "created_at">;
type EventLogAppendMock = TestMock<(event: EventLogDraft) => Promise<EventLogEntry>>;
type EventLogQueryByRunMock = TestMock<(runId: string) => Promise<readonly EventLogEntry[]>>;
type EventLogQueryByRunAfterEventIdMock = TestMock<
  (runId: string, lastEventId: string) => Promise<readonly EventLogEntry[]>
>;
type BroadcastEntryMock = TestMock<(entry: EventLogEntry) => Promise<void>>;

// ---------------------------------------------------------------------------
// Mock streaming provider helpers
// ---------------------------------------------------------------------------

async function* mockStreamProvider(
  deltas: string[]
): AsyncGenerator<MessageDeltaEvent, void, unknown> {
  for (let i = 0; i < deltas.length; i++) {
    const isLast = i === deltas.length - 1;
    yield {
      type: "message.delta",
      runId: "run-1",
      messageId: "msg-placeholder",
      delta: deltas[i]!,
      index: i,
      finishReason: isLast ? "stop" : undefined,
      timestamp: new Date().toISOString()
    };
  }
}

async function* errorStreamProvider(): AsyncGenerator<MessageDeltaEvent, void, unknown> {
  yield {
    type: "message.delta",
    runId: "run-1",
    messageId: "msg-placeholder",
    delta: "partial content",
    index: 0,
    finishReason: "error",
    timestamp: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Domain fixtures
// ---------------------------------------------------------------------------

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

function createEventEntry(overrides?: Partial<EventLogEntry>): EventLogEntry {
  return {
    event_id: `evt_${Date.now()}_${Math.random()}`,
    created_at: new Date().toISOString(),
    event_type: "run.message.appended",
    entity_type: "message",
    entity_id: "entity_1",
    workspace_id: "ws_1",
    run_id: "run_1",
    caused_by: "test",
    revision: 0,
    payload_json: {},
    ...overrides
  };
}

function createToolStartedEntry(toolCallId: string, toolId: string): EventLogEntry {
  return createEventEntry({
    event_id: `event-tool-started-${toolCallId}`,
    event_type: PhaseA1EventType.TOOL_CALL_STARTED,
    entity_type: "tool_execution",
    entity_id: toolCallId,
    caused_by: "engine",
    payload_json: {
      toolCallId,
      toolId,
      inputSummary: `started ${toolId}`
    }
  });
}

function createToolCompletedEntry(toolCallId: string, outputSummary: string): EventLogEntry {
  return createEventEntry({
    event_id: `event-tool-completed-${toolCallId}`,
    event_type: PhaseA1EventType.TOOL_CALL_COMPLETED,
    entity_type: "tool_execution",
    entity_id: toolCallId,
    caused_by: "engine",
    payload_json: {
      toolCallId,
      statusKind: "success",
      outputSummary,
      durationMs: 5
    }
  });
}

// ---------------------------------------------------------------------------
// Build a minimal ConversationService with streaming deps wired
// ---------------------------------------------------------------------------

interface BuildServiceOptions {
  readonly run?: Run;
  readonly streamMessage?: (req: ConversationRequest) => AsyncGenerator<MessageDeltaEvent, void, unknown>;
  readonly resolveBinding?: TestMock;
  readonly resolveExecutionStance?: ConstructorParameters<typeof ConversationService>[0]["resolveExecutionStance"];
  readonly runtimeAdapterFactory?: () => AgentRuntimePort;
  readonly appendMock?: EventLogAppendMock;
  readonly queryByRunMock?: EventLogQueryByRunMock;
  readonly queryByRunAfterEventIdMock?: EventLogQueryByRunAfterEventIdMock;
  readonly broadcastMock?: BroadcastEntryMock;
  readonly eventPublisherPublishMock?: TestMock;
  readonly setEngineStatusMock?: TestMock;
  readonly compileMock?: TestMock;
  readonly receiveSignalMock?: TestMock;
  readonly outputShapingService?: ConstructorParameters<typeof ConversationService>[0]["outputShapingService"];
  readonly governanceLeaseService?: {
    acquire: TestMock;
    release: TestMock;
  };
  readonly warnMock?: TestMock;
}

function buildService(options: BuildServiceOptions = {}): {
  service: ConversationService;
  run: Run;
  workspace: Workspace;
  appendMock: EventLogAppendMock;
  broadcastMock: BroadcastEntryMock;
  eventPublisherPublishMock: TestMock;
  setEngineStatusMock: TestMock;
  compileMock: TestMock;
  receiveSignalMock: TestMock;
  resolveBindingMock: TestMock;
  governanceLeaseService: {
    acquire: TestMock;
    release: TestMock;
  };
} {
  const run = options.run ?? createRun();
  const workspace = createWorkspace();

  const appendMock = options.appendMock ?? vi.fn(
    async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
      createEventEntry(event as Partial<EventLogEntry>)
  );
  const queryByRunMock = options.queryByRunMock ?? vi.fn(async () => []);
  const queryByRunAfterEventIdMock = options.queryByRunAfterEventIdMock;
  const broadcastMock = options.broadcastMock ?? vi.fn(async () => {});
  const eventPublisherPublishMock = options.eventPublisherPublishMock ?? vi.fn(async () => ({}));
  const setEngineStatusMock = options.setEngineStatusMock ?? vi.fn(async () => {});
  const streamMessage =
    options.streamMessage ?? ((_req: ConversationRequest) => mockStreamProvider(["Hello", " world"]));
  const compileMock = options.compileMock ?? vi.fn(async () => []);
  const receiveSignalMock = options.receiveSignalMock ?? vi.fn(async () => {});
  const governanceLeaseService = options.governanceLeaseService ?? {
    acquire: vi.fn(async () => {}),
    release: vi.fn(async () => {})
  };
  const resolveBindingMock = options.resolveBinding ?? vi.fn(async () => createBinding());
  const warnMock = options.warnMock ?? vi.fn();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ConversationService({
    engine: {
      sendMessage: vi.fn(async () => ({
        message: { role: "assistant" as const, content: "fallback", message_id: "msg_fallback" },
        finish_reason: "stop" as const
      })),
      streamMessage
    },
    eventPublisher: {
      publish: eventPublisherPublishMock
    } as unknown as ConstructorParameters<typeof ConversationService>[0]["eventPublisher"],
    runHotStateService: {
      setEngineStatus: setEngineStatusMock,
      apply: vi.fn(),
      getSnapshot: vi.fn()
    } as unknown as ConstructorParameters<typeof ConversationService>[0]["runHotStateService"],
    runRepo: {
      getById: vi.fn(async () => run)
    },
    workspaceRepo: {
      getById: vi.fn(async () => workspace)
    },
    eventLogRepo: {
      queryByRun: queryByRunMock,
      queryByRunAfterEventId: queryByRunAfterEventIdMock,
      append: appendMock
    },
    sseBroadcaster: {
      broadcast: vi.fn(async () => {}),
      broadcastEntry: broadcastMock
    },
    resolveBinding: resolveBindingMock,
    resolveExecutionStance: options.resolveExecutionStance,
    gardenComputeProvider: {
      provider_kind: "local_heuristics",
      compile: compileMock
    },
    signalReceiver: {
      receiveSignal: receiveSignalMock
    },
    runtimeAdapterFactory: options.runtimeAdapterFactory,
    outputShapingService: options.outputShapingService,
    governanceLeaseService,
    warn: warnMock
  });

  return {
    service,
    run,
    workspace,
    appendMock,
    broadcastMock,
    eventPublisherPublishMock,
    setEngineStatusMock,
    compileMock,
    receiveSignalMock,
    resolveBindingMock,
    governanceLeaseService
  };
}

function createPrincipalRuntimeAdapterMock(
  deltas: readonly string[],
  onCreateSession?: (config: RuntimeSessionConfig) => void,
  onPrompt?: (prompt: string) => void
): AgentRuntimePort {
  const handlers = new Set<(event: RuntimeEvent) => void>();
  let activeSessionId: string | null = null;

  const emit = (event: RuntimeEvent): void => {
    for (const handler of handlers) {
      handler(event);
    }
  };

  return {
    kind: "principal_runtime_mock",
    getCapabilities: () => ({
      supports_resume: false,
      supports_interrupt: true,
      supports_streaming_updates: true,
      supports_tool_events: false,
      supports_permission_requests: false,
      supports_artifact_events: true,
      supports_terminal_events: false
    }),
    createSession: async (config) => {
      onCreateSession?.(config);
      activeSessionId = "principal-runtime-session";
      return { session_id: activeSessionId };
    },
    prompt: async (sessionId, input) => {
      if (activeSessionId !== sessionId) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      onPrompt?.(input.prompt);

      for (let index = 0; index < deltas.length; index++) {
        emit({
          type: "message_delta",
          session_id: sessionId,
          emitted_at: new Date().toISOString(),
          delta: deltas[index]!,
          sequence: index
        });
      }

      emit({
        type: "session_finished",
        session_id: sessionId,
        emitted_at: new Date().toISOString(),
        status: "completed",
        result_summary: null
      });
    },
    cancel: async (sessionId) => ({
      session_id: sessionId,
      status: "already_finished"
    }),
    onEvent: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationService.sendMessageStreaming", () => {
  it("publishes user message event (RUN_MESSAGE_APPENDED) before streaming", async () => {
    const { service, run, appendMock } = buildService();

    await service.sendMessageStreaming(run.run_id, { content: "hello streaming" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userEventCalls = appendMock.mock.calls.filter((args: any[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === Phase0EventType.RUN_MESSAGE_APPENDED;
    });
    expect(userEventCalls).toHaveLength(1);
    expect(userEventCalls[0]![0]).toMatchObject({
      event_type: Phase0EventType.RUN_MESSAGE_APPENDED,
      entity_type: "message",
      run_id: run.run_id,
      caused_by: "user_action",
      payload_json: expect.objectContaining({
        role: "user",
        content: "hello streaming"
      })
    });
  });

  it("calls streamMessage with the assembled request", async () => {
    const streamMessage = vi.fn((_req: ConversationRequest) => mockStreamProvider(["ok"]));
    const { service, run } = buildService({ streamMessage });

    await service.sendMessageStreaming(run.run_id, { content: "test request" });

    expect(streamMessage).toHaveBeenCalledTimes(1);
    const [request] = streamMessage.mock.calls[0]!;
    expect(request!.messages.at(-1)).toMatchObject({ role: "user", content: "test request" });
    expect(request!.systemPrompt).toContain("Workspace: test-ws");
    expect(request!.runtime_context).toMatchObject({
      workspace_id: "ws_1",
      run_id: run.run_id
    });
    expect(request!.binding).toMatchObject(createBinding());
  });

  it("resolves execution stance before dispatching the streaming engine turn", async () => {
    const operationOrder: string[] = [];
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        operationOrder.push(`append:${event.event_type}`);
        return createEventEntry(event as Partial<EventLogEntry>);
      }
    );
    const streamMessage = vi.fn((_req: ConversationRequest) => {
      operationOrder.push("engine.streamMessage");
      return mockStreamProvider(["streamed"]);
    });
    const resolveExecutionStance = new StanceResolutionService({
      stancePolicyProvider: {
        getPolicy: vi.fn(async () => null)
      },
      eventLogWriter: {
        append: appendMock
      },
      now: () => "2026-04-17T00:00:00.000Z",
      generateResolutionId: () => "resolution-live-stream"
    });
    const resolveSpy = vi.spyOn(resolveExecutionStance, "resolve");
    const { service, run, workspace } = buildService({
      appendMock,
      streamMessage,
      resolveExecutionStance
    });

    await service.sendMessageStreaming(run.run_id, { content: "resolve before stream dispatch" });

    expect(resolveSpy).toHaveBeenCalledWith({
      workspaceId: workspace.workspace_id,
      runId: run.run_id,
      candidates: [],
      modelRef: null
    });
    expect(operationOrder).toEqual([
      "append:run.message.appended",
      "append:stance.policy_evaluated",
      "append:stance.resolution_changed",
      "engine.streamMessage",
      "append:message.delta",
      "append:message.completed"
    ]);
    expect(
      appendMock.mock.calls
        .map(([event]) => (event as Omit<EventLogEntry, "event_id" | "created_at">).event_type)
        .filter(
          (eventType) =>
            eventType === PhaseCEventType.STANCE_POLICY_EVALUATED ||
            eventType === PhaseCEventType.STANCE_RESOLUTION_CHANGED
        )
    ).toEqual([
      PhaseCEventType.STANCE_POLICY_EVALUATED,
      PhaseCEventType.STANCE_RESOLUTION_CHANGED
    ]);
  });

  it("routes coding_engine streaming through runtimeAdapterFactory without resolveBinding and still appends message.completed", async () => {
    const run = createRun({ engine_class: "coding_engine" });
    const createdSessionConfigs: RuntimeSessionConfig[] = [];
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );
    const resolveBindingMock = vi.fn(async () => {
      throw new Error("resolveBinding must not be called for coding_engine streaming");
    });
    const runtimeAdapterFactory = vi.fn(() =>
      createPrincipalRuntimeAdapterMock(["runtime ", "reply"], (config) => {
        createdSessionConfigs.push(config);
      })
    );
    const { service } = buildService({
      run,
      appendMock,
      resolveBinding: resolveBindingMock,
      runtimeAdapterFactory
    });

    const response = await service.sendMessageStreaming(run.run_id, { content: "use runtime path" });

    expect(runtimeAdapterFactory).toHaveBeenCalledTimes(1);
    expect(resolveBindingMock).not.toHaveBeenCalled();
    expect(createdSessionConfigs).toHaveLength(1);
    expect(createdSessionConfigs[0]).toMatchObject({
      role: "principal",
      permission_policy: "default",
      workspace_id: "ws_1",
      run_id: run.run_id
    });
    expect(response.content).toBe("runtime reply");
    expect(response.finish_reason).toBe("stop");

    const completedEvents = appendMock.mock.calls.filter((args: unknown[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.[0]).toMatchObject({
      event_type: StreamingEventType.MESSAGE_COMPLETED,
      run_id: run.run_id,
      payload_json: expect.objectContaining({
        type: "message.completed",
        runId: run.run_id,
        content: "runtime reply",
        finishReason: "stop"
      })
    });
  });

  it("publishes Phase C shaping events for repeated tool outputs before returning the completed turn", async () => {
    const appendedEvents: EventLogEntry[] = [];
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const entry = createEventEntry(event as Partial<EventLogEntry>);
        appendedEvents.push(entry);

        if (event.event_type === StreamingEventType.MESSAGE_COMPLETED) {
          const searchToolEvents = [
            createToolStartedEntry("call-1", "tools.search_files"),
            createToolCompletedEntry("call-1", "search result alpha"),
            createToolStartedEntry("call-2", "tools.search_files"),
            createToolCompletedEntry("call-2", "search result beta")
          ];
          appendedEvents.splice(appendedEvents.length - 1, 0, ...searchToolEvents);
        }

        return entry;
      }
    );
    const outputShapingService = new OutputShapingService({
      rules: [
        {
          command_class: "search",
          min_consecutive: 2,
          compression_mode: "last_only"
        }
      ]
    });
    const queryByRunAfterEventIdMock = vi.fn(async (_runId: string, lastEventId: string) => {
      const startIndex = appendedEvents.findIndex((entry) => entry.event_id === lastEventId);
      if (startIndex === -1) {
        return appendedEvents;
      }
      return appendedEvents.slice(startIndex + 1);
    });
    const { service, run, eventPublisherPublishMock } = buildService({
      appendMock,
      queryByRunMock: vi.fn(async () => appendedEvents),
      queryByRunAfterEventIdMock,
      outputShapingService
    });

    const response = await service.sendMessageStreaming(run.run_id, { content: "shape the repeated output" });

    expect(response.content).toBe("Hello world");
    expect(eventPublisherPublishMock).toHaveBeenCalledTimes(2);
    expect(eventPublisherPublishMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_SHAPING_APPLIED,
        entity_type: "output_shaping",
        run_id: run.run_id,
        caused_by: "engine",
        payload_json: expect.objectContaining({
          command_class: "search",
          original_count: 2,
          compressed_to: 1,
          compression_mode: "last_only",
          original_event_ids: ["event-tool-completed-call-1", "event-tool-completed-call-2"]
        })
      })
    );
    expect(eventPublisherPublishMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_COMMAND_COMPRESSED,
        entity_type: "run",
        entity_id: run.run_id,
        run_id: run.run_id,
        payload_json: expect.objectContaining({
          workspace_id: run.workspace_id,
          run_id: run.run_id,
          total_original: 2,
          total_after_shaping: 1,
          compression_ratio: 0.5
        })
      })
    );
  });

  it("publishes shaping events without a second queryByRun scan on the streaming turn", async () => {
    const appendedEvents: EventLogEntry[] = [];
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const entry = createEventEntry(event as Partial<EventLogEntry>);
        appendedEvents.push(entry);

        if (event.event_type === StreamingEventType.MESSAGE_COMPLETED) {
          const searchToolEvents = [
            createToolStartedEntry("call-1", "tools.search_files"),
            createToolCompletedEntry("call-1", "search result alpha"),
            createToolStartedEntry("call-2", "tools.search_files"),
            createToolCompletedEntry("call-2", "search result beta")
          ];
          appendedEvents.splice(appendedEvents.length - 1, 0, ...searchToolEvents);
        }

        return entry;
      }
    );
    const queryByRunMock = vi.fn(async () => appendedEvents);
    const queryByRunAfterEventIdMock = vi.fn(async (_runId: string, lastEventId: string) => {
      const startIndex = appendedEvents.findIndex((entry) => entry.event_id === lastEventId);
      if (startIndex === -1) {
        return appendedEvents;
      }
      return appendedEvents.slice(startIndex + 1);
    });
    const outputShapingService = new OutputShapingService({
      rules: [
        {
          command_class: "search",
          min_consecutive: 2,
          compression_mode: "last_only"
        }
      ]
    });
    const { service, run, eventPublisherPublishMock } = buildService({
      appendMock,
      queryByRunMock,
      queryByRunAfterEventIdMock,
      outputShapingService
    });

    const response = await service.sendMessageStreaming(run.run_id, { content: "shape with one scan" });

    expect(response.content).toBe("Hello world");
    expect(queryByRunMock).toHaveBeenCalledTimes(1);
    expect(queryByRunAfterEventIdMock).toHaveBeenCalledTimes(1);
    expect(eventPublisherPublishMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_SHAPING_APPLIED,
        entity_type: "output_shaping",
        run_id: run.run_id,
        payload_json: expect.objectContaining({
          command_class: "search",
          original_count: 2,
          compressed_to: 1,
          compression_mode: "last_only",
          original_event_ids: ["event-tool-completed-call-1", "event-tool-completed-call-2"]
        })
      })
    );
    expect(eventPublisherPublishMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_COMMAND_COMPRESSED,
        entity_type: "run",
        entity_id: run.run_id,
        payload_json: expect.objectContaining({
          total_original: 2,
          total_after_shaping: 1,
          compression_ratio: 0.5
        })
      })
    );
  });

  it("calls queryByRunAfterEventId as a bound eventLogRepo method", async () => {
    const appendedEvents: EventLogEntry[] = [];
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const entry = createEventEntry(event as Partial<EventLogEntry>);
        appendedEvents.push(entry);

        if (event.event_type === StreamingEventType.MESSAGE_COMPLETED) {
          appendedEvents.splice(
            appendedEvents.length - 1,
            0,
            createToolStartedEntry("call-bound-1", "tools.search_files"),
            createToolCompletedEntry("call-bound-1", "bound search result"),
            createToolStartedEntry("call-bound-2", "tools.search_files"),
            createToolCompletedEntry("call-bound-2", "bound search result")
          );
        }

        return entry;
      }
    );
    const outputShapingService = new OutputShapingService({
      rules: [
        {
          command_class: "search",
          min_consecutive: 2,
          compression_mode: "last_only"
        }
      ]
    });
    const queryByRunAfterEventIdMock = vi.fn(function (
      this: { readonly queryByRunAfterEventId?: unknown } | undefined,
      _runId: string,
      lastEventId: string
    ) {
      expect(this?.queryByRunAfterEventId).toBe(queryByRunAfterEventIdMock);
      const startIndex = appendedEvents.findIndex((entry) => entry.event_id === lastEventId);
      return Promise.resolve(startIndex === -1 ? appendedEvents : appendedEvents.slice(startIndex + 1));
    });
    const warnMock = vi.fn();
    const { service, run, eventPublisherPublishMock } = buildService({
      appendMock,
      queryByRunMock: vi.fn(async () => appendedEvents),
      queryByRunAfterEventIdMock,
      outputShapingService,
      warnMock
    });

    await service.sendMessageStreaming(run.run_id, { content: "shape through bound repo method" });

    expect(queryByRunAfterEventIdMock).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Output shaping failed"),
      expect.anything()
    );
    expect(eventPublisherPublishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_SHAPING_APPLIED,
        payload_json: expect.objectContaining({
          original_event_ids: [
            "event-tool-completed-call-bound-1",
            "event-tool-completed-call-bound-2"
          ]
        })
      })
    );
  });

  it("publishes the Phase C batch event even when no shaping decision is applied", async () => {
    const appendedEvents: EventLogEntry[] = [];
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const entry = createEventEntry(event as Partial<EventLogEntry>);
        appendedEvents.push(entry);

        if (event.event_type === StreamingEventType.MESSAGE_COMPLETED) {
          appendedEvents.splice(
            appendedEvents.length - 1,
            0,
            createToolStartedEntry("call-1", "tools.read_file"),
            createToolCompletedEntry("call-1", "read result")
          );
        }

        return entry;
      }
    );
    const outputShapingService = new OutputShapingService({
      rules: [
        {
          command_class: "file_read",
          min_consecutive: 3,
          compression_mode: "count_summary"
        }
      ]
    });
    const queryByRunAfterEventIdMock = vi.fn(async (_runId: string, lastEventId: string) => {
      const startIndex = appendedEvents.findIndex((entry) => entry.event_id === lastEventId);
      if (startIndex === -1) {
        return appendedEvents;
      }
      return appendedEvents.slice(startIndex + 1);
    });
    const { service, run, eventPublisherPublishMock } = buildService({
      appendMock,
      queryByRunMock: vi.fn(async () => appendedEvents),
      queryByRunAfterEventIdMock,
      outputShapingService
    });

    await service.sendMessageStreaming(run.run_id, { content: "emit flush signal for pass through" });

    expect(eventPublisherPublishMock).toHaveBeenCalledTimes(1);
    expect(eventPublisherPublishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: PhaseCEventType.OUTPUT_COMMAND_COMPRESSED,
        entity_type: "run",
        entity_id: run.run_id,
        run_id: run.run_id,
        payload_json: expect.objectContaining({
          workspace_id: run.workspace_id,
          run_id: run.run_id,
          total_original: 1,
          total_after_shaping: 1,
          compression_ratio: 1
        })
      })
    );
  });

  it("builds coding_engine runtime prompt with system prompt and runtime context", async () => {
    const run = createRun({ engine_class: "coding_engine" });
    const prompts: string[] = [];
    const runtimeAdapterFactory = vi.fn(() =>
      createPrincipalRuntimeAdapterMock(
        ["runtime reply"],
        undefined,
        (prompt) => {
          prompts.push(prompt);
        }
      )
    );
    const { service } = buildService({
      run,
      runtimeAdapterFactory
    });

    await service.sendMessageStreaming(run.run_id, { content: "patch the failing test" });

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain("Reply only as the assistant to the final USER message in the transcript.");
    expect(prompt).toContain("<system_prompt>");
    expect(prompt).toContain("Workspace: test-ws");
    expect(prompt).toContain("<runtime_context>");
    expect(prompt).toContain(`"run_id": "${run.run_id}"`);
    expect(prompt).toContain("<transcript>");
    expect(prompt).toContain("<message role=\"user\">");
    expect(prompt).toContain("patch the failing test");
  });

  it("cancels coding_engine runtime turns when the streaming ceiling is hit", async () => {
    const run = createRun({ engine_class: "coding_engine" });
    const firstChunk = "a".repeat(1024 * 1024);
    const secondChunk = "b".repeat(1024 * 1024);
    const overflowChunk = "!";
    const chunks = [firstChunk, secondChunk, overflowChunk] as const;
    const cancelSpy = vi.fn(async (sessionId: string) => {
      for (const handler of handlers) {
        handler({
          type: "session_finished",
          session_id: sessionId,
          emitted_at: new Date().toISOString(),
          status: "cancelled",
          result_summary: "cancelled at ceiling"
        });
      }

      return {
        session_id: sessionId,
        status: "cancelled" as const
      };
    });
    const handlers = new Set<(event: RuntimeEvent) => void>();
    const runtimeAdapterFactory = vi.fn((): AgentRuntimePort => ({
      kind: "principal_runtime_mock",
      getCapabilities: () => ({
        supports_resume: false,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: false,
        supports_permission_requests: false,
        supports_artifact_events: true,
        supports_terminal_events: false
      }),
      createSession: async () => ({ session_id: "principal-runtime-session" }),
      prompt: async (sessionId) => {
        for (const [index, delta] of chunks.entries()) {
          for (const handler of handlers) {
            handler({
              type: "message_delta",
              session_id: sessionId,
              emitted_at: new Date().toISOString(),
              delta,
              sequence: index
            });
          }
        }
      },
      cancel: cancelSpy,
      onEvent: (handler) => {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      }
    }));
    const { service } = buildService({
      run,
      runtimeAdapterFactory
    });

    const response = await service.sendMessageStreaming(run.run_id, { content: "ceiling test" });

    expect(response.finish_reason).toBe("length");
    expect(response.content.length).toBe(2 * 1024 * 1024);
    expect(cancelSpy).toHaveBeenCalledWith("principal-runtime-session");
  });

  it("writes each delta to EventLog (append) before SSE broadcast", async () => {
    // Track ordered operations with event type context for both append and broadcast
    const operationOrder: Array<{ op: "append" | "broadcast"; eventType: string }> = [];

    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        operationOrder.push({ op: "append", eventType: event.event_type });
        return createEventEntry(event as Partial<EventLogEntry>);
      }
    );
    const broadcastMock = vi.fn(async (entry: EventLogEntry) => {
      operationOrder.push({ op: "broadcast", eventType: entry.event_type });
    });

    const { service, run } = buildService({ appendMock, broadcastMock });

    await service.sendMessageStreaming(run.run_id, { content: "delta order test" });

    // Filter to only streaming delta/completed events (exclude user message)
    const streamingOps = operationOrder.filter(
      (item) =>
        item.eventType === StreamingEventType.MESSAGE_DELTA ||
        item.eventType === StreamingEventType.MESSAGE_COMPLETED
    );

    // Verify each append comes before its paired broadcast
    for (let i = 0; i + 1 < streamingOps.length; i += 2) {
      expect(streamingOps[i]!.op).toBe("append");
      expect(streamingOps[i + 1]!.op).toBe("broadcast");
      expect(streamingOps[i]!.eventType).toBe(streamingOps[i + 1]!.eventType);
    }
    // Ensure we actually had streaming events
    expect(streamingOps.length).toBeGreaterThan(0);
  });

  it("EventLog append is called before broadcastEntry for each delta", async () => {
    const callOrder: Array<{ type: "append" | "broadcast"; eventType: string }> = [];

    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        callOrder.push({ type: "append", eventType: event.event_type });
        return createEventEntry(event as Partial<EventLogEntry>);
      }
    );
    const broadcastMock = vi.fn(async (entry: EventLogEntry) => {
      callOrder.push({ type: "broadcast", eventType: entry.event_type });
    });

    const streamMessage = (_req: ConversationRequest) => mockStreamProvider(["a", "b", "c"]);
    const { service, run } = buildService({ appendMock, broadcastMock, streamMessage });

    await service.sendMessageStreaming(run.run_id, { content: "ordering" });

    // Filter to only streaming events (not the initial user message)
    const streamingOps = callOrder.filter(
      (op) =>
        op.eventType === StreamingEventType.MESSAGE_DELTA ||
        op.eventType === StreamingEventType.MESSAGE_COMPLETED
    );

    // Verify each append comes immediately before a broadcast with the same event type
    for (let i = 0; i + 1 < streamingOps.length; i += 2) {
      expect(streamingOps[i]!.type).toBe("append");
      expect(streamingOps[i + 1]!.type).toBe("broadcast");
      expect(streamingOps[i]!.eventType).toBe(streamingOps[i + 1]!.eventType);
    }
  });

  it("after all deltas: publishes message.completed to EventLog + SSE", async () => {
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );
    const broadcastMock = vi.fn(async () => {});

    const { service, run } = buildService({ appendMock, broadcastMock });

    await service.sendMessageStreaming(run.run_id, { content: "complete me" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completedAppends = appendMock.mock.calls.filter((args: any[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });
    expect(completedAppends).toHaveLength(1);
    expect(completedAppends[0]![0]).toMatchObject({
      event_type: StreamingEventType.MESSAGE_COMPLETED,
      run_id: run.run_id,
      caused_by: "engine"
    });

    // broadcastEntry was called with the completed event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const broadcastedEntries = broadcastMock.mock.calls.map((args: any[]) => args[0] as EventLogEntry);
    const completedBroadcast = broadcastedEntries.find(
      (e) => e.event_type === StreamingEventType.MESSAGE_COMPLETED
    );
    expect(completedBroadcast).toBeDefined();
  });

  it("fires Garden compile after a successful streaming turn and lets Garden release the lease", async () => {
    const compileMock = vi.fn(async () => []);
    const governanceLeaseService = {
      acquire: vi.fn(async () => {}),
      release: vi.fn(async () => {})
    };
    const { service, run } = buildService({
      compileMock,
      governanceLeaseService,
      streamMessage: (_req) => mockStreamProvider(["streamed ", "reply"])
    });

    await service.sendMessageStreaming(run.run_id, { content: "remember this turn" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(compileMock).toHaveBeenCalledWith(
      "remember this turn",
      expect.objectContaining({
        workspace_id: run.workspace_id,
        run_id: run.run_id,
        surface_id: run.current_surface_id,
        turn_messages: [
          expect.objectContaining({ role: "user", content: "remember this turn" }),
          expect.objectContaining({ role: "assistant", content: "streamed reply" })
        ]
      })
    );
    expect(governanceLeaseService.acquire).toHaveBeenCalledWith({
      runId: run.run_id,
      workspaceId: run.workspace_id
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(governanceLeaseService.release).toHaveBeenCalledWith(run.run_id);
  });

  it("logs and suppresses governance lease release failures after streaming Garden work", async () => {
    const releaseError = new Error("event log unavailable");
    const warnMock = vi.fn();
    const governanceLeaseService = {
      acquire: vi.fn(async () => {}),
      release: vi.fn(async () => {
        throw releaseError;
      })
    };
    const { service, run } = buildService({
      governanceLeaseService,
      warnMock,
      streamMessage: (_req) => mockStreamProvider(["streamed ", "reply"])
    });

    await service.sendMessageStreaming(run.run_id, { content: "remember this turn" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(warnMock).toHaveBeenCalledWith(
      "Failed to release governance lease after Garden work",
      expect.objectContaining({
        run_id: run.run_id,
        error: releaseError
      })
    );
  });

  it("does not fire Garden compile when streaming fails", async () => {
    const compileMock = vi.fn(async () => []);
    const { service, run } = buildService({
      compileMock,
      streamMessage: (_req) => errorStreamProvider()
    });

    await service.sendMessageStreaming(run.run_id, { content: "this stream errors" });

    expect(compileMock).not.toHaveBeenCalled();
  });

  it("preserves the original streaming failure when direct lease release fails", async () => {
    const releaseError = new Error("event log unavailable");
    const streamFailure = new Error("stream exploded");
    const warnMock = vi.fn();
    const governanceLeaseService = {
      acquire: vi.fn(async () => {}),
      release: vi.fn(async () => {
        throw releaseError;
      })
    };
    const streamMessage = vi.fn(async function* (_req: ConversationRequest) {
      throw streamFailure;
    });
    const { service, run } = buildService({
      governanceLeaseService,
      streamMessage,
      warnMock
    });

    await expect(service.sendMessageStreaming(run.run_id, { content: "remember this turn" })).rejects.toBe(streamFailure);
    expect(warnMock).toHaveBeenCalledWith(
      "Failed to release governance lease after turn processing",
      expect.objectContaining({
        run_id: run.run_id,
        error: releaseError
      })
    );
  });

  it("accumulated content equals all delta.delta values concatenated", async () => {
    const deltas = ["Hello", ", ", "world", "!"];
    const streamMessage = (_req: ConversationRequest) => mockStreamProvider(deltas);
    const { service, run } = buildService({ streamMessage });

    const response = await service.sendMessageStreaming(run.run_id, { content: "concatenate" });

    expect(response.content).toBe("Hello, world!");
  });

  it("returns ConversationResponse with user_message_id and assistant_message_id", async () => {
    const { service, run } = buildService();

    const response = await service.sendMessageStreaming(run.run_id, { content: "check response shape" });

    expect(response.user_message_id).toMatch(/^msg_user_/);
    expect(response.assistant_message_id).toMatch(/^msg_asst_/);
    expect(response.finish_reason).toBe("stop");
    expect(typeof response.content).toBe("string");
  });

  it("throws when engine.streamMessage is unavailable at runtime", async () => {
    const run = createRun();
    const workspace = createWorkspace();
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );

    const service = new ConversationService({
      engine: {
        sendMessage: vi.fn(async () => ({
          message: { role: "assistant" as const, content: "x", message_id: "m" },
          finish_reason: "stop" as const
        }))
      } as unknown as ConstructorParameters<typeof ConversationService>[0]["engine"],
      eventPublisher: {
        publish: vi.fn()
      } as unknown as ConstructorParameters<typeof ConversationService>[0]["eventPublisher"],
      runHotStateService: {
        setEngineStatus: vi.fn(),
        apply: vi.fn(),
        getSnapshot: vi.fn()
      } as unknown as ConstructorParameters<typeof ConversationService>[0]["runHotStateService"],
      runRepo: {
        getById: vi.fn(async () => run)
      },
      workspaceRepo: {
        getById: vi.fn(async () => workspace)
      },
      eventLogRepo: {
        queryByRun: vi.fn(async () => []),
        append: appendMock
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

    await expect(service.sendMessageStreaming(run.run_id, { content: "no stream" })).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION"
    });
  });

  it("on generator error (yields finishReason: 'error'), still publishes message.completed", async () => {
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );

    const streamMessage = (_req: ConversationRequest) => errorStreamProvider();
    const { service, run } = buildService({ appendMock, streamMessage });

    const response = await service.sendMessageStreaming(run.run_id, { content: "error stream" });

    // Even with finishReason: 'error', message.completed should be published
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completedAppends = appendMock.mock.calls.filter((args: any[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });
    expect(completedAppends).toHaveLength(1);
    expect(response.finish_reason).toBe("error");
    expect(response.content).toBe("partial content");
  });

  it("sets engine status to IDLE after streaming completes", async () => {
    const setEngineStatusMock = vi.fn(async () => {});
    const { service, run } = buildService({ setEngineStatusMock });

    await service.sendMessageStreaming(run.run_id, { content: "status check" });

    expect(setEngineStatusMock).toHaveBeenCalledWith(
      run.run_id,
      EngineStatus.IDLE,
      expect.any(String),
      expect.any(String)
    );
  });

  it("sets engine status to ERROR when streamMessage throws an EngineError", async () => {
    const setEngineStatusMock = vi.fn(async () => {});
    const throwingFn = (_req: ConversationRequest): AsyncGenerator<MessageDeltaEvent, void, unknown> => {
      async function* gen(): AsyncGenerator<MessageDeltaEvent, void, unknown> {
        throw new EngineError("provider failed", EngineErrorKind.MODEL_ERROR);
        // eslint-disable-next-line no-unreachable
        yield undefined as unknown as MessageDeltaEvent;
      }
      return gen();
    };
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );
    const { service, run } = buildService({ setEngineStatusMock, appendMock, streamMessage: throwingFn });

    await expect(
      service.sendMessageStreaming(run.run_id, { content: "trigger error" })
    ).rejects.toMatchObject({ kind: EngineErrorKind.MODEL_ERROR });

    expect(setEngineStatusMock).toHaveBeenCalledWith(run.run_id, EngineStatus.ERROR);
  });

  it("publishes message.completed with finishReason 'error' and broadcasts when generator throws mid-stream", async () => {
    const broadcastMock = vi.fn(async () => {});
    const setEngineStatusMock = vi.fn(async () => {});
    const throwingAfterDelta = (_req: ConversationRequest): AsyncGenerator<MessageDeltaEvent, void, unknown> => {
      async function* gen(): AsyncGenerator<MessageDeltaEvent, void, unknown> {
        yield {
          type: "message.delta",
          runId: "run_1",
          messageId: "msg-placeholder",
          delta: "partial",
          index: 0,
          timestamp: new Date().toISOString()
        };
        throw new Error("network interrupted");
      }
      return gen();
    };
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );
    const { service, run } = buildService({
      setEngineStatusMock,
      appendMock,
      broadcastMock,
      streamMessage: throwingAfterDelta
    });

    await expect(
      service.sendMessageStreaming(run.run_id, { content: "mid-stream fail" })
    ).rejects.toThrow("network interrupted");

    // Verify message.completed(finishReason: "error") was appended
    const completedAppends = appendMock.mock.calls.filter((args: unknown[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });
    expect(completedAppends).toHaveLength(1);
    const completedPayload = (completedAppends[0]![0] as Omit<EventLogEntry, "event_id" | "created_at">).payload_json as {
      finishReason: string;
      content: string;
    };
    expect(completedPayload.finishReason).toBe("error");
    expect(completedPayload.content).toBe("partial");

    // Verify error completion was broadcast
    const completedBroadcasts = broadcastMock.mock.calls.filter((args: unknown[]) => {
      const entry = args[0] as EventLogEntry;
      return entry.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });
    expect(completedBroadcasts).toHaveLength(1);

    // Verify RunHotState was set to ERROR before broadcast
    expect(setEngineStatusMock).toHaveBeenCalledWith(run.run_id, EngineStatus.ERROR);
  });

  // ---------------------------------------------------------------------------
  // C1 regression: two-turn streaming — second turn includes first assistant content
  // ---------------------------------------------------------------------------

  it("C1: second streaming turn includes the first turn's assistant response in request.messages", async () => {
    // Track all appended events so queryByRun can return them on the second call
    const appendedEvents: EventLogEntry[] = [];
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const entry = createEventEntry(event as Partial<EventLogEntry>);
        appendedEvents.push(entry);
        return entry;
      }
    );

    let queryByRunCallCount = 0;
    const queryByRunMock = vi.fn(async () => {
      queryByRunCallCount++;
      // First call returns empty (no history). Second call returns all events from turn 1.
      return queryByRunCallCount <= 1 ? [] : appendedEvents;
    });

    const streamMessageSpy = vi.fn((_req: ConversationRequest) => mockStreamProvider(["First response"]));
    const run = createRun();
    const workspace = createWorkspace();

    const service = new ConversationService({
      engine: {
        sendMessage: vi.fn(async () => ({
          message: { role: "assistant" as const, content: "x", message_id: "m" },
          finish_reason: "stop" as const
        })),
        streamMessage: streamMessageSpy
      },
      eventPublisher: {
        publish: vi.fn()
      } as unknown as ConstructorParameters<typeof ConversationService>[0]["eventPublisher"],
      runHotStateService: {
        setEngineStatus: vi.fn(async () => {}),
        apply: vi.fn(),
        getSnapshot: vi.fn()
      } as unknown as ConstructorParameters<typeof ConversationService>[0]["runHotStateService"],
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: {
        queryByRun: queryByRunMock,
        append: appendMock
      },
      sseBroadcaster: {
        broadcast: vi.fn(async () => {}),
        broadcastEntry: vi.fn(async () => {})
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      warn: vi.fn()
    });

    // Turn 1
    await service.sendMessageStreaming(run.run_id, { content: "Turn 1" });

    // Turn 2 — the second call should carry turn 1's assistant content in the request
    streamMessageSpy.mockImplementation((_req: ConversationRequest) => mockStreamProvider(["Second response"]));
    await service.sendMessageStreaming(run.run_id, { content: "Turn 2" });

    const [secondCallRequest] = streamMessageSpy.mock.calls[1]!;
    const assistantMessages = secondCallRequest!.messages.filter(
      (m: { role: string }) => m.role === "assistant"
    );
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
    expect(assistantMessages[0]!.content).toBe("First response");
  });

  // ---------------------------------------------------------------------------
  // C1 regression: listMessages after streaming includes streamed assistant
  // ---------------------------------------------------------------------------

  it("C1: listMessages after sendMessageStreaming returns the streamed assistant message", async () => {
    const appendedEvents: EventLogEntry[] = [];
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const entry = createEventEntry(event as Partial<EventLogEntry>);
        appendedEvents.push(entry);
        return entry;
      }
    );

    const run = createRun();
    const workspace = createWorkspace();

    const service = new ConversationService({
      engine: {
        sendMessage: vi.fn(async () => ({
          message: { role: "assistant" as const, content: "x", message_id: "m" },
          finish_reason: "stop" as const
        })),
        streamMessage: (_req: ConversationRequest) => mockStreamProvider(["Streamed ", "reply"])
      },
      eventPublisher: {
        publish: vi.fn()
      } as unknown as ConstructorParameters<typeof ConversationService>[0]["eventPublisher"],
      runHotStateService: {
        setEngineStatus: vi.fn(async () => {}),
        apply: vi.fn(),
        getSnapshot: vi.fn()
      } as unknown as ConstructorParameters<typeof ConversationService>[0]["runHotStateService"],
      runRepo: { getById: vi.fn(async () => run) },
      workspaceRepo: { getById: vi.fn(async () => workspace) },
      eventLogRepo: {
        queryByRun: vi.fn(async () => appendedEvents),
        append: appendMock
      },
      sseBroadcaster: {
        broadcast: vi.fn(async () => {}),
        broadcastEntry: vi.fn(async () => {})
      },
      resolveBinding: vi.fn(async () => createBinding()),
      gardenComputeProvider: { provider_kind: "local_heuristics", compile: vi.fn(async () => []) },
      signalReceiver: { receiveSignal: vi.fn(async () => {}) },
      warn: vi.fn()
    });

    await service.sendMessageStreaming(run.run_id, { content: "hello" });
    const messages = await service.listMessages(run.run_id);

    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("Streamed reply");
  });

  it("preserves omitted finishReason in persisted intermediate delta payloads", async () => {
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );

    const { service, run } = buildService({
      appendMock,
      streamMessage: (_req: ConversationRequest) => mockStreamProvider(["first", " second"])
    });

    await service.sendMessageStreaming(run.run_id, { content: "preserve finishReason" });

    const deltaAppends = appendMock.mock.calls.filter((args: unknown[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_DELTA;
    });

    expect(deltaAppends).toHaveLength(2);

    const firstDeltaPayload = (deltaAppends[0]![0] as Omit<EventLogEntry, "event_id" | "created_at">)
      .payload_json as Record<string, unknown>;
    const secondDeltaPayload = (deltaAppends[1]![0] as Omit<EventLogEntry, "event_id" | "created_at">)
      .payload_json as Record<string, unknown>;

    expect(firstDeltaPayload).not.toHaveProperty("finishReason");
    expect(secondDeltaPayload.finishReason).toBe("stop");
  });

  it("treats a null finishReason from the generator like an omitted finishReason", async () => {
    const { service, run, appendMock } = buildService({
      streamMessage: async function* () {
        yield {
          type: "message.delta",
          runId: "run-1",
          messageId: "msg-1",
          delta: "partial",
          index: 0,
          finishReason: null,
          timestamp: new Date().toISOString()
        } as unknown as MessageDeltaEvent;
      }
    });

    await service.sendMessageStreaming(run.run_id, { content: "null finishReason" });

    const deltaEntry = appendMock.mock.calls.find(
      ([entry]) => entry.event_type === StreamingEventType.MESSAGE_DELTA
    )?.[0];

    expect(deltaEntry?.payload_json).not.toHaveProperty("finishReason");
  });

  it("keeps error completion content aligned with persisted deltas when a later delta fails validation", async () => {
    async function* mixedValidityProvider(): AsyncGenerator<MessageDeltaEvent, void, unknown> {
      yield {
        type: "message.delta",
        runId: "run-1",
        messageId: "msg-placeholder",
        delta: "safe",
        index: 0,
        timestamp: new Date().toISOString()
      };
      yield {
        type: "message.delta",
        runId: "run-1",
        messageId: "msg-placeholder",
        delta: " broken",
        index: 1,
        timestamp: "NOT-AN-ISO-TIMESTAMP"
      } as unknown as MessageDeltaEvent;
    }

    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );

    const { service, run } = buildService({
      appendMock,
      streamMessage: (_req: ConversationRequest) => mixedValidityProvider()
    });

    await expect(
      service.sendMessageStreaming(run.run_id, { content: "validation parity" })
    ).rejects.toThrow();

    const deltaAppends = appendMock.mock.calls.filter((args: unknown[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_DELTA;
    });
    const completedAppends = appendMock.mock.calls.filter((args: unknown[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });

    expect(deltaAppends).toHaveLength(1);
    expect(completedAppends).toHaveLength(1);

    const persistedDeltaContent = deltaAppends
      .map((args) => {
        const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
        return (event.payload_json as { delta: string }).delta;
      })
      .join("");
    const completedPayload = (completedAppends[0]![0] as Omit<EventLogEntry, "event_id" | "created_at">)
      .payload_json as { content: string; finishReason: string };

    expect(persistedDeltaContent).toBe("safe");
    expect(completedPayload.finishReason).toBe("error");
    expect(completedPayload.content).toBe(persistedDeltaContent);
  });

  // ---------------------------------------------------------------------------
  // H2 regression: broadcastEntry rejection does not abort stream
  // ---------------------------------------------------------------------------

  it("H2: broadcastEntry rejection mid-stream still persists message.completed and sets IDLE", async () => {
    let broadcastCount = 0;
    const broadcastMock = vi.fn(async () => {
      broadcastCount++;
      // Fail on the 2nd broadcast (the first delta event's broadcast)
      if (broadcastCount === 2) {
        throw new Error("SSE write failed");
      }
    });
    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );
    const setEngineStatusMock = vi.fn(async () => {});

    const { service, run } = buildService({
      appendMock,
      broadcastMock,
      setEngineStatusMock,
      streamMessage: (_req: ConversationRequest) => mockStreamProvider(["a", "b", "c"])
    });

    // Should NOT throw — broadcast failure is swallowed
    const response = await service.sendMessageStreaming(run.run_id, { content: "broadcast fail" });
    expect(response.content).toBe("abc");

    // message.completed was still persisted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completedAppends = appendMock.mock.calls.filter((args: any[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });
    expect(completedAppends).toHaveLength(1);

    // Engine status set to IDLE
    expect(setEngineStatusMock).toHaveBeenCalledWith(
      run.run_id,
      EngineStatus.IDLE,
      expect.any(String),
      expect.any(String)
    );
  });

  // ---------------------------------------------------------------------------
  // H3 regression: content ceiling → finish_reason: "length"
  // ---------------------------------------------------------------------------

  it("H3: streaming loop breaks when content exceeds 2 MiB ceiling", async () => {
    // Create a generator that would emit way too much content
    const bigChunk = "x".repeat(1024 * 1024); // 1 MiB per chunk
    async function* hugeDeltaProvider(): AsyncGenerator<MessageDeltaEvent, void, unknown> {
      for (let i = 0; i < 10; i++) {
        yield {
          type: "message.delta" as const,
          runId: "run-1",
          messageId: "msg-placeholder",
          delta: bigChunk,
          index: i,
          finishReason: undefined,
          timestamp: new Date().toISOString()
        };
      }
    }

    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );

    const { service, run } = buildService({
      appendMock,
      streamMessage: (_req: ConversationRequest) => hugeDeltaProvider()
    });

    const response = await service.sendMessageStreaming(run.run_id, { content: "ceiling test" });

    // Stream should have been cut short with "length" finish reason
    expect(response.finish_reason).toBe("length");

    // message.completed was still written
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completedAppends = appendMock.mock.calls.filter((args: any[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });
    expect(completedAppends).toHaveLength(1);

    // Content stays well below the full 10 MiB provider output because the
    // preflight ceiling stops the loop before the overflow chunk is persisted.
    expect(response.content.length).toBeLessThan(5 * 1024 * 1024);
  });

  it("keeps completed content aligned with persisted deltas when the content ceiling triggers", async () => {
    const firstChunk = "a".repeat(1024 * 1024);
    const secondChunk = "b".repeat(1024 * 1024);
    const overflowChunk = "!";

    async function* ceilingProvider(): AsyncGenerator<MessageDeltaEvent, void, unknown> {
      yield {
        type: "message.delta",
        runId: "run-1",
        messageId: "msg-placeholder",
        delta: firstChunk,
        index: 0,
        timestamp: new Date().toISOString()
      };
      yield {
        type: "message.delta",
        runId: "run-1",
        messageId: "msg-placeholder",
        delta: secondChunk,
        index: 1,
        timestamp: new Date().toISOString()
      };
      yield {
        type: "message.delta",
        runId: "run-1",
        messageId: "msg-placeholder",
        delta: overflowChunk,
        index: 2,
        timestamp: new Date().toISOString()
      };
    }

    const appendMock = vi.fn(
      async (event: Omit<EventLogEntry, "event_id" | "created_at">) =>
        createEventEntry(event as Partial<EventLogEntry>)
    );

    const { service, run } = buildService({
      appendMock,
      streamMessage: (_req: ConversationRequest) => ceilingProvider()
    });

    const response = await service.sendMessageStreaming(run.run_id, { content: "ceiling parity" });

    const deltaAppends = appendMock.mock.calls.filter((args: unknown[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_DELTA;
    });
    const completedAppends = appendMock.mock.calls.filter((args: unknown[]) => {
      const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
      return event.event_type === StreamingEventType.MESSAGE_COMPLETED;
    });

    const persistedDeltaContent = deltaAppends
      .map((args) => {
        const event = args[0] as Omit<EventLogEntry, "event_id" | "created_at">;
        return (event.payload_json as { delta: string }).delta;
      })
      .join("");
    const completedPayload = (completedAppends[0]![0] as Omit<EventLogEntry, "event_id" | "created_at">)
      .payload_json as { content: string; finishReason: string };

    expect(deltaAppends).toHaveLength(2);
    expect(response.finish_reason).toBe("length");
    expect(persistedDeltaContent).toBe(firstChunk + secondChunk);
    expect(response.content).toBe(persistedDeltaContent);
    expect(completedPayload.finishReason).toBe("length");
    expect(completedPayload.content).toBe(persistedDeltaContent);
  });
});
