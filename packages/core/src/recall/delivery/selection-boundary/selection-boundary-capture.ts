import type {
  FineAssessmentSelectionParams,
  FineAssessmentSelectionResult
} from "../fine-assessment-selection.js";
import type {
  FineAssessmentSelectionBoundaryCase,
  FineAssessmentSelectionBoundaryExpected,
  FineAssessmentSelectionBoundaryInput,
  SelectionBoundaryNumberMap,
  SerializedRecallSupplementaryData
} from "./selection-boundary-types.js";
import type { RecallPacketPlanObservation } from
  "../packet-plan/packet-plan-trace.js";
import {
  assertSelectionBoundaryJsonValue,
  cloneSelectionBoundaryJson,
  selectionBoundaryJsonSha256
} from "./selection-boundary-json.js";

export interface FineAssessmentSelectionBoundaryCapture {
  readonly params: FineAssessmentSelectionParams;
  readonly tokenEstimatesByContent: ReadonlyMap<string, number>;
}

export function createSelectionBoundaryCapture(
  params: FineAssessmentSelectionParams
): FineAssessmentSelectionBoundaryCapture {
  const tokenEstimatesByContent = new Map<string, number>();
  return Object.freeze({
    params: Object.freeze({
      ...params,
      tokenEstimator: {
        estimate: (content: string) => {
          const estimate = params.tokenEstimator.estimate(content);
          const prior = tokenEstimatesByContent.get(content);
          if (prior !== undefined && prior !== estimate) {
            throw new Error("selection boundary fidelity mismatch: unstable token estimate");
          }
          tokenEstimatesByContent.set(content, estimate);
          return estimate;
        }
      }
    }),
    tokenEstimatesByContent
  });
}

export function captureFineAssessmentSelectionBoundary(
  params: FineAssessmentSelectionParams,
  result: FineAssessmentSelectionResult,
  packetConsensus: Readonly<RecallPacketPlanObservation>,
  tokenEstimatesByContent: ReadonlyMap<string, number>
): FineAssessmentSelectionBoundaryCase {
  const boundary = Object.freeze({
    schema_version: 2 as const,
    input: buildSelectionBoundaryInput(params, tokenEstimatesByContent),
    expected: buildSelectionBoundaryExpected(result, packetConsensus)
  });
  assertSelectionBoundaryJsonValue(boundary);
  return boundary;
}

export function notifySelectionBoundaryObserver(
  params: FineAssessmentSelectionParams,
  result: FineAssessmentSelectionResult,
  packetConsensus: Readonly<RecallPacketPlanObservation>,
  tokenEstimatesByContent: ReadonlyMap<string, number>
): void {
  const observerResult = params.selectionBoundaryObserver?.(
    captureFineAssessmentSelectionBoundary(
      params, result, packetConsensus, tokenEstimatesByContent
    )
  );
  if (observerResult !== undefined) {
    throw new Error("selection boundary observer must return undefined synchronously");
  }
}

function buildSelectionBoundaryInput(
  params: FineAssessmentSelectionParams,
  tokenEstimatesByContent: ReadonlyMap<string, number>
): FineAssessmentSelectionBoundaryInput {
  return Object.freeze({
    ordered_candidates: cloneSelectionBoundaryJson(params.orderedCandidates),
    config: cloneSelectionBoundaryJson(params.config),
    supplementary_data: serializeSupplementaryData(params.supplementaryData),
    token_estimates_by_content: stableNumberEntries(tokenEstimatesByContent),
    rank_by_candidate_key: stableNumberEntries(params.rankByCandidateKey),
    ...serializeOptionalSelectionInputs(params)
  });
}

function serializeOptionalSelectionInputs(
  params: FineAssessmentSelectionParams
): Partial<FineAssessmentSelectionBoundaryInput> {
  return {
    ...(params.finalRelevanceByCandidateKey === undefined ? {} : {
      final_relevance_by_candidate_key:
        stableNumberEntries(params.finalRelevanceByCandidateKey)
    }),
    ...(params.coverageRelevanceByCandidateKey === undefined ? {} : {
      coverage_relevance_by_candidate_key:
        stableNumberEntries(params.coverageRelevanceByCandidateKey)
    }),
    ...(params.finalOrderAfterCoverage === undefined ? {} : {
      final_order_after_coverage: params.finalOrderAfterCoverage
    }),
    ...(params.maxHeadDropAfterCoverage === undefined ? {} : {
      max_head_drop_after_coverage: params.maxHeadDropAfterCoverage
    }),
    ...(params.answerRelevanceRankByCandidateKey === undefined ? {} : {
      answer_relevance_rank_by_candidate_key:
        stableNumberEntries(params.answerRelevanceRankByCandidateKey)
    }),
    ...(params.captureAnswerFeatures === undefined ? {} : {
      capture_answer_features: params.captureAnswerFeatures
    }),
    ...(params.capturePacketPlanTrace === undefined ? {} : {
      capture_packet_plan_trace: params.capturePacketPlanTrace
    }),
    ...(params.deepHeadTraceByCandidateKey === undefined ? {} : {
      deep_head_trace_by_candidate_key: stableEntries(
        params.deepHeadTraceByCandidateKey
      )
    })
  };
}

export function buildSelectionBoundaryExpected(
  result: FineAssessmentSelectionResult,
  packetConsensus: Readonly<RecallPacketPlanObservation>,
  packetPlanVisible = result.packetPlanObservation !== undefined
): FineAssessmentSelectionBoundaryExpected {
  return Object.freeze({
    candidate_keys: packetConsensus.actual_candidate_keys,
    drop_tuples: Object.freeze(result.diagnostics.map((diagnostic) =>
      Object.freeze([
        diagnostic.candidate_key,
        diagnostic.dropped_reason
      ] as const)
    )),
    token_totals: Object.freeze({
      delivered: result.candidates.reduce(
        (total, candidate) => total + candidate.token_estimate,
        0
      )
    }),
    packet_consensus: packetConsensus,
    visible_result_sha256: selectionBoundaryJsonSha256({
      candidates: result.candidates,
      diagnostics: result.diagnostics,
      ...(packetPlanVisible ? { packetPlanObservation: packetConsensus } : {})
    })
  });
}

function serializeSupplementaryData(
  data: FineAssessmentSelectionParams["supplementaryData"]
): SerializedRecallSupplementaryData {
  const {
    evidenceSemanticScoresByCandidateKey,
    answerRelevanceScoresByCandidateKey,
    ...plainData
  } = data;
  return Object.freeze({
    ...cloneSelectionBoundaryJson(plainData),
    evidenceSemanticScoresByCandidateKey:
      stableNumberEntries(evidenceSemanticScoresByCandidateKey),
    ...(answerRelevanceScoresByCandidateKey === undefined ? {} : {
      answerRelevanceScoresByCandidateKey:
        stableNumberEntries(answerRelevanceScoresByCandidateKey)
    })
  });
}

function stableNumberEntries(
  map: ReadonlyMap<string, number>
): SelectionBoundaryNumberMap {
  return stableEntries(map);
}

function stableEntries<T>(
  map: ReadonlyMap<string, T>
): readonly (readonly [string, T])[] {
  return Object.freeze(
    [...map.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) =>
        Object.freeze([key, cloneSelectionBoundaryJson(value)] as const)
      )
  );
}
