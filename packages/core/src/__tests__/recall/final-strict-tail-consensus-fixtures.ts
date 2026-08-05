import { createHash } from "node:crypto";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import type {
  FineAssessmentSelectionBoundaryPendingCapture
} from "../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from
  "../../recall/runtime/recall-service-types.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";
import { evidenceSemanticActivationsFromScores } from
  "./fixtures/evidence-semantic-activation.js";

export type SelectionResult = ReturnType<typeof selectFineAssessmentCandidates>;

export type SelectionOverrides = Readonly<{
  readonly captureAnswerFeatures?: boolean;
  readonly capturePacketPlanTrace?: boolean;
  readonly evidenceSemanticScoresByCandidateKey?: ReadonlyMap<string, number>;
  readonly finalOrderAfterCoverage?: "coverage" | "public_relevance" | "delivery_rank";
  readonly maxTotalTokens?: number;
  readonly pathInflowByTarget?: RecallSupplementaryData["pathInflowByTarget"];
  readonly pathInflowAvailability?: RecallSupplementaryData["pathInflowAvailability"];
  readonly perDimensionLimits?: Readonly<Record<string, number>>;
  readonly queryText?: string;
  readonly selectionBoundaryObserver?: (
    boundary: FineAssessmentSelectionBoundaryPendingCapture
  ) => undefined;
  readonly tokenByObjectId?: Readonly<Record<string, number>>;
  readonly verifiedUserAssertionContextsByMemoryId?:
    RecallSupplementaryData["verifiedUserAssertionContextsByMemoryId"];
}>;

export function select(
  candidates: readonly FineAssessmentCandidate[],
  overrides: SelectionOverrides = {}
): SelectionResult {
  const config = createConfig();
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      ...config,
      budgets: {
        ...config.budgets,
        max_total_tokens: overrides.maxTotalTokens ?? config.budgets.max_total_tokens,
        per_dimension_limits: overrides.perDimensionLimits ?? null
      }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(overrides.queryText ?? null),
      embeddingSimilarityScores: Object.fromEntries(
        candidates.map((candidate) => [
          candidate.entry.object_id,
          candidate.entry.object_id === "challenger" ? 0.1 : 0.9
        ])
      ),
      evidenceSemanticActivationsByCandidateKey:
        evidenceSemanticActivationsFromScores(
          overrides.evidenceSemanticScoresByCandidateKey ?? new Map()
        ),
      ...(overrides.pathInflowByTarget === undefined
        ? {}
        : {
            pathInflowByTarget: overrides.pathInflowByTarget,
            pathInflowAvailability: overrides.pathInflowAvailability ?? "available"
          }),
      ...(overrides.verifiedUserAssertionContextsByMemoryId === undefined
        ? {}
        : {
            verifiedUserAssertionContextsByMemoryId:
              overrides.verifiedUserAssertionContextsByMemoryId
          })
    }),
    tokenEstimator: {
      estimate: (content) => {
        const objectId = /Recall content for ([^.]+)\./u.exec(content)?.[1];
        return objectId === undefined
          ? 5
          : overrides.tokenByObjectId?.[objectId] ?? 5;
      }
    },
    rankByCandidateKey: rankMap(candidates),
    finalRelevanceByCandidateKey: relevanceMap(candidates),
    coverageRelevanceByCandidateKey: relevanceMap(candidates),
    finalOrderAfterCoverage: overrides.finalOrderAfterCoverage ?? "delivery_rank",
    captureAnswerFeatures: overrides.captureAnswerFeatures,
    capturePacketPlanTrace: overrides.capturePacketPlanTrace,
    selectionBoundaryObserver: overrides.selectionBoundaryObserver
  });
}

export function baselineCandidates(): readonly FineAssessmentCandidate[] {
  return baselineIds().map((objectId, index) =>
    ranked(createCandidate(objectId), index + 1, 1 - index * 0.01)
  );
}

export function consensusCandidates(
  replacements: Readonly<Record<string, FineAssessmentCandidate>> = {}
): readonly FineAssessmentCandidate[] {
  const candidates = baselineCandidates().map((candidate) =>
    replacements[candidate.entry.object_id] ?? candidate
  );
  const challenger = replacements.challenger ?? createCandidate("challenger");
  return [
    withEmbeddingRank(candidates[0]!, 4),
    withEmbeddingRank(candidates[1]!, 3),
    candidates[2]!,
    withEmbeddingRank(candidates[3]!, 5),
    withEmbeddingRank(candidates[4]!, 2),
    ...candidates.slice(5),
    withEmbeddingRank(ranked(challenger, 11, 0.4), 1)
  ];
}

export function ranked(
  candidate: FineAssessmentCandidate,
  fusedRank: number,
  fusedScore: number
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: { ...candidate.fusion, fused_rank: fusedRank, fused_score: fusedScore }
  };
}

export function withEmbeddingRank(
  candidate: FineAssessmentCandidate,
  rank: number
): FineAssessmentCandidate {
  return withStreamRanks(candidate, { embedding_similarity: rank });
}

export function withEmbeddingSimilarity(
  candidate: FineAssessmentCandidate,
  embeddingSimilarity: number
): FineAssessmentCandidate {
  return {
    ...candidate,
    effectiveFactors: {
      ...candidate.effectiveFactors,
      embedding_similarity: embeddingSimilarity
    }
  };
}

export function withStreamRanks(
  candidate: FineAssessmentCandidate,
  ranks: Partial<FineAssessmentCandidate["fusion"]["per_stream_rank"]>
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      per_stream_rank: { ...candidate.fusion.per_stream_rank, ...ranks }
    }
  };
}

export function relevanceMap(
  candidates: readonly FineAssessmentCandidate[]
): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_score
  ]));
}

export function reciprocalAnswersWithPath(
  targetObjectId: string,
  sourceObjectId: string
): NonNullable<RecallSupplementaryData["pathInflowByTarget"]> {
  const edge = (seedObjectId: string, targetId: string) => ({
    pathId: "path-reciprocal",
    relationKind: "answers_with",
    seedObjectId,
    targetObjectId: targetId,
    seedAnchor: { kind: "object" as const, object_id: seedObjectId },
    targetAnchor: { kind: "object" as const, object_id: targetId },
    pathSourceVersion: "path-v1",
    weight: 0.7
  });
  return {
    [targetObjectId]: [edge(sourceObjectId, targetObjectId)],
    [sourceObjectId]: [edge(targetObjectId, sourceObjectId)]
  };
}

export function baselineIds(): readonly string[] {
  return Array.from({ length: 10 }, (_, index) =>
    `baseline-${String(index + 1).padStart(2, "0")}`
  );
}

export function packetIds(result: SelectionResult): readonly string[] {
  return result.candidates.map((candidate) => candidate.object_id);
}

export function finalDiagnosticRanks(
  result: SelectionResult
): readonly (readonly [string, number])[] {
  return result.diagnostics
    .filter((row): row is typeof row & { readonly final_rank: number } =>
      row.final_rank !== null
    )
    .sort((left, right) => left.final_rank - right.final_rank)
    .map((row) => [row.object_id, row.final_rank]);
}

export function exactResultDigest(result: SelectionResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}
