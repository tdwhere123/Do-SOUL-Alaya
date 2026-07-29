import {
  selectFineAssessmentCandidates,
  type FineAssessmentSelectionParams,
  type FineAssessmentSelectionResult
} from "../fine-assessment-selection.js";
import { buildSelectionBoundaryExpected } from
  "./selection-boundary-capture.js";
import type {
  FineAssessmentSelectionBoundaryCase,
  FineAssessmentSelectionBoundaryInput,
  SelectionBoundaryNumberMap,
  SerializedRecallSupplementaryData
} from "./selection-boundary-types.js";
import type { RecallSupplementaryData } from
  "../../runtime/recall-service-types.js";
import {
  assertSelectionBoundaryJsonValue,
  selectionBoundaryJsonSha256
} from "./selection-boundary-json.js";

export type { FineAssessmentSelectionBoundaryCase } from
  "./selection-boundary-types.js";

export function replayFineAssessmentSelectionBoundary(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionResult {
  validateSelectionBoundary(boundary);
  const params = restoreSelectionParams(boundary.input);
  const replayed = selectFineAssessmentCandidates({
    ...params,
    capturePacketPlanTrace: true
  });
  const packetConsensus = replayed.packetPlanObservation;
  if (packetConsensus === undefined) throwFidelityMismatch();
  const actual = buildSelectionBoundaryExpected(
    replayed,
    packetConsensus,
    boundary.input.capture_packet_plan_trace === true
  );
  if (
    selectionBoundaryJsonSha256(actual) !==
    selectionBoundaryJsonSha256(boundary.expected)
  ) {
    throwFidelityMismatch();
  }
  if (boundary.input.capture_packet_plan_trace === true) return replayed;
  return Object.freeze({
    candidates: replayed.candidates,
    diagnostics: replayed.diagnostics
  });
}

function validateSelectionBoundary(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
  if (boundary.schema_version !== 2) throwFidelityMismatch();
  assertSelectionBoundaryJsonValue(boundary);
  if (!/^sha256:[0-9a-f]{64}$/u.test(
    boundary.expected.visible_result_sha256
  )) {
    throwFidelityMismatch();
  }
  assertUniqueKeys(
    boundary.input.ordered_candidates.map(
      (candidate) => candidate.fusion.candidate_key
    )
  );
  for (const entries of serializedNumberMaps(boundary.input)) {
    assertNumberMapEntries(entries);
  }
  if (boundary.input.deep_head_trace_by_candidate_key !== undefined) {
    assertUniqueEntryKeys(boundary.input.deep_head_trace_by_candidate_key);
  }
}

function serializedNumberMaps(
  input: FineAssessmentSelectionBoundaryInput
): readonly SelectionBoundaryNumberMap[] {
  return [
    input.token_estimates_by_content,
    input.rank_by_candidate_key,
    input.supplementary_data.evidenceSemanticScoresByCandidateKey,
    ...(input.supplementary_data.answerRelevanceScoresByCandidateKey === undefined
      ? []
      : [input.supplementary_data.answerRelevanceScoresByCandidateKey]),
    ...(input.final_relevance_by_candidate_key === undefined
      ? []
      : [input.final_relevance_by_candidate_key]),
    ...(input.coverage_relevance_by_candidate_key === undefined
      ? []
      : [input.coverage_relevance_by_candidate_key]),
    ...(input.answer_relevance_rank_by_candidate_key === undefined
      ? []
      : [input.answer_relevance_rank_by_candidate_key])
  ];
}

function assertUniqueKeys(keys: readonly string[]): void {
  if (
    keys.some((key) => typeof key !== "string" || key.length === 0) ||
    new Set(keys).size !== keys.length
  ) {
    throwFidelityMismatch();
  }
}

function assertNumberMapEntries(entries: SelectionBoundaryNumberMap): void {
  assertUniqueEntryKeys(entries);
  if (entries.some((entry) => typeof entry[1] !== "number")) {
    throwFidelityMismatch();
  }
}

function assertUniqueEntryKeys(
  entries: readonly (readonly [string, unknown])[]
): void {
  if (entries.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
    throwFidelityMismatch();
  }
  assertUniqueKeys(entries.map((entry) => entry[0]));
}

function restoreSelectionParams(
  input: FineAssessmentSelectionBoundaryInput
): FineAssessmentSelectionParams {
  const tokenEstimates = new Map(input.token_estimates_by_content);
  return {
    orderedCandidates: input.ordered_candidates,
    config: input.config,
    supplementaryData: restoreSupplementaryData(input.supplementary_data),
    tokenEstimator: {
      estimate: (content) => {
        const estimate = tokenEstimates.get(content);
        if (estimate === undefined) throwFidelityMismatch();
        return estimate;
      }
    },
    rankByCandidateKey: new Map(input.rank_by_candidate_key),
    ...(input.final_relevance_by_candidate_key === undefined ? {} : {
      finalRelevanceByCandidateKey: new Map(
        input.final_relevance_by_candidate_key
      )
    }),
    ...(input.coverage_relevance_by_candidate_key === undefined ? {} : {
      coverageRelevanceByCandidateKey: new Map(
        input.coverage_relevance_by_candidate_key
      )
    }),
    ...(input.final_order_after_coverage === undefined ? {} : {
      finalOrderAfterCoverage: input.final_order_after_coverage
    }),
    ...(input.max_head_drop_after_coverage === undefined ? {} : {
      maxHeadDropAfterCoverage: input.max_head_drop_after_coverage
    }),
    ...(input.answer_relevance_rank_by_candidate_key === undefined ? {} : {
      answerRelevanceRankByCandidateKey: new Map(
        input.answer_relevance_rank_by_candidate_key
      )
    }),
    ...(input.capture_answer_features === undefined ? {} : {
      captureAnswerFeatures: input.capture_answer_features
    }),
    ...(input.deep_head_trace_by_candidate_key === undefined ? {} : {
      deepHeadTraceByCandidateKey: new Map(
        input.deep_head_trace_by_candidate_key
      )
    })
  };
}

function restoreSupplementaryData(
  data: SerializedRecallSupplementaryData
): RecallSupplementaryData {
  const {
    evidenceSemanticScoresByCandidateKey,
    answerRelevanceScoresByCandidateKey,
    ...plainData
  } = data;
  return {
    ...plainData,
    evidenceSemanticScoresByCandidateKey: new Map(
      evidenceSemanticScoresByCandidateKey
    ),
    ...(answerRelevanceScoresByCandidateKey === undefined ? {} : {
      answerRelevanceScoresByCandidateKey: new Map(
        answerRelevanceScoresByCandidateKey
      )
    })
  };
}

function throwFidelityMismatch(): never {
  throw new Error("selection boundary fidelity mismatch");
}
