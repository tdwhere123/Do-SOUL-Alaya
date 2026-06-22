import { describe, expect, it } from "vitest";
import {
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
  GraphAuditorEventType,
  SoulGraphEdgeProposalCreatedPayloadSchema,
  SoulGraphEdgeProposalReviewedPayloadSchema
} from "@do-soul/alaya-protocol";
import {
  aggregateEdgeProposalAutoAccept,
  aggregateEdgeProposalRate,
  aggregateEdgeProposalRatePerQuestion,
  type EdgeProposalKpiEventRow
} from "../../metrics/edge-proposal-kpi.js";

const WORKSPACE_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const WORKSPACE_B = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const SOURCE_MEMORY = "33333333-3333-4333-8333-cccccccccccc";
const TARGET_MEMORY = "44444444-4444-4444-8444-dddddddddddd";

function createdRow(input: {
  readonly proposalId: string;
  readonly triggerSource:
    | typeof EdgeProposalTriggerSource[keyof typeof EdgeProposalTriggerSource];
  readonly confidence: number;
  readonly workspaceId: string;
  readonly createdAt: string;
}): EdgeProposalKpiEventRow {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED,
    workspace_id: input.workspaceId,
    created_at: input.createdAt,
    payload_json: SoulGraphEdgeProposalCreatedPayloadSchema.parse({
      proposal_id: input.proposalId,
      source_memory_id: SOURCE_MEMORY,
      target_memory_id: TARGET_MEMORY,
      edge_type: "recalls",
      trigger_source: input.triggerSource,
      confidence: input.confidence,
      reason: null,
      source_signal_id: null,
      workspace_id: input.workspaceId,
      occurred_at: input.createdAt
    })
  };
}

function reviewedRow(input: {
  readonly proposalId: string;
  readonly status:
    | typeof EdgeProposalStatus[keyof typeof EdgeProposalStatus];
  readonly reviewerIdentity: string;
  readonly workspaceId: string;
  readonly reviewedAt: string;
}): EdgeProposalKpiEventRow {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED,
    workspace_id: input.workspaceId,
    created_at: input.reviewedAt,
    payload_json: SoulGraphEdgeProposalReviewedPayloadSchema.parse({
      proposal_id: input.proposalId,
      status: input.status,
      reviewer_identity: input.reviewerIdentity,
      review_reason: null,
      workspace_id: input.workspaceId,
      occurred_at: input.reviewedAt
    })
  };
}

describe("aggregateEdgeProposalRate", () => {
  it("returns undefined when no proposal_created events are observed", () => {
    expect(aggregateEdgeProposalRate([])).toBeUndefined();
  });

  it("counts SOUL_GRAPH_EDGE_PROPOSAL_CREATED events and breaks down by trigger_source", () => {
    const rows: readonly EdgeProposalKpiEventRow[] = [
      createdRow({
        proposalId: "p1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      }),
      createdRow({
        proposalId: "p2",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.5,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T13:00:00.000Z"
      }),
      createdRow({
        proposalId: "p3",
        triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
        confidence: 0.95,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T14:00:00.000Z"
      }),
      createdRow({
        proposalId: "p4",
        triggerSource: EdgeProposalTriggerSource.CONFLICT_DETECTION,
        confidence: 0.95,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-25T08:00:00.000Z"
      })
    ];
    const result = aggregateEdgeProposalRate(rows);
    expect(result).toBeDefined();
    expect(result?.total_proposals).toBe(4);
    expect(result?.per_trigger_source).toEqual({
      [EdgeProposalTriggerSource.RECALL_CROSS_LINK]: 2,
      [EdgeProposalTriggerSource.LLM_SUPPORTS]: 1,
      [EdgeProposalTriggerSource.CONFLICT_DETECTION]: 1
    });
  });

  it("derives per-workspace-per-day min / median / max from created-at days", () => {
    // Workspace A: day-1 has 3 proposals; day-2 has 1.
    // Workspace B: day-1 has 5 proposals.
    // Buckets: [3, 1, 5] -> min=1 max=5 median=3.
    const rows: EdgeProposalKpiEventRow[] = [];
    for (let i = 0; i < 3; i += 1) {
      rows.push(
        createdRow({
          proposalId: `a-d1-${i}`,
          triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
          confidence: 0.9,
          workspaceId: WORKSPACE_A,
          createdAt: `2026-05-24T0${i}:00:00.000Z`
        })
      );
    }
    rows.push(
      createdRow({
        proposalId: "a-d2-0",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-25T00:00:00.000Z"
      })
    );
    for (let i = 0; i < 5; i += 1) {
      rows.push(
        createdRow({
          proposalId: `b-d1-${i}`,
          triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
          confidence: 0.95,
          workspaceId: WORKSPACE_B,
          createdAt: `2026-05-24T0${i}:00:00.000Z`
        })
      );
    }
    const result = aggregateEdgeProposalRate(rows);
    expect(result).toBeDefined();
    expect(result?.total_proposals).toBe(9);
    expect(result?.per_workspace_per_day_min).toBe(1);
    expect(result?.per_workspace_per_day_max).toBe(5);
    expect(result?.per_workspace_per_day_median).toBe(3);
  });

  it("skips records whose created_at is not a real YYYY-MM-DD day", () => {
    // created_at is read directly off the row (not the payload), so garbage
    // here must not synthesize a bogus per-day bucket. Two valid rows on the
    // same real day form the only legitimate bucket -> min == max == median.
    const garbageDay = createdRow({
      proposalId: "garbage",
      triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
      confidence: 0.9,
      workspaceId: WORKSPACE_A,
      createdAt: "2026-05-24T12:00:00.000Z"
    });
    const impossibleDay = createdRow({
      proposalId: "impossible",
      triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
      confidence: 0.9,
      workspaceId: WORKSPACE_A,
      createdAt: "2026-05-24T13:00:00.000Z"
    });
    const rows: EdgeProposalKpiEventRow[] = [
      { ...garbageDay, created_at: "abcdefghij" },
      { ...impossibleDay, created_at: "2026-13-99T00:00:00.000Z" },
      createdRow({
        proposalId: "valid-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      }),
      createdRow({
        proposalId: "valid-2",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T14:00:00.000Z"
      })
    ];
    const result = aggregateEdgeProposalRate(rows);
    expect(result).toBeDefined();
    // Garbage rows still count toward total_proposals (the payload is valid);
    // they are excluded only from the day-bucket aggregation.
    expect(result?.total_proposals).toBe(4);
    // Only one valid day bucket with 2 proposals -> min == max == median == 2.
    expect(result?.per_workspace_per_day_min).toBe(2);
    expect(result?.per_workspace_per_day_max).toBe(2);
    expect(result?.per_workspace_per_day_median).toBe(2);
  });

  it("ignores reviewed events when computing the rate", () => {
    const rows: readonly EdgeProposalKpiEventRow[] = [
      createdRow({
        proposalId: "p1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      }),
      reviewedRow({
        proposalId: "p1",
        status: EdgeProposalStatus.AUTO_ACCEPTED,
        reviewerIdentity: "system:auto_accept_policy",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T12:00:00.000Z"
      })
    ];
    const result = aggregateEdgeProposalRate(rows);
    expect(result?.total_proposals).toBe(1);
  });
});

describe("aggregateEdgeProposalRatePerQuestion (K3.2 bench-harness rollup)", () => {
  it("returns undefined when no chunks are supplied", () => {
    expect(aggregateEdgeProposalRatePerQuestion([])).toBeUndefined();
  });

  it("returns undefined when chunks contain no created events", () => {
    const onlyReviewedChunk = [
      reviewedRow({
        proposalId: "p1",
        status: EdgeProposalStatus.AUTO_ACCEPTED,
        reviewerIdentity: "system:auto_accept_policy",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T12:00:00.000Z"
      })
    ];
    expect(
      aggregateEdgeProposalRatePerQuestion([onlyReviewedChunk])
    ).toBeUndefined();
  });

  it("buckets created events by question chunk and computes p50/p95/max", () => {
    // Three questions: counts = [0, 2, 5]. Sorted = [0, 2, 5].
    // p50 (linear at rank 1.0) = 2. p95 (linear at rank 1.9) = 4.7. max = 5.
    const chunkA: EdgeProposalKpiEventRow[] = [];
    const chunkB: EdgeProposalKpiEventRow[] = [
      createdRow({
        proposalId: "b-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      }),
      createdRow({
        proposalId: "b-2",
        triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:01:00.000Z"
      })
    ];
    const chunkC: EdgeProposalKpiEventRow[] = Array.from({ length: 5 }).map(
      (_, i) =>
        createdRow({
          proposalId: `c-${i}`,
          triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
          confidence: 0.9,
          workspaceId: WORKSPACE_A,
          createdAt: `2026-05-24T13:0${i}:00.000Z`
        })
    );

    const rollup = aggregateEdgeProposalRatePerQuestion([
      chunkA,
      chunkB,
      chunkC
    ]);
    expect(rollup).toBeDefined();
    expect(rollup?.question_count).toBe(3);
    expect(rollup?.total_proposals).toBe(7);
    expect(rollup?.mean).toBeCloseTo(7 / 3, 5);
    expect(rollup?.p50).toBe(2);
    expect(rollup?.max).toBe(5);
    // p95 linear at rank 0.95 * 2 = 1.9 -> 2 + 0.9 * (5 - 2) = 4.7
    expect(rollup?.p95).toBeCloseTo(4.7, 5);
  });

  it("ignores reviewed events inside chunks when sizing the per-question distribution", () => {
    const chunk: EdgeProposalKpiEventRow[] = [
      createdRow({
        proposalId: "p1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      }),
      reviewedRow({
        proposalId: "p1",
        status: EdgeProposalStatus.AUTO_ACCEPTED,
        reviewerIdentity: "system:auto_accept_policy",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T12:00:00.000Z"
      })
    ];
    const rollup = aggregateEdgeProposalRatePerQuestion([chunk]);
    expect(rollup?.total_proposals).toBe(1);
    expect(rollup?.max).toBe(1);
  });
});

describe("aggregateEdgeProposalRate with perQuestionChunks (Option C)", () => {
  it("attaches proposals_per_question when chunks are supplied", () => {
    // bench-harness shape: every question uses the same workspaceId, so
    // per_workspace_per_day_* collapses to total_proposals — Option C
    // surfaces the per-question distribution alongside without breaking
    // the existing fields.
    const chunkA = [
      createdRow({
        proposalId: "a-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      })
    ];
    const chunkB = [
      createdRow({
        proposalId: "b-1",
        triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:01:00.000Z"
      }),
      createdRow({
        proposalId: "b-2",
        triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:02:00.000Z"
      })
    ];
    const result = aggregateEdgeProposalRate(
      [...chunkA, ...chunkB],
      [chunkA, chunkB]
    );
    expect(result).toBeDefined();
    expect(result?.total_proposals).toBe(3);
    expect(result?.proposals_per_question).toBeDefined();
    expect(result?.proposals_per_question?.question_count).toBe(2);
    expect(result?.proposals_per_question?.total_proposals).toBe(3);
    expect(result?.proposals_per_question?.max).toBe(2);
  });

  it("omits proposals_per_question when chunks are not supplied (backwards compatible)", () => {
    const rows = [
      createdRow({
        proposalId: "p1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      })
    ];
    const result = aggregateEdgeProposalRate(rows);
    expect(result?.proposals_per_question).toBeUndefined();
  });

  it("emits proposals_per_question with realistic multi-workspace production shape too", () => {
    // Even outside the bench harness — if a caller hands per-question
    // chunks they still get the per-question distribution. The bucket
    // semantics is "one chunk = one bucket"; no workspace inference.
    const chunkA = [
      createdRow({
        proposalId: "a-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      })
    ];
    const chunkB = [
      createdRow({
        proposalId: "b-1",
        triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
        confidence: 0.9,
        workspaceId: WORKSPACE_B,
        createdAt: "2026-05-24T12:01:00.000Z"
      })
    ];
    const result = aggregateEdgeProposalRate(
      [...chunkA, ...chunkB],
      [chunkA, chunkB]
    );
    expect(result?.proposals_per_question?.question_count).toBe(2);
    // Two distinct workspaces -> per_workspace_per_day_* now reflects
    // the real production shape (1 each), confirming the two layers are
    // independent.
    expect(result?.per_workspace_per_day_max).toBe(1);
    expect(result?.per_workspace_per_day_min).toBe(1);
  });
});

describe("aggregateEdgeProposalAutoAccept", () => {
  it("returns undefined when no proposal_reviewed events are observed", () => {
    expect(aggregateEdgeProposalAutoAccept([])).toBeUndefined();
  });

  it("computes rate = auto_accepted / total_decided over reviewed events", () => {
    const createdRows = [
      createdRow({
        proposalId: "p-auto-1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.9,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      }),
      createdRow({
        proposalId: "p-auto-2",
        triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
        confidence: 0.95,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:01:00.000Z"
      }),
      createdRow({
        proposalId: "p-manual",
        triggerSource: EdgeProposalTriggerSource.EXPLICIT,
        confidence: 0.5,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:02:00.000Z"
      }),
      createdRow({
        proposalId: "p-rejected",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.6,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:03:00.000Z"
      })
    ];
    const reviewedRows = [
      reviewedRow({
        proposalId: "p-auto-1",
        status: EdgeProposalStatus.AUTO_ACCEPTED,
        reviewerIdentity: "system:auto_accept_policy",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T12:00:00.000Z"
      }),
      reviewedRow({
        proposalId: "p-auto-2",
        status: EdgeProposalStatus.AUTO_ACCEPTED,
        reviewerIdentity: "system:auto_accept_policy",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T12:01:00.000Z"
      }),
      reviewedRow({
        proposalId: "p-manual",
        status: EdgeProposalStatus.ACCEPTED,
        reviewerIdentity: "user:reviewer",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T12:30:00.000Z"
      }),
      reviewedRow({
        proposalId: "p-rejected",
        status: EdgeProposalStatus.REJECTED,
        reviewerIdentity: "user:reviewer",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T12:31:00.000Z"
      })
    ];

    const result = aggregateEdgeProposalAutoAccept([...createdRows, ...reviewedRows]);
    expect(result).toBeDefined();
    expect(result?.total_decided).toBe(4);
    expect(result?.auto_accepted).toBe(2);
    expect(result?.rate).toBeCloseTo(0.5, 5);
    // RECALL_CROSS_LINK has 1 auto + 1 rejected -> 0.5
    // LLM_SUPPORTS has 1 auto -> 1.0
    // EXPLICIT has 1 manual accepted -> 0.0
    expect(result?.per_trigger_source_rate[EdgeProposalTriggerSource.RECALL_CROSS_LINK]).toBeCloseTo(0.5, 5);
    expect(result?.per_trigger_source_rate[EdgeProposalTriggerSource.LLM_SUPPORTS]).toBe(1);
    expect(result?.per_trigger_source_rate[EdgeProposalTriggerSource.EXPLICIT]).toBe(0);
  });

  it("counts a reviewed event toward total_decided even when no matching created event is in the window", () => {
    const result = aggregateEdgeProposalAutoAccept([
      reviewedRow({
        proposalId: "p-orphan",
        status: EdgeProposalStatus.AUTO_ACCEPTED,
        reviewerIdentity: "system:auto_accept_policy",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T12:00:00.000Z"
      })
    ]);
    expect(result?.total_decided).toBe(1);
    expect(result?.auto_accepted).toBe(1);
    expect(result?.rate).toBe(1);
    // No created event -> per-trigger map stays empty rather than synthesizing a key.
    expect(result?.per_trigger_source_rate).toEqual({});
  });

  it("ignores reviewed events whose status is pending or expired", () => {
    const result = aggregateEdgeProposalAutoAccept([
      createdRow({
        proposalId: "p-expired",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.6,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      }),
      reviewedRow({
        proposalId: "p-expired",
        status: EdgeProposalStatus.EXPIRED,
        reviewerIdentity: "system:expiry_sweeper",
        workspaceId: WORKSPACE_A,
        reviewedAt: "2026-05-24T13:00:00.000Z"
      })
    ]);
    // EXPIRED is not a decided status; the aggregator returns undefined
    // when total_decided is zero.
    expect(result).toBeUndefined();
  });

  it("returns undefined when no decided reviewed events exist", () => {
    const result = aggregateEdgeProposalAutoAccept([
      createdRow({
        proposalId: "p1",
        triggerSource: EdgeProposalTriggerSource.RECALL_CROSS_LINK,
        confidence: 0.5,
        workspaceId: WORKSPACE_A,
        createdAt: "2026-05-24T12:00:00.000Z"
      })
    ]);
    expect(result).toBeUndefined();
  });
});
