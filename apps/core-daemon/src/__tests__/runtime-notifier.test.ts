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
