import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { buildEmptyRecallFusionBreakdown } from "../../recall/fusion-delivery-scoring.js";
import { applySessionCoverageRerank } from "../../recall/fusion-delivery-session-coverage.js";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import { RECALL_FUSION_STREAMS } from "../../recall/fusion-delivery-streams.js";
import type {
  RecallFusionBreakdown,
  RecallFusionStream,
  RecallSupplementaryData
} from "../../recall/recall-service-types.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

type CoverageCandidate = Readonly<{
  readonly entry: ReturnType<typeof createMemoryEntry>;
  readonly originPlane: "workspace_local";
  readonly objectKind: "memory_entry";
  readonly effectiveScore: number;
  readonly effectiveFactors: { readonly relevance: number; readonly activation: number };
  readonly fusion: Readonly<RecallFusionBreakdown>;
}>;

function streamRanks(): Record<RecallFusionStream, number | null> {
  return Object.fromEntries(RECALL_FUSION_STREAMS.map((stream) => [stream, null])) as Record<
    RecallFusionStream,
    number | null
  >;
}

function coverageCandidate(input: {
  readonly objectId: string;
  readonly surfaceId: string | null;
  readonly fusedScore: number;
}): CoverageCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(input.objectId);
  return Object.freeze({
    entry: createMemoryEntry({
      object_id: input.objectId,
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      content: "memory content",
      domain_tags: [],
      evidence_refs: [],
      surface_id: input.surfaceId,
      activation_score: 0.5,
    }),
    originPlane: "workspace_local",
    objectKind: "memory_entry",
    effectiveScore: 0,
    effectiveFactors: { relevance: 0, activation: 0 },
    fusion: Object.freeze({
      ...breakdown,
      per_stream_rank: Object.freeze(streamRanks()) as RecallFusionBreakdown["per_stream_rank"],
      fused_rank: 1,
      fused_score: input.fusedScore,
      fused_rank_contribution_per_stream: breakdown.fused_rank_contribution_per_stream
    })
  });
}

function coverageSupplementary(): RecallSupplementaryData {
  return { queryProbes: compileRecallQueryProbes(null) } as unknown as RecallSupplementaryData;
}

describe("applySessionCoverageRerank", () => {
  beforeEach(() => {
    vi.stubEnv("ALAYA_RECALL_COVERAGE_SELECTOR", "force");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("promotes an alternate session candidate within the coverage band", () => {
    const ordered = [
      coverageCandidate({ objectId: "a", surfaceId: "s1", fusedScore: 1.0 }),
      coverageCandidate({ objectId: "b", surfaceId: "s1", fusedScore: 0.98 }),
      coverageCandidate({ objectId: "e", surfaceId: "s2", fusedScore: 0.93 })
    ];

    const result = applySessionCoverageRerank(ordered, coverageSupplementary(), 3);
    expect(result.map((candidate) => candidate.entry.object_id)).toEqual(["a", "e", "b"]);
  });
});
