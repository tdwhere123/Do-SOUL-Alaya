import { describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { buildRecallFusionDetails } from "../../recall/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";
import { scoreTemporalEventTime } from "../../recall/temporal-fusion-scoring.js";

function emptySupplementaryData(query: string): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(query),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

describe("buildRecallFusionDetails temporal lane", () => {
  it("uses event time instead of ingest created_at for temporal intent", () => {
    const policy = {} as RecallPolicy;
    const eventMemory = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      content: "The release blocker was reviewed yesterday.",
      created_at: "2026-01-01T00:00:00.000Z",
      event_time_start: "2026-03-19T00:00:00.000Z",
      event_time_end: "2026-03-19T23:59:59.999Z",
      time_precision: "day",
      time_source: "relative_resolved"
    });
    const createdOnlyMemory = createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      content: "A recent unrelated note.",
      created_at: "2026-03-20T00:00:00.000Z"
    });

    const fusion = buildRecallFusionDetails({
      candidates: [
        {
          entry: eventMemory,
          effectiveScore: 0,
          effectiveFactors: {
            activation: 0,
            relevance: 0
          }
        },
        {
          entry: createdOnlyMemory,
          effectiveScore: 0,
          effectiveFactors: {
            activation: 0,
            relevance: 0
          }
        }
      ],
      policy,
      supplementaryData: emptySupplementaryData("what happened yesterday before the release?"),
      nowIso: "2026-03-20T10:20:30.000Z"
    });

    const eventContribution =
      fusion.get("workspace_local:memory_entry:11111111-1111-4111-8111-111111111111")
        ?.fused_rank_contribution_per_stream.temporal_recency ?? 0;
    const createdOnlyContribution =
      fusion.get("workspace_local:memory_entry:22222222-2222-4222-8222-222222222222")
        ?.fused_rank_contribution_per_stream.temporal_recency ?? 0;

    expect(eventContribution).toBeGreaterThan(0);
    expect(createdOnlyContribution).toBe(0);
  });

  it("does not apply temporal-recency scoring to month-name path-source text", () => {
    const policy = {} as RecallPolicy;
    const eventMemory = createMemoryEntry({
      object_id: "55555555-5555-4555-8555-555555555555",
      content: "The November path source is checked in source maps.",
      event_time_start: "2026-11-01T00:00:00.000Z",
      time_precision: "month",
      time_source: "explicit"
    });

    const fusion = buildRecallFusionDetails({
      candidates: [
        {
          entry: eventMemory,
          effectiveScore: 0,
          effectiveFactors: {
            activation: 0,
            relevance: 0
          }
        }
      ],
      policy,
      supplementaryData: emptySupplementaryData("november path source"),
      nowIso: "2026-11-15T10:20:30.000Z"
    });

    expect(
      fusion.get("workspace_local:memory_entry:55555555-5555-4555-8555-555555555555")
        ?.fused_rank_contribution_per_stream.temporal_recency ?? 0
    ).toBe(0);
  });
});

describe("scoreTemporalEventTime valid-time gating", () => {
  const base = {
    event_time_start: "2026-03-19T00:00:00.000Z",
    event_time_end: "2026-03-19T23:59:59.999Z",
    time_precision: "day" as const,
    time_source: "explicit" as const
  };

  it("scores active and open-ended valid intervals", () => {
    expect(
      scoreTemporalEventTime(
        createMemoryEntry({ ...base, valid_from: "2026-03-01T00:00:00.000Z" }),
        "2026-03-20T10:20:30.000Z"
      )
    ).toBeGreaterThan(0);
  });

  it("does not score future or expired valid intervals", () => {
    expect(
      scoreTemporalEventTime(
        createMemoryEntry({ ...base, valid_from: "2026-04-01T00:00:00.000Z" }),
        "2026-03-20T10:20:30.000Z"
      )
    ).toBe(0);
    expect(
      scoreTemporalEventTime(
        createMemoryEntry({ ...base, valid_to: "2026-03-01T00:00:00.000Z" }),
        "2026-03-20T10:20:30.000Z"
      )
    ).toBe(0);
  });
});

describe("buildRecallFusionDetails preference profile lane", () => {
  it("uses structured preference profile fields for preference intent", () => {
    const policy = {} as RecallPolicy;
    const profileMemory = createMemoryEntry({
      object_id: "33333333-3333-4333-8333-333333333333",
      dimension: "preference",
      content: "Dark mode is preferred.",
      preference_subject: "operator",
      preference_predicate: "prefer",
      preference_object: "dark mode",
      preference_category: "theme",
      preference_polarity: "positive"
    });
    const plainMemory = createMemoryEntry({
      object_id: "44444444-4444-4444-8444-444444444444",
      dimension: "preference",
      content: "A plain preference without profile fields."
    });

    const fusion = buildRecallFusionDetails({
      candidates: [
        {
          entry: profileMemory,
          effectiveScore: 0,
          effectiveFactors: {
            activation: 0,
            relevance: 0
          }
        },
        {
          entry: plainMemory,
          effectiveScore: 0,
          effectiveFactors: {
            activation: 0,
            relevance: 0
          }
        }
      ],
      policy,
      supplementaryData: emptySupplementaryData("preferred theme"),
      nowIso: "2026-03-20T10:20:30.000Z"
    });

    const profileContribution =
      fusion.get("workspace_local:memory_entry:33333333-3333-4333-8333-333333333333")
        ?.fused_rank_contribution_per_stream.subject_alignment ?? 0;
    const plainContribution =
      fusion.get("workspace_local:memory_entry:44444444-4444-4444-8444-444444444444")
        ?.fused_rank_contribution_per_stream.subject_alignment ?? 0;

    expect(profileContribution).toBeGreaterThan(0);
    expect(plainContribution).toBe(0);
  });
});
