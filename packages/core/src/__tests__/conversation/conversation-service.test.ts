import { describe, expect, it, vi } from "vitest";
import { HealthEventKind, RuntimeMode, WorkspaceRunEventType } from "@do-soul/alaya-protocol";

import { createContextLens, createMessage, createService, createWorkingProjection, flushBackgroundTasks } from "./conversation-service.test-support.js";

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

  it("falls back to minimal runtime mode and warns when the budget snapshot lookup fails", async () => {
    const contextLens = createContextLens();
    const workingProjection = createWorkingProjection();
    const contextLensAssembler = {
      assemble: vi.fn(async () => ({ contextLens, workingProjection }))
    };
    const snapshotError = new Error("budget repo offline");
    const warn = vi.fn();
    const { service } = createService({
      warn,
      contextLensAssembler,
      budgetBankruptcyService: {
        getSnapshot: vi.fn(async () => {
          throw snapshotError;
        })
      }
    });

    await service.assembleMemoryContext("run-1");

    expect(contextLensAssembler.assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeMode: RuntimeMode.MINIMAL
      })
    );
    expect(warn).toHaveBeenCalledWith(
      "[ConversationService] Budget bankruptcy snapshot lookup failed; using minimal runtime mode",
      expect.objectContaining({
        run_id: "run-1",
        workspace_id: "workspace-1",
        error: snapshotError
      })
    );
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

  it("memory orchestration enqueues Garden compile under a governance lease and does not compile inline", async () => {
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
    const gardenCompileQueue = {
      enqueue: vi.fn(() => ({ status: "enqueued" as const }))
    };
    const healthJournalRecorder = {
      record: vi.fn(async () => undefined)
    };
    const { service } = createService({
      governanceLeaseService,
      contextLensAssembler,
      gardenCompileQueue,
      healthJournalRecorder
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
    expect(gardenCompileQueue.enqueue).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "run-1",
      userMessage: expect.objectContaining({ message_id: "msg-user" }),
      assistantMessage: expect.objectContaining({ message_id: "msg-assistant" })
    });
    expect(healthJournalRecorder.record).not.toHaveBeenCalled();
    expect(governanceLeaseService.release).toHaveBeenCalledWith("run-1");
  });

  it("records health and still returns the turn when Garden compile enqueue is unavailable", async () => {
    const governanceLeaseService = {
      acquire: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined)
    };
    const healthJournalRecorder = {
      record: vi.fn(async () => undefined)
    };
    const warn = vi.fn();
    const { service } = createService({
      governanceLeaseService,
      gardenCompileQueue: undefined,
      healthJournalRecorder,
      warn
    });

    await expect(
      service.orchestrateMemoryTurn({
        runId: "run-1",
        userMessage: createMessage("msg-user", "user", "remember explicit evidence"),
        assistantMessage: createMessage("msg-assistant", "assistant", "I will use evidence.")
      })
    ).resolves.toMatchObject({
      run: expect.objectContaining({ run_id: "run-1" })
    });
    await flushBackgroundTasks();

    expect(healthJournalRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        summary: "Garden compile enqueue unavailable.",
        detail_json: expect.objectContaining({
          phase: "compile_enqueue",
          status: "unavailable"
        })
      })
    );
    expect(governanceLeaseService.release).toHaveBeenCalledWith("run-1");
  });

  it("records health when Garden compile enqueue throws and does not compile inline", async () => {
    const persistError = new Error("garden_tasks locked");
    const healthJournalRecorder = {
      record: vi.fn(async () => undefined)
    };
    const { service } = createService({
      gardenCompileQueue: {
        enqueue: vi.fn(() => {
          throw persistError;
        })
      },
      healthJournalRecorder
    });

    await service.orchestrateMemoryTurn({
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "remember this"),
      assistantMessage: createMessage("msg-assistant", "assistant", "noted")
    });
    await flushBackgroundTasks();

    expect(healthJournalRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        summary: "Garden compile enqueue failed.",
        detail_json: expect.objectContaining({
          phase: "compile_enqueue",
          status: "failed",
          error_message: "garden_tasks locked"
        })
      })
    );
  });

  it("treats a duplicate Garden compile enqueue as success", async () => {
    const healthJournalRecorder = {
      record: vi.fn(async () => undefined)
    };
    const { service } = createService({
      gardenCompileQueue: {
        enqueue: vi.fn(() => ({ status: "duplicate" as const }))
      },
      healthJournalRecorder
    });

    await service.orchestrateMemoryTurn({
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "remember this"),
      assistantMessage: createMessage("msg-assistant", "assistant", "noted")
    });
    await flushBackgroundTasks();

    expect(healthJournalRecorder.record).not.toHaveBeenCalled();
  });

  it("conversation lists stored messages without executing a chat turn", async () => {
    const queryConversationMessageEventsByRun = vi.fn(async () => [
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
      ]);
    const eventLogRepo = {
      queryConversationMessageEventsByRun,
      append: vi.fn()
    };
    const { service } = createService({ eventLogRepo });

    await expect(service.listMessages("run-1")).resolves.toEqual([
      {
        message_id: "msg-user",
        role: "user",
        content: "hello",
        created_at: "2026-04-29T00:00:00.000Z"
      }
    ]);
  });
});
