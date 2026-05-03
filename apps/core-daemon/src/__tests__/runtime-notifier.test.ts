import { describe, expect, it, vi } from "vitest";
import { createRuntimeNotifier } from "../runtime-notifier.js";

describe("RuntimeNotifier", () => {
  it("dispatches entries to entry and workspace listeners", async () => {
    const notifier = createRuntimeNotifier();
    const entryListener = vi.fn();
    const workspaceListener = vi.fn();
    notifier.subscribeEntries(entryListener);
    notifier.subscribeWorkspace("ws-1", workspaceListener);

    await notifier.notifyEntry({
      event_id: "event-1",
      event_type: "memory.created",
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
    const notifier = createRuntimeNotifier();
    const calls: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    notifier.subscribeEntries(async () => {
      calls.push("a");
      throw new Error("listener-a-down");
    });
    notifier.subscribeEntries(async () => {
      calls.push("b");
    });

    await expect(
      notifier.notifyEntry({
        event_id: "event-iso-1",
        event_type: "memory.created",
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
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("workspace listener exception does not block run-level dispatch", async () => {
    const notifier = createRuntimeNotifier();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runListener = vi.fn();
    notifier.subscribeWorkspace("ws-mixed", async () => {
      throw new Error("workspace-down");
    });
    notifier.subscribeRun("run-mixed", runListener);

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
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("disposes subscriptions", async () => {
    const notifier = createRuntimeNotifier();
    const listener = vi.fn();
    const subscription = notifier.subscribeEntries(listener);
    subscription.dispose();
    subscription.dispose();

    await notifier.notifyEntry({
      event_id: "event-1",
      event_type: "memory.created",
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
