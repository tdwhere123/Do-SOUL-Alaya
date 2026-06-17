import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import { createRuntimeNotifier } from "../../runtime/runtime-notifier.js";

describe("RuntimeNotifier", () => {
  async function importRuntimeNotifierWithMockedWarnLogger(warn: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.doMock("../../runtime/daemon-runtime-helpers.js", async () => {
      const actual = await vi.importActual<typeof import("../../runtime/daemon-runtime-helpers.js")>(
        "../../runtime/daemon-runtime-helpers.js"
      );
      return {
        ...actual,
        createWarnLogger: () => ({
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn,
          error: vi.fn(),
          fatal: vi.fn()
        })
      };
    });
    const mod = await import("../../runtime/runtime-notifier.js");
    return {
      createRuntimeNotifier: mod.createRuntimeNotifier,
      cleanup: () => {
        vi.doUnmock("../../runtime/daemon-runtime-helpers.js");
        vi.resetModules();
      }
    };
  }

  it("dispatches entries to entry and workspace listeners", async () => {
    const notifier = createRuntimeNotifier();
    const entryListener = vi.fn();
    const workspaceListener = vi.fn();
    notifier.subscribeEntries(entryListener);
    notifier.subscribeWorkspace("ws-1", workspaceListener);

    await notifier.notifyEntry({
      event_id: "event-1",
      event_type: "memory.created" as EventLogEntry["event_type"],
      entity_type: "memory_entry",
      entity_id: "memory-1",
      workspace_id: "ws-1",
      run_id: null,
      caused_by: "test",
      revision: 1,
      created_at: "2026-04-30T00:00:00.000Z",
      payload_json: {}
    });

    expect(entryListener).toHaveBeenCalledTimes(1);
    expect(workspaceListener).toHaveBeenCalledTimes(1);
  });

  it("isolates listener exceptions: throwing listener does not block siblings", async () => {
    const warn = vi.fn();
    const { createRuntimeNotifier: createIsolatedRuntimeNotifier, cleanup } =
      await importRuntimeNotifierWithMockedWarnLogger(warn);
    const notifier = createIsolatedRuntimeNotifier();
    const calls: string[] = [];
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    notifier.subscribeEntries(async () => {
      calls.push("a");
      throw new Error("listener-a-down");
    });
    notifier.subscribeEntries(async () => {
      calls.push("b");
    });

    try {
      await expect(
        notifier.notifyEntry({
          event_id: "event-iso-1",
          event_type: "memory.created" as EventLogEntry["event_type"],
          entity_type: "memory_entry",
          entity_id: "memory-iso-1",
          workspace_id: "ws-iso",
          run_id: null,
          caused_by: "test",
          revision: 1,
          created_at: "2026-04-30T00:00:00.000Z",
          payload_json: {}
        })
      ).resolves.toBeUndefined();

      expect(calls).toEqual(["a", "b"]);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[runtime-notifier] listener threw; continuing fan-out", {
        errorName: "Error",
        errorMessageRedacted: true
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("listener-a-down");
    } finally {
      consoleWarnSpy.mockRestore();
      cleanup();
    }
  });

  it("workspace listener exception does not block run-level dispatch", async () => {
    const warn = vi.fn();
    const { createRuntimeNotifier: createIsolatedRuntimeNotifier, cleanup } =
      await importRuntimeNotifierWithMockedWarnLogger(warn);
    const notifier = createIsolatedRuntimeNotifier();
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runListener = vi.fn();
    notifier.subscribeWorkspace("ws-mixed", async () => {
      throw new Error("workspace-down");
    });
    notifier.subscribeRun("run-mixed", runListener);

    try {
      await expect(
        notifier.notifyEntry({
          event_id: "event-mixed-1",
          event_type: "run.created",
          entity_type: "run",
          entity_id: "run-mixed",
          workspace_id: "ws-mixed",
          run_id: "run-mixed",
          caused_by: "test",
          revision: 1,
          created_at: "2026-04-30T00:00:00.000Z",
          payload_json: {
            run_id: "run-mixed",
            workspace_id: "ws-mixed",
            run_mode: "chat",
            title: "isolation test"
          }
        })
      ).resolves.toBeUndefined();

      expect(runListener).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[runtime-notifier] listener threw; continuing fan-out", {
        errorName: "Error",
        errorMessageRedacted: true
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("workspace-down");
    } finally {
      consoleWarnSpy.mockRestore();
      cleanup();
    }
  });

  it("disposes subscriptions", async () => {
    const notifier = createRuntimeNotifier();
    const listener = vi.fn();
    const subscription = notifier.subscribeEntries(listener);
    subscription.dispose();
    subscription.dispose();

    await notifier.notifyEntry({
      event_id: "event-1",
      event_type: "memory.created" as EventLogEntry["event_type"],
      entity_type: "memory_entry",
      entity_id: "memory-1",
      workspace_id: "ws-1",
      run_id: null,
      caused_by: "test",
      revision: 1,
      created_at: "2026-04-30T00:00:00.000Z",
      payload_json: {}
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
