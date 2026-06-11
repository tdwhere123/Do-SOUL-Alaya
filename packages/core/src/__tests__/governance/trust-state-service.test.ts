import { describe, expect, it, vi } from "vitest";
import {
  TrustStateEventType,
  type ContextDeliveryRecord,
  type EventLogEntry,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import {
  collectCounts,
  rebuildCountersFromEventLog,
  reduceTrustState,
  type SummaryCounts
} from "../../governance/trust-state-service.js";

const baseCounts = (overrides: Partial<SummaryCounts> = {}): SummaryCounts => ({
  installed_count: 0,
  configured_count: 0,
  delivered_count: 0,
  used_count: 0,
  skipped_count: 0,
  not_applicable_count: 0,
  unverifiable_count: 0,
  ...overrides
});

const reducerCases: ReadonlyArray<{
  readonly name: string;
  readonly counts: SummaryCounts;
  readonly expected: ReturnType<typeof reduceTrustState>;
}> = [
  { name: "all zero stays installed", counts: baseCounts(), expected: "installed" },
  { name: "installed without configured stays installed", counts: baseCounts({ installed_count: 1 }), expected: "installed" },
  {
    name: "installed wins before unverifiable without delivery",
    counts: baseCounts({ installed_count: 1, unverifiable_count: 1 }),
    expected: "installed"
  },
  { name: "configured without delivery", counts: baseCounts({ configured_count: 1 }), expected: "configured" },
  {
    name: "configured wins with installed before delivery",
    counts: baseCounts({ installed_count: 1, configured_count: 1 }),
    expected: "configured"
  },
  { name: "delivered without outcomes", counts: baseCounts({ delivered_count: 1 }), expected: "delivered" },
  {
    name: "not applicable only falls through to mixed",
    counts: baseCounts({ delivered_count: 1, not_applicable_count: 1 }),
    expected: "mixed"
  },
  {
    name: "unverifiable downgrades delivered without usage",
    counts: baseCounts({ delivered_count: 1, unverifiable_count: 1 }),
    expected: "unverifiable"
  },
  { name: "used after delivery", counts: baseCounts({ delivered_count: 1, used_count: 1 }), expected: "used" },
  {
    name: "used wins over not applicable when skipped is absent",
    counts: baseCounts({ delivered_count: 2, used_count: 1, not_applicable_count: 1 }),
    expected: "used"
  },
  {
    name: "used wins over unverifiable when skipped is absent",
    counts: baseCounts({ delivered_count: 2, used_count: 1, unverifiable_count: 1 }),
    expected: "used"
  },
  { name: "skipped after delivery", counts: baseCounts({ delivered_count: 1, skipped_count: 1 }), expected: "skipped" },
  {
    name: "skipped wins over unverifiable when used and not applicable are absent",
    counts: baseCounts({ delivered_count: 2, skipped_count: 1, unverifiable_count: 1 }),
    expected: "skipped"
  },
  {
    name: "skipped plus not applicable is mixed",
    counts: baseCounts({ delivered_count: 2, skipped_count: 1, not_applicable_count: 1 }),
    expected: "mixed"
  },
  {
    name: "used plus skipped is mixed",
    counts: baseCounts({ delivered_count: 2, used_count: 1, skipped_count: 1 }),
    expected: "mixed"
  },
  {
    name: "unverifiable wins over not applicable when used and skipped are absent",
    counts: baseCounts({ delivered_count: 2, not_applicable_count: 1, unverifiable_count: 1 }),
    expected: "unverifiable"
  },
  {
    name: "all outcomes is mixed",
    counts: baseCounts({
      delivered_count: 4,
      used_count: 1,
      skipped_count: 1,
      not_applicable_count: 1,
      unverifiable_count: 1
    }),
    expected: "mixed"
  },
  {
    name: "configured plus delivered without outcomes is delivered",
    counts: baseCounts({ configured_count: 1, delivered_count: 1 }),
    expected: "delivered"
  }
];

describe("trust-state-service", () => {
  it("covers 18 reducer precedence branches", () => {
    expect(reducerCases).toHaveLength(18);

    for (const row of reducerCases) {
      expect(reduceTrustState(row.counts), row.name).toBe(row.expected);
    }
  });

  it("collects delivery and usage counts with latest timestamps", () => {
    const counts = collectCounts(
      [
        buildDelivery("delivery-1", "2026-05-01T00:00:00.000Z"),
        buildDelivery("delivery-2", "2026-05-01T00:03:00.000Z"),
        buildDelivery("delivery-3", "2026-05-01T00:02:00.000Z")
      ],
      new Map([
        ["delivery-1", buildUsage("delivery-1", "used", "2026-05-01T00:04:00.000Z")],
        ["delivery-2", buildUsage("delivery-2", "skipped", "2026-05-01T00:05:00.000Z")],
        ["delivery-3", buildUsage("delivery-3", "not_applicable", "2026-05-01T00:01:00.000Z")]
      ]),
      {
        installed_count: 2,
        configured_count: 1,
        unverifiable_count: 3
      }
    );

    expect(counts).toEqual({
      installed_count: 2,
      configured_count: 1,
      delivered_count: 3,
      used_count: 1,
      skipped_count: 1,
      not_applicable_count: 1,
      unverifiable_count: 3,
      last_delivery_at: "2026-05-01T00:03:00.000Z",
      last_usage_report_at: "2026-05-01T00:05:00.000Z"
    });
  });

  it("keeps last delivery and usage timestamps null when there are no rows", () => {
    expect(
      collectCounts([], new Map(), {
        installed_count: 0,
        configured_count: 0,
        unverifiable_count: 0
      })
    ).toMatchObject({
      delivered_count: 0,
      used_count: 0,
      last_delivery_at: null,
      last_usage_report_at: null
    });
  });

  it("preserves monotone installed seed increases", () => {
    const first = collectCounts([], new Map(), {
      installed_count: 1,
      configured_count: 0,
      unverifiable_count: 0
    });
    const second = collectCounts([], new Map(), {
      installed_count: 2,
      configured_count: 0,
      unverifiable_count: 0
    });

    expect(second.installed_count).toBeGreaterThan(first.installed_count);
  });

  it("rebuilds process-local counters from EventLog counter events", async () => {
    const eventLogReader = {
      queryByType: vi.fn(async (eventType: string) => {
        const events = new Map<string, readonly EventLogEntry[]>([
          [
            TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED,
            [
              buildEvent(TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED, "codex", "installed"),
              buildEvent(TrustStateEventType.TRUST_STATE_INSTALLED_RECORDED, "codex", "installed")
            ]
          ],
          [
            TrustStateEventType.TRUST_STATE_CONFIGURED_RECORDED,
            [buildEvent(TrustStateEventType.TRUST_STATE_CONFIGURED_RECORDED, "codex", "configured")]
          ],
          [
            TrustStateEventType.TRUST_STATE_UNVERIFIABLE_RECORDED,
            [buildEvent(TrustStateEventType.TRUST_STATE_UNVERIFIABLE_RECORDED, "claude-code", "unverifiable")]
          ]
        ]);
        return events.get(eventType) ?? [];
      })
    };
    const recorder = {
      replayCounterIncrement: vi.fn()
    };

    await rebuildCountersFromEventLog(eventLogReader, recorder);

    expect(eventLogReader.queryByType).toHaveBeenCalledTimes(3);
    expect(recorder.replayCounterIncrement.mock.calls).toEqual([
      ["installed", "codex"],
      ["installed", "codex"],
      ["configured", "codex"],
      ["unverifiable", "claude-code"]
    ]);
  });
});

function buildDelivery(deliveryId: string, deliveredAt: string): ContextDeliveryRecord {
  return {
    delivery_id: deliveryId,
    agent_target: "codex",
    workspace_id: "workspace-1",
    run_id: "run-1",
    delivered_object_ids: ["memory-1"],
    delivered_at: deliveredAt,
    audit_event_id: `event-${deliveryId}`
  };
}

function buildUsage(
  deliveryId: string,
  usageState: UsageProofRecord["usage_state"],
  reportedAt: string
): UsageProofRecord {
  return {
    delivery_id: deliveryId,
    usage_state: usageState,
    used_object_ids: usageState === "used" ? ["memory-1"] : [],
    reason: null,
    reported_at: reportedAt,
    audit_event_id: `event-usage-${deliveryId}`
  };
}

function buildEvent(
  eventType: EventLogEntry["event_type"],
  agentTarget: string,
  counterName: string
): EventLogEntry {
  return {
    event_id: `${eventType}:${agentTarget}:${counterName}`,
    event_type: eventType,
    entity_type: "trust_state_counter",
    entity_id: `${agentTarget}:${counterName}`,
    workspace_id: "trust-state",
    run_id: null,
    caused_by: agentTarget,
    payload_json: {
      agent_target: agentTarget,
      counter_name: counterName
    },
    revision: 0,
    created_at: "2026-05-01T00:00:00.000Z"
  };
}
