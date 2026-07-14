import { describe, expect, it, vi } from "vitest";
import { SignalService, createInMemorySourceGroundingDeferQueue } from "../../memory/signal-service.js";
import { createSignal } from "./signal-service.test-support.js";

function createDeferredMaterialization(reason: string) {
  return {
    signal_id: "signal-1",
    target_kind: "deferred" as const,
    routing_reason: `garden source grounding failed: ${reason}`,
    defer_reason: reason,
    defer_class: "source_grounding" as const,
    created_objects: [] as const,
    success: true as const
  };
}

function createHarness(options?: {
  readonly queueCap?: number;
  readonly materialize?: ReturnType<typeof vi.fn>;
}) {
  const queue = createInMemorySourceGroundingDeferQueue(options?.queueCap ?? 8);
  const signals = new Map<string, ReturnType<typeof createSignal>>();
  const appendedEvents: Array<{
    event_type: string;
    payload_json: Record<string, unknown>;
  }> = [];
  let appendCallCount = 0;

  const materialize =
    options?.materialize ??
    vi.fn(async () => createDeferredMaterialization("source_assertion_not_self_contained"));

  const service = new SignalService({
    eventLogRepo: {
      append: vi.fn(async (event) => {
        appendCallCount += 1;
        appendedEvents.push({
          event_type: event.event_type,
          payload_json: event.payload_json as Record<string, unknown>
        });
        return {
          event_id: `evt_${appendCallCount}`,
          created_at: "2026-07-14T00:00:00.000Z",
          revision: 0,
          ...event
        };
      }),
      queryByEntity: vi.fn(async () => [])
    },
    signalRepo: {
      create: vi.fn(async (signal) => {
        const stored = { ...signal, signal_state: "emitted" as const };
        signals.set(stored.signal_id, stored);
        return stored;
      }),
      getById: vi.fn(async (signalId) => signals.get(signalId) ?? null),
      listByRun: vi.fn(async () => []),
      updateState: vi.fn(async (signalId, state) => {
        const existing = signals.get(signalId) ?? createSignal({ signal_id: signalId });
        const next = { ...existing, signal_state: state };
        signals.set(signalId, next);
        return next;
      })
    },
    runtimeNotifier: { notifyEntry: vi.fn(async () => undefined) },
    sourceGroundingDeferQueue: queue,
    postTriageMaterializer: { materialize }
  });

  return { service, queue, signals, appendedEvents, materialize };
}

describe("SignalService source grounding defer queue", () => {
  it("tags defer reason on EventLog and enqueues for re-drive", async () => {
    const { service, queue, appendedEvents } = createHarness();
    const result = await service.receiveSignal(
      createSignal({
        source: "garden_compile",
        confidence: 0.9,
        evidence_refs: ["ev-1"],
        raw_payload: {
          proposed_matched_text: "这个更好。",
          full_turn_content: "方案 A 和方案 B。这个更好。"
        }
      })
    );

    expect(result.triage_result).toBe("deferred");
    expect(result.signal.signal_state).toBe("deferred");

    const corrective = appendedEvents.find(
      (event) =>
        event.event_type === "soul.signal.triaged" &&
        event.payload_json["triage_result"] === "deferred" &&
        event.payload_json["defer_class"] === "source_grounding"
    );
    expect(corrective?.payload_json["defer_reason"]).toBe("source_assertion_not_self_contained");
    expect(queue.get("signal-1")?.defer_reason).toBe("source_assertion_not_self_contained");
    expect(service.getSourceGroundingDeferStats().deferred_by_reason).toEqual({
      source_assertion_not_self_contained: 1
    });
  });

  it("re-drives a fixed-up signal through grounding and materializes", async () => {
    const materialize = vi
      .fn()
      .mockResolvedValueOnce(createDeferredMaterialization("source_assertion_incomplete"))
      .mockResolvedValueOnce({
        signal_id: "signal-1",
        target_kind: "memory_and_claim" as const,
        routing_reason: "object_kind routed",
        created_objects: [{ object_kind: "memory_entry", object_id: "mem-1" }],
        success: true as const
      });
    const { service, queue } = createHarness({ materialize });

    await service.receiveSignal(
      createSignal({
        source: "garden_compile",
        confidence: 0.9,
        evidence_refs: ["ev-1"]
      })
    );
    expect(queue.get("signal-1")).not.toBeNull();

    const redrive = await service.redriveSourceGroundingDefer("signal-1", {
      raw_payload: {
        proposed_matched_text: "I moved to Berlin.",
        full_turn_content: "I moved to Berlin."
      }
    });

    expect(redrive.triage_result).toBe("accepted");
    expect(redrive.signal.signal_state).toBe("materialized");
    expect(redrive.materialization?.target_kind).toBe("memory_and_claim");
    expect(queue.get("signal-1")).toBeNull();
    expect(materialize).toHaveBeenCalledTimes(2);
  });

  it("re-drives a still-bad signal and defers again with queue entry", async () => {
    const { service, queue } = createHarness();
    await service.receiveSignal(
      createSignal({
        source: "garden_compile",
        confidence: 0.9,
        evidence_refs: ["ev-1"]
      })
    );

    const redrive = await service.redriveSourceGroundingDefer("signal-1");
    expect(redrive.triage_result).toBe("deferred");
    expect(redrive.signal.signal_state).toBe("deferred");
    expect(queue.get("signal-1")?.defer_reason).toBe("source_assertion_not_self_contained");
    expect(service.getSourceGroundingDeferStats().deferred_by_reason).toEqual({
      source_assertion_not_self_contained: 2
    });
  });

  it("enforces the FIFO queue bound and keeps lifetime reason counts", async () => {
    const materialize = vi.fn(async (signal: { signal_id: string }) => ({
      ...createDeferredMaterialization("source_assertion_too_long"),
      signal_id: signal.signal_id
    }));
    const { service, queue } = createHarness({ queueCap: 2, materialize });

    for (let index = 1; index <= 3; index += 1) {
      await service.receiveSignal(
        createSignal({
          signal_id: `signal-${index}`,
          source: "garden_compile",
          confidence: 0.9,
          evidence_refs: ["ev-1"]
        })
      );
    }

    expect(queue.list()).toHaveLength(2);
    expect(queue.get("signal-1")).toBeNull();
    expect(queue.get("signal-2")).not.toBeNull();
    expect(queue.get("signal-3")).not.toBeNull();
    expect(service.getSourceGroundingDeferStats()).toMatchObject({
      queue_depth: 2,
      queue_cap: 2,
      deferred_by_reason: { source_assertion_too_long: 3 }
    });
  });
});
