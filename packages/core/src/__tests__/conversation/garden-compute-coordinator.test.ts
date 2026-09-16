import { describe, expect, it, vi } from "vitest";
import { HealthEventKind } from "@do-soul/alaya-protocol";

import { GardenComputeCoordinator } from "../../conversation/garden-compute-coordinator.js";
import {
  createMessage,
  createRun,
  createWorkspace,
  flushBackgroundTasks
} from "./conversation-service.test-support.js";

describe("GardenComputeCoordinator", () => {
  it("does not raise an unhandledRejection when lease release rejects after enqueue", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const warn = vi.fn();
    const releaseError = new Error("lease release failed");
    const enqueue = vi.fn(() => ({ status: "enqueued" as const }));
    const coordinator = new GardenComputeCoordinator({
      gardenCompileQueue: { enqueue },
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
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "Garden compile enqueue crashed.",
        expect.objectContaining({ error: releaseError })
      );
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("enqueues the turn without compiling in-process", async () => {
    const enqueue = vi.fn(() => ({ status: "enqueued" as const }));
    const healthJournalRecorder = { record: vi.fn(async () => undefined) };
    const coordinator = new GardenComputeCoordinator({
      gardenCompileQueue: { enqueue },
      healthJournalRecorder,
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

    expect(enqueue).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "run-1",
      userMessage: expect.objectContaining({ message_id: "msg-user", content: "remember this" }),
      assistantMessage: expect.objectContaining({ message_id: "msg-assistant" })
    });
    expect(healthJournalRecorder.record).not.toHaveBeenCalled();
  });

  it("records health when the compile queue is missing and does not compile", async () => {
    const healthJournalRecorder = { record: vi.fn(async () => undefined) };
    const warn = vi.fn();
    const coordinator = new GardenComputeCoordinator({
      healthJournalRecorder,
      warn,
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

    expect(healthJournalRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        workspace_id: "workspace-1",
        run_id: "run-1",
        summary: "Garden compile enqueue unavailable.",
        detail_json: expect.objectContaining({
          phase: "compile_enqueue",
          status: "unavailable"
        })
      })
    );
    expect(warn).toHaveBeenCalledWith(
      "Garden compile queue unavailable.",
      expect.objectContaining({
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
  });

  it("records health when enqueue throws and treats duplicate as success", async () => {
    const persistError = new Error("sqlite locked");
    const failingEnqueue = vi.fn(() => {
      throw persistError;
    });
    const duplicateEnqueue = vi.fn(() => ({ status: "duplicate" as const }));
    const healthJournalRecorder = { record: vi.fn(async () => undefined) };
    const warn = vi.fn();
    const failedCoordinator = new GardenComputeCoordinator({
      gardenCompileQueue: { enqueue: failingEnqueue },
      healthJournalRecorder,
      warn,
      releaseGovernanceLeaseSafely: vi.fn(async () => undefined)
    });
    const duplicateCoordinator = new GardenComputeCoordinator({
      gardenCompileQueue: { enqueue: duplicateEnqueue },
      healthJournalRecorder,
      warn,
      releaseGovernanceLeaseSafely: vi.fn(async () => undefined)
    });

    failedCoordinator.triggerCompile({
      run: createRun(),
      workspace: createWorkspace(),
      modelRef: null,
      userMessage: createMessage("msg-user", "user", "remember this"),
      assistantMessage: createMessage("msg-assistant", "assistant", "noted")
    });
    duplicateCoordinator.triggerCompile({
      run: createRun(),
      workspace: createWorkspace(),
      modelRef: null,
      userMessage: createMessage("msg-user", "user", "remember this"),
      assistantMessage: createMessage("msg-assistant", "assistant", "noted")
    });
    await flushBackgroundTasks();
    await flushBackgroundTasks();

    expect(healthJournalRecorder.record).toHaveBeenCalledTimes(1);
    expect(healthJournalRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        summary: "Garden compile enqueue failed.",
        detail_json: expect.objectContaining({
          phase: "compile_enqueue",
          status: "failed",
          error_message: "sqlite locked"
        })
      })
    );
    expect(duplicateEnqueue).toHaveBeenCalledTimes(1);
  });
});
