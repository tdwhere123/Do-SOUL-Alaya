import { describe, expect, it, vi } from "vitest";
import type { ContextDeliveryRecord, EventLogEntry, UsageProofRecord } from "@do-soul/alaya-protocol";
import {
  TrustStateRecorder,
  TrustStateRecorderNotReady,
  TrustStateUnknownDeliveryError,
  TrustStateUnverifiableRequiresDeliveryError
} from "../trust-state.js";

const DELIVERY_AT = "2026-04-30T10:00:00.000Z";
const USAGE_AT = "2026-04-30T10:01:00.000Z";

type DeliveryInput = Omit<ContextDeliveryRecord, "audit_event_id">;
type UsageInput = Omit<UsageProofRecord, "audit_event_id">;

describe("trust state recorder", () => {
  it("B1 records delivery via EventPublisher", async () => {
    const { recorder, publish } = createRecorder({
      ready: true,
      clock: vi.fn(() => "2026-04-30T10:02:00.000Z")
    });

    const record = await recorder.recordDelivery(buildDeliveryInput("delivery-1"));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "memory.delivered",
        entity_type: "trust_context_delivery",
        entity_id: "delivery-1"
      })
    );
    expect(record.audit_event_id).toBe("event-1");
  });

  it("B2 recordUsage rejects unknown delivery_id", async () => {
    const { recorder, publish } = createRecorder({ ready: true });

    await expect(
      recorder.recordUsage({
        delivery_id: "missing-delivery",
        usage_state: "used",
        used_object_ids: ["memory-1"],
        reason: null,
        reported_at: USAGE_AT
      })
    ).rejects.toBeInstanceOf(TrustStateUnknownDeliveryError);

    expect(publish).not.toHaveBeenCalled();
  });

  it("B3 delivered_count accumulates across calls", async () => {
    const { recorder } = createRecorder({ ready: true });

    await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
    await recorder.recordDelivery(buildDeliveryInput("delivery-2"));

    const summary = await recorder.summarize("codex");
    expect(summary.delivered_count).toBe(2);
  });

  it("B4 delivered does not imply used", async () => {
    const { recorder } = createRecorder({ ready: true });

    await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
    const summary = await recorder.summarize("codex");

    expect(summary.delivered_count).toBe(1);
    expect(summary.used_count).toBe(0);
  });

  it("B5 usage report does not double-count delivery", async () => {
    const { recorder } = createRecorder({ ready: true });

    await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
    await recorder.recordUsage(buildUsageInput("delivery-1", "used"));
    const summary = await recorder.summarize("codex");

    expect(summary.delivered_count).toBe(1);
    expect(summary.used_count).toBe(1);
  });

  it("B6 unverifiable requires prior delivery", async () => {
    const { recorder } = createRecorder({ ready: true });

    await expect(recorder.recordUnverifiable("codex", "session-1")).rejects.toBeInstanceOf(
      TrustStateUnverifiableRequiresDeliveryError
    );

    await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
    await recorder.recordUnverifiable("codex", "session-2");
    const summary = await recorder.summarize("codex");
    expect(summary.unverifiable_count).toBe(1);
  });

  it("B7 summarize state reduction is correct", async () => {
    const rows: ReadonlyArray<{
      name: string;
      setup(recorder: TrustStateRecorder): Promise<void>;
      expectedState: string;
    }> = [
      {
        name: "row 1: delivered=0 configured=0 installed=0 => installed",
        setup: async () => undefined,
        expectedState: "installed"
      },
      {
        name: "row 2: installed>0 configured=0 => installed",
        setup: async (recorder) => {
          await recorder.recordInstalled("codex");
        },
        expectedState: "installed"
      },
      {
        name: "row 3: configured>0 delivered=0 => configured",
        setup: async (recorder) => {
          await recorder.recordConfigured("codex");
        },
        expectedState: "configured"
      },
      {
        name: "row 4: delivered>0 and no outcomes => delivered",
        setup: async (recorder) => {
          await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
        },
        expectedState: "delivered"
      },
      {
        name: "row 5: used>0 and skipped=0 => used",
        setup: async (recorder) => {
          await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
          await recorder.recordUsage(buildUsageInput("delivery-1", "used"));
        },
        expectedState: "used"
      },
      {
        name: "row 6: skipped>0 and used=0 and not_applicable=0 => skipped",
        setup: async (recorder) => {
          await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
          await recorder.recordUsage(buildUsageInput("delivery-1", "skipped"));
        },
        expectedState: "skipped"
      },
      {
        name: "row 7: unverifiable>0 and used=0 and skipped=0 => unverifiable",
        setup: async (recorder) => {
          await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
          await recorder.recordUnverifiable("codex", "session-1");
        },
        expectedState: "unverifiable"
      },
      {
        name: "row 8: at least two outcomes => mixed",
        setup: async (recorder) => {
          await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
          await recorder.recordUsage(buildUsageInput("delivery-1", "used"));
          await recorder.recordDelivery(buildDeliveryInput("delivery-2"));
          await recorder.recordUsage(buildUsageInput("delivery-2", "skipped"));
        },
        expectedState: "mixed"
      }
    ];

    for (const row of rows) {
      const { recorder } = createRecorder({ ready: true });
      await row.setup(recorder);
      const summary = await recorder.summarize("codex");
      expect(summary.state, row.name).toBe(row.expectedState);
    }
  });

  it("B8 clock is injectable and used", async () => {
    const clock = vi
      .fn<() => string>()
      .mockReturnValueOnce("2026-04-30T10:03:00.000Z")
      .mockReturnValueOnce("2026-04-30T10:04:00.000Z");
    const { recorder, publish } = createRecorder({ ready: true, clock });

    const delivery = await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
    const usage = await recorder.recordUsage(buildUsageInput("delivery-1", "used"));

    expect(delivery.delivered_at).toBe(DELIVERY_AT);
    expect(usage.reported_at).toBe(USAGE_AT);
    expect(clock).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          delivered_at: DELIVERY_AT,
          recorded_at: "2026-04-30T10:03:00.000Z"
        })
      })
    );
    expect(publish.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          reported_at: USAGE_AT,
          recorded_at: "2026-04-30T10:04:00.000Z"
        })
      })
    );
  });

  it("B9 pre-startup calls fail closed", async () => {
    const { recorder } = createRecorder({ ready: false });

    await expect(recorder.recordDelivery(buildDeliveryInput("delivery-1"))).rejects.toBeInstanceOf(
      TrustStateRecorderNotReady
    );
    await expect(recorder.summarize("codex")).rejects.toBeInstanceOf(TrustStateRecorderNotReady);
  });
});

function createRecorder(options: { ready: boolean; clock?: () => string }) {
  let counter = 0;
  const publish = vi.fn(
    async (entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<Readonly<EventLogEntry>> => {
      counter += 1;
      return {
        event_id: `event-${counter}`,
        created_at: "2026-04-30T10:05:00.000Z",
        ...entry
      };
    }
  );

  const recorder = new TrustStateRecorder({
    eventPublisher: { publish },
    ready: options.ready,
    clock: options.clock
  });
  return { recorder, publish };
}

function buildDeliveryInput(
  deliveryId: string,
  overrides: Partial<DeliveryInput> = {}
): DeliveryInput {
  return {
    delivery_id: deliveryId,
    agent_target: "codex",
    workspace_id: "workspace-1",
    run_id: "run-1",
    delivered_object_ids: ["memory-1"],
    delivered_at: DELIVERY_AT,
    ...overrides
  };
}

function buildUsageInput(
  deliveryId: string,
  usageState: UsageInput["usage_state"],
  overrides: Partial<UsageInput> = {}
): UsageInput {
  return {
    delivery_id: deliveryId,
    usage_state: usageState,
    used_object_ids: usageState === "used" ? ["memory-1"] : [],
    reason: null,
    reported_at: USAGE_AT,
    ...overrides
  };
}
