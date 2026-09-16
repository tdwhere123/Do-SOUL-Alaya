import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";

import { GardenComputeCoordinator } from "../../conversation/garden-compute-coordinator.js";
import {
  createMessage,
  createRun,
  createWorkspace,
  flushBackgroundTasks
} from "./conversation-service.test-support.js";

describe("GardenComputeCoordinator", () => {
  it("does not raise an unhandledRejection when lease release rejects after compile", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const warn = vi.fn();
    const releaseError = new Error("lease release failed");
    const coordinator = new GardenComputeCoordinator({
      runtimeNotifier: { notifyEntry: () => undefined },
      eventLogRepo: {
        queryConversationMessageEventsByRun: vi.fn(async () => []),
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-29T00:00:00.000Z",
          revision: 0,
          ...entry
        }))
      },
      gardenComputeProvider: {
        provider_kind: "local_heuristics",
        compile: vi.fn(async () => [])
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => ({
          signal: null,
          triage_result: "dropped" as const,
          materialization: null
        }))
      },
      warn,
      releaseGovernanceLeaseSafely: vi.fn(async () => {
        throw releaseError;
      })
    });

    try {
      coordinator.triggerCompile({
        run: createRun(),
        workspace: createWorkspace(),
        modelRef: null,
        userMessage: createMessage("msg-user", "user", "remember this"),
        assistantMessage: createMessage("msg-assistant", "assistant", "noted")
      });
      await flushBackgroundTasks();
      await flushBackgroundTasks();

      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Garden compile crashed.",
        expect.objectContaining({ error: releaseError })
      );
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("passes admitted artifact key and source observation into compile", async () => {
    const compile = vi.fn(async () => []);
    const coordinator = new GardenComputeCoordinator({
      runtimeNotifier: { notifyEntry: () => undefined },
      eventLogRepo: {
        queryConversationMessageEventsByRun: vi.fn(async () => []),
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-started",
          created_at: "2026-04-29T00:00:00.000Z",
          revision: 0,
          ...entry
        }))
      },
      gardenComputeProvider: {
        provider_kind: "official_api",
        compile
      },
      signalReceiver: {
        receiveSignal: vi.fn(async () => ({
          signal: null,
          triage_result: "dropped" as const,
          materialization: null
        }))
      },
      warn: vi.fn(),
      releaseGovernanceLeaseSafely: vi.fn(async () => undefined)
    });

    coordinator.triggerCompile({
      run: createRun(),
      workspace: createWorkspace(),
      modelRef: null,
      userMessage: createMessage("msg-user", "user", "remember this"),
      assistantMessage: createMessage("msg-assistant", "assistant", "noted")
    });
    await flushBackgroundTasks();
    await flushBackgroundTasks();

    expect(compile).toHaveBeenCalledWith(
      "remember this",
      expect.objectContaining({
        artifact_key: "garden-compile:workspace-1:run-1:msg-user:msg-assistant",
        source_observation: {
          observed_at: "2026-04-29T00:00:00.000Z",
          authority: "trusted_host_event",
          source_event_id: "event-started"
        }
      })
    );
  });
});
