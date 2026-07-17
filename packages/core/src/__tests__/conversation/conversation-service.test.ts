import { describe, expect, it, vi } from "vitest";
import { RuntimeMode, WorkspaceRunEventType, type CandidateMemorySignal, type EventLogEntry } from "@do-soul/alaya-protocol";

import { createContextLens, createMessage, createService, createSignal, createWorkingProjection, flushBackgroundTasks } from "./conversation-service.test-support.js";

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
    const queryConversationMessageEventsByRun = vi.fn(async () => []);
    const eventLogRepo = {
      queryConversationMessageEventsByRun,
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
        const saved = {
          event_id: `event-${eventLogEntries.length + 1}`,
          created_at: "2026-04-29T00:00:00.000Z",
          revision: 0,
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
    expect(signalReceiver.receiveSignal).toHaveBeenCalledWith({
      ...signal,
      source_observation: {
        authority: "trusted_host_event",
        source_event_id: "event-2",
        observed_at: expect.any(String)
      }
    });
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

  it("binds daemon-owned local Garden compiles to a host completion receipt", async () => {
    const signalReceiver = {
      receiveSignal: vi.fn(async (signal: CandidateMemorySignal) => ({
        signal,
        triage_result: "deferred" as const,
        materialization: null
      }))
    };
    const { service } = createService({
      signalReceiver,
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [createSignal({
          source_observation: {
            authority: "trusted_host_event",
            observed_at: "2020-01-01T00:00:00.000Z",
            source_event_id: "provider-controlled-event"
          }
        })])
      }
    });

    await service.orchestrateMemoryTurn({
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "source receipt"),
      assistantMessage: createMessage("msg-assistant", "assistant", "received")
    });
    await flushBackgroundTasks();

    expect(signalReceiver.receiveSignal).toHaveBeenCalledWith(expect.objectContaining({
      source_observation: {
        authority: "trusted_host_event",
        source_event_id: "event-1",
        observed_at: expect.not.stringContaining("2020-01-01")
      }
    }));
  });

  it("drops a Garden receipt when the daemon cannot append its completion event", async () => {
    const signalReceiver = {
      receiveSignal: vi.fn(async (signal: CandidateMemorySignal) => ({
        signal,
        triage_result: "deferred" as const,
        materialization: null
      }))
    };
    const { service } = createService({
      eventLogRepo: {
        queryConversationMessageEventsByRun: vi.fn(async () => [])
      },
      signalReceiver,
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [createSignal({
          source_observation: {
            authority: "trusted_host_event",
            observed_at: "2020-01-01T00:00:00.000Z",
            source_event_id: "provider-controlled-event"
          }
        })])
      }
    });

    await service.orchestrateMemoryTurn({
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "source receipt"),
      assistantMessage: createMessage("msg-assistant", "assistant", "received")
    });
    await flushBackgroundTasks();

    expect(signalReceiver.receiveSignal).toHaveBeenCalledWith(expect.objectContaining({
      source_observation: null
    }));
  });

  it("drops a Garden receipt when completion event append fails", async () => {
    let appendCount = 0;
    const completionError = new Error("completion append failed");
    const eventLogRepo = {
      queryConversationMessageEventsByRun: vi.fn(async () => []),
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
        appendCount += 1;
        if (appendCount === 2) throw completionError;
        return {
          event_id: "event-1",
          created_at: "2026-04-29T00:00:00.000Z",
          revision: 0,
          ...entry
        };
      })
    };
    const signalReceiver = {
      receiveSignal: vi.fn(async (signal: CandidateMemorySignal) => ({
        signal,
        triage_result: "deferred" as const,
        materialization: null
      }))
    };
    const { service } = createService({
      eventLogRepo,
      signalReceiver,
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [createSignal({
          source_observation: {
            authority: "trusted_host_event",
            observed_at: "2020-01-01T00:00:00.000Z",
            source_event_id: "provider-controlled-event"
          }
        })])
      }
    });

    await service.orchestrateMemoryTurn({
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "source receipt"),
      assistantMessage: createMessage("msg-assistant", "assistant", "received")
    });
    await flushBackgroundTasks();

    expect(eventLogRepo.append).toHaveBeenCalledTimes(2);
    expect(signalReceiver.receiveSignal).toHaveBeenCalledWith(expect.objectContaining({
      source_observation: null
    }));
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

  it("re-resolves the current default Garden provider when the requested model ref does not match", async () => {
    const currentDefaultProvider = {
      provider_kind: "official_api" as const,
      compile: vi.fn(async () => [])
    };
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(currentDefaultProvider);
    const { service, dependencies } = createService({
      resolveGardenComputeProvider: { resolve }
    });

    await service.orchestrateMemoryTurn({
      runId: "run-1",
      userMessage: createMessage("msg-user", "user", "remember this"),
      assistantMessage: createMessage("msg-assistant", "assistant", "noted"),
      modelRef: { provider: "openai", model_id: "stale-model" }
    });
    await flushBackgroundTasks();

    expect(resolve).toHaveBeenNthCalledWith(1, { provider: "openai", model_id: "stale-model" });
    expect(resolve).toHaveBeenNthCalledWith(2, null);
    expect(currentDefaultProvider.compile).toHaveBeenCalledTimes(1);
    expect(dependencies.gardenComputeProvider.compile).not.toHaveBeenCalled();
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
        content: "hello"
      }
    ]);
  });
});
