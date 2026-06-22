import { describe, expect, it } from "vitest";
import {
  computeUtilizationBuckets,
  listSingleUsedAnchorDeliveries,
  rollUpUtilizationBucketsByCohort,
  type UtilizationBucketDelivery,
  type UtilizationBucketReport
} from "../../metrics/utilization-buckets.js";

function delivery(input: Partial<UtilizationBucketDelivery>): UtilizationBucketDelivery {
  return {
    delivery_id: input.delivery_id ?? "delivery_1",
    session_id: input.session_id ?? "session_1",
    run_id: input.run_id ?? "run-1",
    agent_target: input.agent_target ?? "claude-code",
    pointer_count: input.pointer_count ?? 3
  };
}

function report(input: Partial<UtilizationBucketReport>): UtilizationBucketReport {
  return {
    delivery_id: input.delivery_id ?? "delivery_1",
    session_id: input.session_id ?? "session_1",
    run_id: input.run_id ?? "run-1",
    agent_target: input.agent_target ?? "claude-code",
    usage_state: input.usage_state ?? "used",
    ...(input.turn_index === undefined ? {} : { turn_index: input.turn_index })
  };
}

describe("computeUtilizationBuckets", () => {
  it("returns all zeros for empty input", () => {
    expect(computeUtilizationBuckets({ deliveries: [], reports: [] })).toEqual({
      no_recall: 0,
      empty_recall: 0,
      delivered_not_reported: 0,
      reported_skipped_or_na: 0,
      reported_used: 0
    });
  });

  it("partitions deliveries across used / skipped / not_reported", () => {
    const deliveries = [
      delivery({ delivery_id: "d1", pointer_count: 4 }),
      delivery({ delivery_id: "d2", pointer_count: 2 }),
      delivery({ delivery_id: "d3", pointer_count: 6 })
    ];
    const reports = [
      report({ delivery_id: "d1", usage_state: "used" }),
      report({ delivery_id: "d2", usage_state: "skipped" })
    ];

    const buckets = computeUtilizationBuckets({ deliveries, reports });

    expect(buckets).toEqual({
      no_recall: 0,
      empty_recall: 0,
      delivered_not_reported: 1,
      reported_skipped_or_na: 1,
      reported_used: 1
    });
    expect(
      buckets.delivered_not_reported + buckets.reported_skipped_or_na + buckets.reported_used
    ).toBe(deliveries.length);
  });

  it("carves empty_recall out of delivered_not_reported when pointer_count is zero", () => {
    const deliveries = [
      delivery({ delivery_id: "d1", pointer_count: 0 }),
      delivery({ delivery_id: "d2", pointer_count: 5 })
    ];
    const buckets = computeUtilizationBuckets({ deliveries, reports: [] });
    expect(buckets.empty_recall).toBe(1);
    expect(buckets.delivered_not_reported).toBe(2);
    expect(
      buckets.delivered_not_reported + buckets.reported_skipped_or_na + buckets.reported_used
    ).toBe(deliveries.length);
  });

  it("collapses skipped + not_applicable into reported_skipped_or_na", () => {
    const deliveries = [
      delivery({ delivery_id: "d1", pointer_count: 3 }),
      delivery({ delivery_id: "d2", pointer_count: 1 })
    ];
    const reports = [
      report({ delivery_id: "d1", usage_state: "skipped" }),
      report({ delivery_id: "d2", usage_state: "not_applicable" })
    ];
    expect(computeUtilizationBuckets({ deliveries, reports }).reported_skipped_or_na).toBe(2);
  });

  it("prefers used when the same delivery has both used and skipped reports", () => {
    const deliveries = [delivery({ delivery_id: "d1", pointer_count: 3 })];
    const reports = [
      report({ delivery_id: "d1", usage_state: "skipped" }),
      report({ delivery_id: "d1", usage_state: "used" })
    ];
    expect(computeUtilizationBuckets({ deliveries, reports }).reported_used).toBe(1);
  });

  it("counts no_recall by distinct (session, turn) orphan reports", () => {
    const reports = [
      report({
        delivery_id: "orphan_a",
        session_id: "sess-A",
        turn_index: 1,
        usage_state: "not_applicable"
      }),
      report({
        delivery_id: "orphan_b",
        session_id: "sess-A",
        turn_index: 1,
        usage_state: "skipped"
      }),
      report({
        delivery_id: "orphan_c",
        session_id: "sess-B",
        turn_index: 4,
        usage_state: "not_applicable"
      })
    ];
    const buckets = computeUtilizationBuckets({ deliveries: [], reports });
    expect(buckets.no_recall).toBe(2);
  });

  it("counts orphan reports by session even when turn_index is absent", () => {
    const reports = [report({ delivery_id: "orphan_no_turn", usage_state: "not_applicable" })];
    expect(computeUtilizationBuckets({ deliveries: [], reports }).no_recall).toBe(1);
  });

  it("scopes delivery_id by workspace_id so a shared id is not mis-flagged as orphan", () => {
    // Two workspaces reuse the same delivery_id; each has its own delivery and a
    // matching used report. Without the (workspace_id, delivery_id) composite key
    // the cross-workspace report would be treated as an orphan (no_recall).
    const deliveries = [
      { ...delivery({ delivery_id: "shared", pointer_count: 3 }), workspace_id: "ws-1" },
      { ...delivery({ delivery_id: "shared", pointer_count: 3 }), workspace_id: "ws-2" }
    ];
    const reports = [
      { ...report({ delivery_id: "shared", usage_state: "used" }), workspace_id: "ws-1" },
      { ...report({ delivery_id: "shared", usage_state: "used" }), workspace_id: "ws-2" }
    ];
    const buckets = computeUtilizationBuckets({ deliveries, reports });
    expect(buckets.no_recall).toBe(0);
    expect(buckets.reported_used).toBe(2);
    expect(buckets.delivered_not_reported).toBe(0);
  });

  it("does not cross-match report state across workspaces sharing a delivery_id", () => {
    // ws-1 used, ws-2 skipped on the same delivery_id; the composite key must
    // keep the two states distinct rather than collapsing under max-precedence.
    const deliveries = [
      { ...delivery({ delivery_id: "shared", pointer_count: 2 }), workspace_id: "ws-1" },
      { ...delivery({ delivery_id: "shared", pointer_count: 2 }), workspace_id: "ws-2" }
    ];
    const reports = [
      { ...report({ delivery_id: "shared", usage_state: "used" }), workspace_id: "ws-1" },
      { ...report({ delivery_id: "shared", usage_state: "skipped" }), workspace_id: "ws-2" }
    ];
    const buckets = computeUtilizationBuckets({ deliveries, reports });
    expect(buckets.reported_used).toBe(1);
    expect(buckets.reported_skipped_or_na).toBe(1);
    expect(buckets.no_recall).toBe(0);
  });
});

describe("rollUpUtilizationBucketsByCohort", () => {
  it("groups by (workspace_id, agent_target)", () => {
    const rows = rollUpUtilizationBucketsByCohort({
      deliveries: [
        { ...delivery({ delivery_id: "d1", pointer_count: 3 }), workspace_id: "ws-1" },
        {
          ...delivery({ delivery_id: "d2", pointer_count: 0, agent_target: "codex" }),
          workspace_id: "ws-1"
        },
        { ...delivery({ delivery_id: "d3", pointer_count: 2 }), workspace_id: "ws-2" }
      ],
      reports: [
        {
          ...report({ delivery_id: "d1", usage_state: "used" }),
          workspace_id: "ws-1"
        }
      ]
    });

    expect(rows).toHaveLength(3);
    const claudeWs1 = rows.find(
      (row) => row.workspace_id === "ws-1" && row.agent_target === "claude-code"
    );
    expect(claudeWs1?.buckets.reported_used).toBe(1);
    expect(claudeWs1?.delivery_total).toBe(1);
    const codexWs1 = rows.find(
      (row) => row.workspace_id === "ws-1" && row.agent_target === "codex"
    );
    expect(codexWs1?.buckets.empty_recall).toBe(1);
    expect(codexWs1?.buckets.delivered_not_reported).toBe(1);
  });
});

describe("listSingleUsedAnchorDeliveries", () => {
  it("returns deliveries with pointer_count === 1 and a used report", () => {
    const deliveries = [
      delivery({ delivery_id: "single_used", pointer_count: 1 }),
      delivery({ delivery_id: "single_unused", pointer_count: 1 }),
      delivery({ delivery_id: "multi_used", pointer_count: 3 })
    ];
    const reports = [
      report({ delivery_id: "single_used", usage_state: "used" }),
      report({ delivery_id: "single_unused", usage_state: "skipped" }),
      report({ delivery_id: "multi_used", usage_state: "used" })
    ];
    const matched = listSingleUsedAnchorDeliveries({ deliveries, reports });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.delivery_id).toBe("single_used");
  });
});
