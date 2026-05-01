import { describe, expect, it, vi } from "vitest";
import {
  TrustStateEventType,
  type ContextDeliveryRecord,
  type EventLogEntry,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
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
    const { recorder, publishWithMutation } = createRecorder({
      ready: true,
      clock: vi.fn(() => "2026-04-30T10:02:00.000Z")
    });

    const record = await recorder.recordDelivery(buildDeliveryInput("delivery-1"));

    expect(publishWithMutation).toHaveBeenCalledTimes(1);
    expect(publishWithMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "memory.delivered",
        entity_type: "trust_context_delivery",
        entity_id: "delivery-1"
      }),
      expect.any(Function)
    );
    expect(record.audit_event_id).toBe("event-1");
  });

  it("B2 recordUsage rejects unknown delivery_id", async () => {
    const { recorder, publishWithMutation } = createRecorder({ ready: true });

    await expect(
      recorder.recordUsage({
        delivery_id: "missing-delivery",
        usage_state: "used",
        used_object_ids: ["memory-1"],
        reason: null,
        reported_at: USAGE_AT
      })
    ).rejects.toBeInstanceOf(TrustStateUnknownDeliveryError);

    expect(publishWithMutation).not.toHaveBeenCalled();
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

  it("audits installed configured and unverifiable counters before mutating process-local state", async () => {
    const { recorder, publishWithMutation } = createRecorder({
      ready: true,
      clock: vi.fn(() => "2026-04-30T10:02:00.000Z")
    });

    await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
    await recorder.recordInstalled("codex");
    await recorder.recordConfigured("codex");
    await recorder.recordUnverifiable("codex", "session-1");

    const counterEvents = publishWithMutation.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.entity_type === "trust_state_counter");
    expect(counterEvents).toEqual([
      expect.objectContaining({
        event_type: TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED,
        entity_id: "codex:installed",
        payload_json: expect.objectContaining({
          agent_target: "codex",
          counter_name: "installed",
          session_id: null,
          recorded_at: "2026-04-30T10:02:00.000Z"
        })
      }),
      expect.objectContaining({
        event_type: TrustStateEventType.TRUST_STATE_CONFIGURED_RECORDED,
        entity_id: "codex:configured",
        payload_json: expect.objectContaining({
          agent_target: "codex",
          counter_name: "configured",
          session_id: null
        })
      }),
      expect.objectContaining({
        event_type: TrustStateEventType.TRUST_STATE_UNVERIFIABLE_RECORDED,
        entity_id: "codex:unverifiable",
        payload_json: expect.objectContaining({
          agent_target: "codex",
          counter_name: "unverifiable",
          session_id: "session-1"
        })
      })
    ]);

    await expect(recorder.summarize("codex")).resolves.toMatchObject({
      installed_count: 1,
      configured_count: 1,
      unverifiable_count: 1
    });
  });

  it("does not mutate process-local counters when audit publication fails", async () => {
    const publishWithMutation = vi.fn(async () => {
      throw new Error("audit append failed");
    });
    const recorder = new TrustStateRecorder({
      eventPublisher: { publishWithMutation },
      ready: true
    });

    await expect(recorder.recordInstalled("codex")).rejects.toThrow("audit append failed");

    await expect(recorder.summarize("codex")).resolves.toMatchObject({
      installed_count: 0
    });
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
    const { recorder, publishWithMutation } = createRecorder({ ready: true, clock });

    const delivery = await recorder.recordDelivery(buildDeliveryInput("delivery-1"));
    const usage = await recorder.recordUsage(buildUsageInput("delivery-1", "used"));

    expect(delivery.delivered_at).toBe(DELIVERY_AT);
    expect(usage.reported_at).toBe(USAGE_AT);
    expect(clock).toHaveBeenCalledTimes(2);
    expect(publishWithMutation.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          delivered_at: DELIVERY_AT,
          recorded_at: "2026-04-30T10:03:00.000Z"
        })
      })
    );
    expect(publishWithMutation.mock.calls[1]?.[0]).toEqual(
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

function createRecorder(options: {
  ready: boolean;
  clock?: () => string;
  publishWithMutation?: ReturnType<typeof vi.fn>;
}) {
  let counter = 0;
  const publishWithMutation =
    options.publishWithMutation ??
    vi.fn(
      async <T>(
        entry: Omit<EventLogEntry, "event_id" | "created_at">,
        mutate: (entry: EventLogEntry) => Promise<T>
      ): Promise<T> => {
        counter += 1;
        const persisted = {
          event_id: `event-${counter}`,
          created_at: "2026-04-30T10:05:00.000Z",
          ...entry
        };
        return await mutate(persisted);
      }
    );

  const recorder = new TrustStateRecorder({
    eventPublisher: { publishWithMutation },
    ready: options.ready,
    clock: options.clock
  });
  return { recorder, publishWithMutation };
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
