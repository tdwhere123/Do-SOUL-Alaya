import type {
  FineAssessmentSelectionParams
} from "../fine-assessment-selection.js";
import type {
  FineAssessmentSelectionBoundaryCase,
  FineAssessmentSelectionBoundaryInput,
  SelectionBoundaryNumberMap,
  SerializedRecallSupplementaryData
} from "./selection-boundary-types.js";
import type { RecallSupplementaryData } from
  "../../runtime/recall-service-types.js";
import { assertSelectionBoundaryJsonValue } from "./selection-boundary-json.js";

export const SELECTION_BOUNDARY_FIDELITY_MISMATCH =
  "selection boundary fidelity mismatch";

export function throwSelectionBoundaryFidelityMismatch(): never {
  throw new Error(SELECTION_BOUNDARY_FIDELITY_MISMATCH);
}

export function validateSelectionBoundary(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
  if (boundary.schema_version !== 2) throwSelectionBoundaryFidelityMismatch();
  assertSelectionBoundaryJsonValue(boundary);
  if (!/^sha256:[0-9a-f]{64}$/u.test(
    boundary.expected.visible_result_sha256
  )) {
    throwSelectionBoundaryFidelityMismatch();
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

export function restoreSelectionParams(
  input: FineAssessmentSelectionBoundaryInput
): FineAssessmentSelectionParams {
  return {
    orderedCandidates: input.ordered_candidates,
    config: input.config,
    supplementaryData: restoreSupplementaryData(input.supplementary_data),
    tokenEstimator: createCapturedTokenEstimator(
      input.token_estimates_by_content
    ),
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

export function restoreSupplementaryData(
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

export function createCapturedTokenEstimator(
  entries: SelectionBoundaryNumberMap
): FineAssessmentSelectionParams["tokenEstimator"] {
  const tokenEstimates = new Map(entries);
  return {
    estimate: (content) => {
      const estimate = tokenEstimates.get(content);
      if (estimate === undefined) throwSelectionBoundaryFidelityMismatch();
      return estimate;
    }
  };
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
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertNumberMapEntries(entries: SelectionBoundaryNumberMap): void {
  assertUniqueEntryKeys(entries);
  if (entries.some((entry) => typeof entry[1] !== "number")) {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertUniqueEntryKeys(
  entries: readonly (readonly [string, unknown])[]
): void {
  if (entries.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
    throwSelectionBoundaryFidelityMismatch();
  }
  assertUniqueKeys(entries.map((entry) => entry[0]));
}
