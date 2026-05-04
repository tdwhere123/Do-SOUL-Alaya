import { describe, expect, it, vi } from "vitest";
import {
  RuntimeMode,
  RunMode,
  RunState,
  WorkspaceRunEventType,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type ContextLens,
  type ConversationMessage,
  type EventLogEntry,
  type Run,
  type Workspace,
  type WorkingProjection
} from "@do-soul/alaya-protocol";
import { CoreError } from "../errors.js";
import { ConversationService, type ConversationServiceDependencies } from "../conversation-service.js";

describe("ConversationService", () => {
  it("conversation fails closed for chat execution surfaces and keeps interrupt unsupported", async () => {
    const { service } = createService();

    await expect(service.sendMessage("run-1", { content: "hello" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Alaya ConversationService does not execute chat turns; use MCP memory tools."
    });
    await expect(service.sendMessageStreaming("run-1", { content: "hello" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Alaya ConversationService does not expose chat streaming; use MCP request/response tools."
    });
    await expect(service.interruptRun("run-1")).resolves.toEqual({
      run_id: "run-1",
      status: "unsupported",
      message: "Alaya does not own an interrupt-capable chat runtime session."
    });
  });

  it("memory orchestration assembles context through ContextLensAssembler and budget mode", async () => {
    const contextLens = createContextLens();
    const workingProjection = createWorkingProjection();
    const contextLensAssembler = {
      assemble: vi.fn(async () => ({ contextLens, workingProjection }))
    };
    const budgetBankruptcyService = {
      getSnapshot: vi.fn(async () => ({ current_mode: RuntimeMode.LEAN }))
    };
    const { service } = createService({ contextLensAssembler, budgetBankruptcyService });

    const result = await service.assembleMemoryContext("run-1", { displayName: "Memory-sensitive request" });

    expect(contextLensAssembler.assemble).toHaveBeenCalledWith({
      run: expect.objectContaining({
        run_id: "run-1",
        workspace_id: "workspace-1",
        run_mode: "chat",
        title: "Run title"
      }),
      surfaceId: "surface://cli/main",
      displayName: "Memory-sensitive request",
      runtimeMode: RuntimeMode.LEAN
    });
    expect(result.contextLens).toBe(contextLens);
    expect(result.workingProjection).toBe(workingProjection);
    expect(result.recalledContextSection).toContain("<recalled_context>");
    expect(result.recalledContextSection).toContain("Use explicit evidence before durable memory.");
  });

  it("memory orchestration returns null context and warns when ContextLens assembly fails", async () => {
    const warn = vi.fn();
    const { service } = createService({
      warn,
      contextLensAssembler: {
        assemble: vi.fn(async () => {
          throw new Error("lens failed");
        })
      }
    });

    const result = await service.assembleMemoryContext("run-1");

    expect(result).toEqual({
      contextLens: null,
      workingProjection: null,
      recalledContextSection: ""
    });
    expect(warn).toHaveBeenCalledWith(
      "[ConversationService] ContextLens assembly failed, proceeding without lens",
      expect.objectContaining({
        run_id: "run-1",
        workspace_id: "workspace-1"
      })
    );
  });

  it("memory orchestration routes Garden signal materialization under governance lease after memory context assembly", async () => {
    const signal = createSignal();
    const eventLogEntries: EventLogEntry[] = [];
    const governanceLeaseService = {
      acquire: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined)
    };
    const signalReceiver = {
      receiveSignal: vi.fn(async (receivedSignal: CandidateMemorySignal) => ({
        signal: receivedSignal,
        triage_result: "accepted" as const,
        materialization: {
          signal_id: receivedSignal.signal_id,
          target_kind: "memory_and_claim" as const,
          routing_reason: "test",
          created_objects: [],
          success: true
        }
      }))
    };
    const contextLensAssembler = {
      assemble: vi.fn(async () => ({
        contextLens: createContextLens(),
        workingProjection: createWorkingProjection()
      }))
    };
    const eventLogRepo = {
      queryByRun: vi.fn(async () => []),
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const saved = {
          event_id: `event-${eventLogEntries.length + 1}`,
          created_at: "2026-04-29T00:00:00.000Z",
          ...entry
        };
        eventLogEntries.push(saved);
        return saved;
      })
    };
    const gardenComputeProvider = {
      provider_kind: "official_api" as const,
      compile: vi.fn(async () => [signal])
    };
    const sessionOverridePromotion = {
      evaluateActiveForRun: vi.fn(async () => undefined)
    };
    const healthJournalRecorder = {
      record: vi.fn(async () => undefined)
    };
    const warn = vi.fn();
    const { service } = createService({
      eventLogRepo,
      governanceLeaseService,
      signalReceiver,
      contextLensAssembler,
      gardenComputeProvider,
      sessionOverridePromotion,
      healthJournalRecorder,
      warn
    });

    const result = await service.orchestrateMemoryTurn({
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "remember explicit evidence"),
      assistantMessage: createMessage("msg-assistant", "assistant", "I will use evidence."),
      modelRef: { provider: "openai", model_id: "gpt-4o-mini" }
    });
    await flushBackgroundTasks();

    expect(result.contextLens?.runtime_id).toBe("lens-runtime-1");
    expect(governanceLeaseService.acquire).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1"
    });
    expect(gardenComputeProvider.compile).toHaveBeenCalledWith(
      "remember explicit evidence",
      expect.objectContaining({
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: "surface://cli/main"
      })
    );
    expect(signalReceiver.receiveSignal).toHaveBeenCalledWith(signal);
    expect(sessionOverridePromotion.evaluateActiveForRun).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1"
    });
    expect(governanceLeaseService.release).toHaveBeenCalledWith("run-1");
    expect(eventLogEntries.map((entry) => entry.event_type)).toEqual([
      "compute.provider.call_started",
      "compute.provider.call_completed"
    ]);
    expect(healthJournalRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: "provider_call",
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    expect(warn).toHaveBeenCalledWith(
      "Garden materialization batch processed.",
      expect.objectContaining({
        total_signals: 1,
        memory_and_claim: 1
      })
    );
  });

  it("memory orchestration releases governance lease when Garden provider resolution fails", async () => {
    const governanceLeaseService = {
      acquire: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined)
    };
    const contextLensAssembler = {
      assemble: vi.fn(async () => ({
        contextLens: createContextLens(),
        workingProjection: createWorkingProjection()
      }))
    };
    const providerError = new Error("provider resolver failed");
    const resolveGardenComputeProvider = {
      resolve: vi.fn(async () => {
        throw providerError;
      })
    };
    const warn = vi.fn();
    const { service } = createService({
      governanceLeaseService,
      contextLensAssembler,
      resolveGardenComputeProvider,
      warn
    });

    await expect(
      service.orchestrateMemoryTurn({
        runId: "run-1",
        userMessage: createMessage("msg-user", "user", "remember explicit evidence"),
        assistantMessage: createMessage("msg-assistant", "assistant", "I will use evidence.")
      })
    ).resolves.toMatchObject({
      contextLens: expect.objectContaining({ runtime_id: "lens-runtime-1" })
    });
    await flushBackgroundTasks();

    expect(resolveGardenComputeProvider.resolve).toHaveBeenCalledTimes(1);
    expect(governanceLeaseService.release).toHaveBeenCalledWith("run-1");
    expect(warn).toHaveBeenCalledWith(
      "Garden compile failed.",
      expect.objectContaining({
        workspace_id: "workspace-1",
        run_id: "run-1",
        provider_kind: "unresolved",
        error: providerError
      })
    );
  });

  it("conversation lists stored messages without executing a chat turn", async () => {
    const eventLogRepo = {
      queryByRun: vi.fn(async () => [
        {
          event_id: "event-user",
          event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
          entity_type: "message",
          entity_id: "msg-user",
          workspace_id: "workspace-1",
          run_id: "run-1",
          caused_by: "user_action",
          revision: 0,
          created_at: "2026-04-29T00:00:00.000Z",
          payload_json: {
            run_id: "run-1",
            role: "user",
            content: "hello",
            message_id: "msg-user"
          }
        }
      ]),
      append: vi.fn()
    };
    const { service } = createService({ eventLogRepo });

    await expect(service.listMessages("run-1")).resolves.toEqual([
      {
        message_id: "msg-user",
        role: "user",
        content: "hello"
      }
    ]);
  });
});

function createService(
  overrides: Partial<ConversationServiceDependencies> = {}
): {
  readonly service: ConversationService;
  readonly dependencies: ConversationServiceDependencies;
} {
  const run = createRun();
  const workspace = createWorkspace();
  const dependencies = {
    runRepo: {
      getById: vi.fn(async (runId: string) => (runId === run.run_id ? run : null))
    },
    workspaceRepo: {
      getById: vi.fn(async (workspaceId: string) => (workspaceId === workspace.workspace_id ? workspace : null))
    },
    eventLogRepo: {
      queryByRun: vi.fn(async () => []),
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
        event_id: "event-1",
        created_at: "2026-04-29T00:00:00.000Z",
        ...entry
      }))
    },
    gardenComputeProvider: {
      provider_kind: "local_heuristics" as const,
      compile: vi.fn(async () => [])
    },
    signalReceiver: {
      receiveSignal: vi.fn(async (signal: CandidateMemorySignal) => ({
        signal,
        triage_result: "dropped" as const,
        materialization: null
      }))
    },
    warn: vi.fn(),
    ...overrides
  } satisfies ConversationServiceDependencies;

  return {
    service: new ConversationService(dependencies),
    dependencies
  };
}

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "Run title",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: "conversation_engine",
    run_state: RunState.IDLE,
    current_surface_id: "surface://cli/main",
    created_at: "2026-04-29T00:00:00.000Z",
    last_active_at: "2026-04-29T00:00:00.000Z",
    ...overrides
  };
}

function createWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    workspace_id: "workspace-1",
    name: "workspace",
    root_path: "/tmp/workspace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    repo_path: null,
    default_engine_binding: null,
    default_engine_class: null,
    workspace_state: WorkspaceState.ACTIVE,
    created_at: "2026-04-29T00:00:00.000Z",
    archived_at: null,
    ...overrides
  };
}

function createContextLens(): ContextLens {
  return {
    runtime_id: "lens-runtime-1",
    object_kind: "context_lens",
    task_surface_ref: "task-surface-runtime-1",
    expires_at: "2026-04-29T01:00:00.000Z",
    derived_from: "task-surface-runtime-1",
    retention_policy: "session_only",
    lens_entries: [
      {
        object_id: "memory-1",
        object_kind: "memory_entry",
        relevance_score: 0.9,
        manifestation: "full_eligible",
        scope_class: "project"
      }
    ],
    not_a_priority_source: true
  };
}

function createWorkingProjection(): WorkingProjection {
  return {
    runtime_id: "projection-runtime-1",
    object_kind: "working_projection",
    task_surface_ref: "task-surface-runtime-1",
    expires_at: "2026-04-29T01:00:00.000Z",
    derived_from: "lens-runtime-1",
    retention_policy: "session_only",
    entries: [
      {
        object_id: "memory-1",
        object_kind: "memory_entry",
        content_snapshot: "Use explicit evidence before durable memory.",
        token_estimate: 11
      }
    ],
    total_token_estimate: 11,
    recall_policy_ref: "recall-policy-runtime-1"
  };
}

function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface://cli/main",
    source: "model_tool",
    signal_kind: "potential_claim",
    signal_state: "emitted",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["memory"],
    confidence: 0.8,
    evidence_refs: ["msg-user"],
    raw_payload: {
      excerpt: "Use explicit evidence before durable memory."
    },
    created_at: "2026-04-29T00:00:00.000Z",
    ...overrides
  };
}

function createMessage(
  messageId: string,
  role: ConversationMessage["role"],
  content: string
): ConversationMessage {
  return {
    message_id: messageId,
    role,
    content
  };
}

async function flushBackgroundTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
