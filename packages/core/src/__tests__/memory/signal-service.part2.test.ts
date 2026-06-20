import { describe, expect, it, vi } from "vitest";
import { SignalService } from "../../memory/signal-service.js";

import { createSignal } from "./signal-service.test-support.js";

describe("SignalService", () => {
it("marks the signal failed when post-triage materializer throws", async () => {
    const warn = vi.fn();
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => ({
          event_id: "evt_1",
          created_at: "2026-03-18T00:00:01.000Z",
          revision: 0,
          ...event
        })),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {})
      },
      postTriageMaterializer: {
        materialize: vi.fn(async () => {
          throw new Error("materializer exploded");
        })
      },
      warn
    });

    const result = await service.receiveSignal(createSignal());

    expect(result.signal.signal_state).toBe("failed");
    expect(result.materialization).toMatchObject({
      success: false,
      routing_reason: "materialization_exception"
    });
    expect(warn).toHaveBeenCalledWith(
      "Signal materialization failed.",
      expect.objectContaining({
        signal_id: "signal-1",
        error: expect.any(Error)
      })
    );
  });

it("lists persisted signals for a run", async () => {
    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn()
      } as any,
      signalRepo: {
        create: vi.fn(),
        getById: vi.fn(),
        listByRun: vi.fn(async () => [createSignal(), createSignal({ signal_id: "signal-2" })]),
        updateState: vi.fn()
      } as any,
      runtimeNotifier: {
        notifyEntry: vi.fn()
      } as any
    });

    await expect(service.listByRun("run-1")).resolves.toHaveLength(2);
  });

it("emits a corrective soul.signal.triaged deferred event after materialization router returns deferred", async () => {
    // Regression for P2-b: when triage_result is "accepted" but the materializer
    // returns target_kind "deferred", the signal transitions to DEFERRED state in
    // the repo but no follow-up event was notified. Runtime notification consumers were permanently
    // stuck on the initial "accepted" triage event. This verifies the corrective
    // soul.signal.triaged event with triage_result "deferred" is now appended and notified.
    const appendedEvents: Array<{ event_type: string; caused_by: string; payload_json: Record<string, unknown> }> = [];
    const notifiedEventTypes: string[] = [];
    let appendCallCount = 0;

    const service = new SignalService({
      eventLogRepo: {
        append: vi.fn(async (event) => {
          appendCallCount++;
          appendedEvents.push({ event_type: event.event_type, caused_by: event.caused_by, payload_json: event.payload_json as Record<string, unknown> });
          return {
            event_id: `evt_${appendCallCount}`,
            created_at: "2026-03-18T00:00:00.000Z",
            revision: 0,
            ...event
          };
        }),
        queryByEntity: vi.fn(async () => [])
      },
      signalRepo: {
        create: vi.fn(async (signal) => ({ ...signal, signal_state: "emitted" })),
        getById: vi.fn(async () => null),
        listByRun: vi.fn(async () => []),
        updateState: vi.fn(async (signalId, state) => createSignal({ signal_id: signalId, signal_state: state }))
      },
      runtimeNotifier: {
        notifyEntry: vi.fn(async (entry) => {
          notifiedEventTypes.push(entry.event_type);
        })
      },
      postTriageMaterializer: {
        materialize: vi.fn(async (signal) => ({
          signal_id: signal.signal_id,
          target_kind: "deferred" as const,
          routing_reason: "deferred by router",
          created_objects: [],
          success: true
        }))
      }
    });

    const result = await service.receiveSignal(createSignal());

    // Signal must end up in DEFERRED state; return value must reflect final state.
    expect(result.signal.signal_state).toBe("deferred");
    expect(result.triage_result).toBe("deferred");

    // A corrective triage event with triage_result "deferred" must be appended.
    const correctiveEvent = appendedEvents.find(
      (e) => e.event_type === "soul.signal.triaged" && e.payload_json["triage_result"] === "deferred"
    );
    expect(correctiveEvent).toBeDefined();
    expect(correctiveEvent?.caused_by).toBe("materialization_router");

    // The corrective event must also be notify in-process.
    const triagedNotifications = notifiedEventTypes.filter((t) => t === "soul.signal.triaged");
    expect(triagedNotifications).toHaveLength(2); // initial "accepted" + corrective "deferred"
  });
});
