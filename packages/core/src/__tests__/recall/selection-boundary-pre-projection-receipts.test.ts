import { MemoryDimension } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";

import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import {
  materializeFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryPendingCapture
} from
  "../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import {
  replayFineAssessmentSelectionBoundary
} from "../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import {
  validateSelectionBoundary
} from "../../recall/delivery/selection-boundary/selection-boundary-restore.js";
import type {
  FineAssessmentPreProjectionObservation,
  FineAssessmentSelectionBoundaryCase
} from "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import type { RecallSupplementaryData } from
  "../../recall/runtime/recall-service-types.js";
import {
  createCandidate,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

describe("selection boundary pre-projection decision receipts", () => {
  it.each([
    {
      name: "duplicate",
      fixture: duplicateFixture,
      reason: "duplicate",
      witness: {
        kind: "duplicate",
        retained_candidate_key: "workspace_local:memory_entry:shared"
      }
    },
    {
      name: "dimension limit",
      fixture: dimensionLimitFixture,
      reason: "dimension_limit",
      witness: {
        kind: "dimension_limit",
        dimension: MemoryDimension.PROCEDURE,
        accepted_before: 1,
        limit: 1
      }
    },
    {
      name: "token limit",
      fixture: tokenLimitFixture,
      reason: "max_total_tokens",
      witness: {
        kind: "max_total_tokens",
        token_total_before: 5,
        token_estimate: 5,
        limit: 5
      }
    },
    {
      name: "embedding dominance",
      fixture: embeddingDominanceFixture,
      reason: "embedding_head_dominance",
      witness: {
        kind: "embedding_head_dominance",
        dominating_candidate_key: "workspace_local:memory_entry:embedding-head"
      }
    }
  ])("captures and replays the live $name receipt", ({
    fixture,
    reason,
    witness
  }) => {
    const boundary = captureBoundary(fixture());
    const preProjection = requirePreProjection(boundary);
    const excluded = preProjection.admission_actions.find(
      (action) => action.dropped_reason === reason
    );

    expect(excluded).toMatchObject({
      action: "exclude",
      pre_projection_rank: null,
      dropped_reason: reason,
      witness
    });
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
  });

  it("fails canonical validation when projection receipts disagree with delivery", () => {
    const boundary = captureBoundary({
      candidates: rankedCandidates(4)
    });
    const preProjection = requirePreProjection(boundary);
    const reversed = reverseProjection(preProjection);
    const inconsistent = {
      ...boundary,
      expected: {
        ...boundary.expected,
        pre_projection: reversed
      }
    } satisfies FineAssessmentSelectionBoundaryCase;

    expect(() => replayFineAssessmentSelectionBoundary(inconsistent))
      .toThrow(/selection boundary fidelity mismatch/u);
    expect(() => validateSelectionBoundary(inconsistent))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("marks an accepted consensus introduction as unqualified", () => {
    const boundary = captureBoundary(consensusFixture());
    const preProjection = requirePreProjection(boundary);

    expect(boundary.expected.packet_consensus.decision).toEqual({
      status: "accepted",
      reason: "strict_tail_consensus"
    });
    expect(preProjection.introduced_candidate_keys).toEqual([
      "workspace_local:memory_entry:challenger"
    ]);
    expect(preProjection.projection_actions.some((action) =>
      action.action === "exclude" ||
      action.reason_code === "unwitnessed_reorder"
    )).toBe(true);
    expect(preProjection.qualified_ordered_subsequence).toBe(false);
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
  });

  it("replays a legacy schema-v2 boundary without pre-projection", () => {
    const current = captureBoundary({ candidates: rankedCandidates(4) });
    const { pre_projection: _preProjection, ...legacyExpected } = current.expected;
    const legacy = {
      ...current,
      expected: legacyExpected
    } satisfies FineAssessmentSelectionBoundaryCase;

    expect(() => replayFineAssessmentSelectionBoundary(legacy)).not.toThrow();
  });
});

type CaptureFixture = Readonly<{
  readonly candidates: readonly FineAssessmentCandidate[];
  readonly maxEntries?: number;
  readonly maxTotalTokens?: number;
  readonly perDimensionLimits?: Readonly<Record<string, number>>;
  readonly supplementaryData?: RecallSupplementaryData;
  readonly tokenEstimator?: (content: string) => number;
  readonly answerRelevanceRankByCandidateKey?: ReadonlyMap<string, number>;
  readonly finalOrderAfterCoverage?: "coverage" | "public_relevance" | "delivery_rank";
}>;

function captureBoundary(
  fixture: CaptureFixture
): FineAssessmentSelectionBoundaryCase {
  let boundary: FineAssessmentSelectionBoundaryCase | undefined;
  const config = createConfig();
  selectFineAssessmentCandidates({
    orderedCandidates: fixture.candidates,
    config: {
      ...config,
      budgets: {
        max_entries: fixture.maxEntries ?? config.budgets.max_entries,
        max_total_tokens:
          fixture.maxTotalTokens ?? config.budgets.max_total_tokens,
        per_dimension_limits: fixture.perDimensionLimits ?? null
      }
    },
    supplementaryData:
      fixture.supplementaryData ?? createSupplementaryData(),
    tokenEstimator: { estimate: fixture.tokenEstimator ?? (() => 5) },
    rankByCandidateKey: rankMap(fixture.candidates),
    finalRelevanceByCandidateKey: relevanceMap(fixture.candidates),
    coverageRelevanceByCandidateKey: relevanceMap(fixture.candidates),
    finalOrderAfterCoverage:
      fixture.finalOrderAfterCoverage ?? "coverage",
    answerRelevanceRankByCandidateKey:
      fixture.answerRelevanceRankByCandidateKey,
    capturePacketPlanTrace: true,
    selectionBoundaryObserver: (
      pending: FineAssessmentSelectionBoundaryPendingCapture
    ) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }
  });
  if (boundary === undefined) throw new Error("selection boundary was not observed");
  return boundary;
}

function duplicateFixture(): CaptureFixture {
  const anchor = createRankedCandidate("shared", 1, 1);
  const duplicateBase = createRankedCandidate("shared", 2, 0.9);
  const duplicate = {
    ...duplicateBase,
    originPlane: "global" as const,
    fusion: {
      ...duplicateBase.fusion,
      candidate_key: "global:memory_entry:shared"
    }
  };
  return { candidates: [anchor, duplicate] };
}

function dimensionLimitFixture(): CaptureFixture {
  return {
    candidates: rankedCandidates(2),
    perDimensionLimits: { [MemoryDimension.PROCEDURE]: 1 }
  };
}

function tokenLimitFixture(): CaptureFixture {
  return {
    candidates: rankedCandidates(2),
    maxTotalTokens: 5
  };
}

function embeddingDominanceFixture(): CaptureFixture {
  const conflict = createRankedCandidate("conflict", 1, 0.99);
  const protectedWinner = createRankedCandidate("protected", 2, 0.9);
  const embeddingBase = createRankedCandidate("embedding-head", 3, 0.7);
  const embeddingHead = withEmbeddingRank(embeddingBase, 1);
  const novel = createRankedCandidate("novel", 4, 0.4);
  const candidates = [conflict, protectedWinner, embeddingHead, novel];
  return {
    candidates,
    maxEntries: 2,
    supplementaryData: createSupplementaryData({
      evidenceGistsByMemoryId: {
        conflict: "shared-gist",
        protected: "protected-gist",
        "embedding-head": "shared-gist",
        novel: "novel-gist"
      },
      embeddingSimilarityScores: {
        conflict: 0.2,
        "embedding-head": 0.9
      }
    }),
    answerRelevanceRankByCandidateKey: new Map([
      [protectedWinner.fusion.candidate_key, 1]
    ])
  };
}

function consensusFixture(): CaptureFixture {
  const baseline = baselineIds().map((objectId, index) =>
    createRankedCandidate(objectId, index + 1, 1 - index * 0.01)
  );
  const challenger = createRankedCandidate("challenger", 11, 0.4);
  const candidates = [
    withEmbeddingRank(baseline[0]!, 4),
    withEmbeddingRank(baseline[1]!, 3),
    baseline[2]!,
    withEmbeddingRank(baseline[3]!, 5),
    withEmbeddingRank(baseline[4]!, 2),
    ...baseline.slice(5),
    withEmbeddingRank(challenger, 1)
  ];
  return {
    candidates,
    supplementaryData: createSupplementaryData({
      embeddingSimilarityScores: Object.fromEntries(candidates.map(
        (candidate) => [
          candidate.entry.object_id,
          candidate.entry.object_id === "challenger" ? 0.1 : 0.9
        ]
      ))
    }),
    finalOrderAfterCoverage: "delivery_rank"
  };
}

function reverseProjection(
  observation: FineAssessmentPreProjectionObservation
): FineAssessmentPreProjectionObservation {
  const size = observation.candidate_keys.length;
  return {
    ...observation,
    projection_actions: observation.candidate_keys.map(
      (candidateKey, index) => ({
        candidate_key: candidateKey,
        action: "retain",
        pre_projection_rank: index + 1,
        delivered_rank: size - index,
        qualification: "ineligible",
        reason_code: "unwitnessed_reorder",
        witness: {
          kind: "rank_transition",
          pre_projection_rank: index + 1,
          delivered_rank: size - index
        }
      })
    ),
    introduced_candidate_keys: [],
    ordered_subsequence: false,
    qualified_ordered_subsequence: false
  };
}

function requirePreProjection(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentPreProjectionObservation {
  const observation = boundary.expected.pre_projection;
  if (observation === undefined) {
    throw new Error("selection boundary did not capture pre-projection");
  }
  return observation;
}

function rankedCandidates(count: number): readonly FineAssessmentCandidate[] {
  return Array.from({ length: count }, (_, index) =>
    createRankedCandidate(`candidate-${index + 1}`, index + 1, 1 - index * 0.05)
  );
}

function withEmbeddingRank(
  candidate: FineAssessmentCandidate,
  rank: number
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        embedding_similarity: rank
      }
    }
  };
}

function relevanceMap(
  candidates: readonly FineAssessmentCandidate[]
): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_score
  ]));
}

function baselineIds(): readonly string[] {
  return Array.from({ length: 10 }, (_, index) =>
    `baseline-${String(index + 1).padStart(2, "0")}`
  );
}
