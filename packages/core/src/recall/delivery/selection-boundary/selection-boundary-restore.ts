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
import {
  assertSelectionBoundaryJsonValue,
  selectionBoundaryJsonSha256
} from "./selection-boundary-json.js";
import { completeFineAssessmentPreProjection } from
  "./pre-projection/observation.js";

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
  assertFinalCandidateIdentity(boundary);
  if (boundary.expected.pre_projection !== undefined) {
    assertPreProjection(
      boundary.expected.pre_projection,
      boundary.expected.candidate_keys
    );
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

function assertFinalCandidateIdentity(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
  const finalCandidateKeys = boundary.expected.candidate_keys;
  const consensusCandidateKeys =
    boundary.expected.packet_consensus.actual_candidate_keys;
  if (
    !Array.isArray(finalCandidateKeys) ||
    !Array.isArray(consensusCandidateKeys)
  ) {
    throwSelectionBoundaryFidelityMismatch();
  }
  assertUniqueKeys(finalCandidateKeys);
  assertUniqueKeys(consensusCandidateKeys);
  if (
    finalCandidateKeys.length !== consensusCandidateKeys.length ||
    finalCandidateKeys.some((key, index) =>
      key !== consensusCandidateKeys[index]
    )
  ) {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertPreProjection(
  observation: unknown,
  deliveredCandidateKeys: readonly string[]
): void {
  const parsed = parsePreProjection(observation);
  assertUniqueKeys(parsed.candidate_keys);
  assertUniqueKeys(parsed.admission_actions.map((action) => action.candidate_key));
  assertUniqueKeys(parsed.projection_actions.map((action) => action.candidate_key));
  assertUniqueKeys(parsed.introduced_candidate_keys);
  assertAdmissionActions(parsed);
  assertProjectionActions(parsed, deliveredCandidateKeys);
}

function parsePreProjection(
  observation: unknown
): NonNullable<
  FineAssessmentSelectionBoundaryCase["expected"]["pre_projection"]
> {
  if (
    !isRecord(observation) ||
    observation.schema_version !== 1 ||
    !Array.isArray(observation.candidate_keys) ||
    !Array.isArray(observation.admission_actions) ||
    !Array.isArray(observation.projection_actions) ||
    !Array.isArray(observation.introduced_candidate_keys) ||
    !isNonNegativeFinite(observation.token_total) ||
    typeof observation.ordered_subsequence !== "boolean" ||
    typeof observation.qualified_ordered_subsequence !== "boolean"
  ) {
    throwSelectionBoundaryFidelityMismatch();
  }
  const parsed = observation as NonNullable<
    FineAssessmentSelectionBoundaryCase["expected"]["pre_projection"]
  >;
  if (
    parsed.admission_actions.some((action) => !isRecord(action)) ||
    parsed.projection_actions.some((action) => !isRecord(action))
  ) {
    throwSelectionBoundaryFidelityMismatch();
  }
  return parsed;
}

function assertAdmissionActions(
  parsed: NonNullable<
    FineAssessmentSelectionBoundaryCase["expected"]["pre_projection"]
  >
): void {
  let retainedIndex = 0;
  let retainedTokenTotal = 0;
  for (const [index, action] of parsed.admission_actions.entries()) {
    if (
      !Number.isInteger(action.selection_order) ||
      action.selection_order !== index + 1
    ) {
      throwSelectionBoundaryFidelityMismatch();
    }
    if (action.action === "retain") {
      retainedIndex += 1;
      if (
        action.dropped_reason !== null ||
        action.pre_projection_rank !== retainedIndex ||
        parsed.candidate_keys[retainedIndex - 1] !== action.candidate_key
      ) {
        throwSelectionBoundaryFidelityMismatch();
      }
      retainedTokenTotal = assertRetainedWitness(
        action.witness,
        retainedIndex - 1,
        retainedTokenTotal
      );
    } else if (
      action.action !== "exclude" ||
      action.dropped_reason === null ||
      action.pre_projection_rank !== null ||
      !witnessMatchesExclusion(action.witness, action.dropped_reason)
    ) {
      throwSelectionBoundaryFidelityMismatch();
    }
  }
  if (
    retainedIndex !== parsed.candidate_keys.length ||
    retainedTokenTotal !== parsed.token_total
  ) {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertProjectionActions(
  observation: NonNullable<
    FineAssessmentSelectionBoundaryCase["expected"]["pre_projection"]
  >,
  deliveredCandidateKeys: readonly string[]
): void {
  const expected = completeFineAssessmentPreProjection({
    schema_version: observation.schema_version,
    candidate_keys: observation.candidate_keys,
    token_total: observation.token_total,
    admission_actions: observation.admission_actions
  }, deliveredCandidateKeys);
  if (
    selectionBoundaryJsonSha256(observation) !==
    selectionBoundaryJsonSha256(expected)
  ) {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertRetainedWitness(
  witness: unknown,
  selectedCountBefore: number,
  tokenTotalBefore: number
): number {
  if (
    !isRecord(witness) ||
    witness.kind !== "retained" ||
    witness.selected_count_before !== selectedCountBefore ||
    witness.token_total_before !== tokenTotalBefore ||
    !isNonNegativeFinite(witness.token_estimate)
  ) {
    throwSelectionBoundaryFidelityMismatch();
  }
  return tokenTotalBefore + witness.token_estimate;
}

function witnessMatchesExclusion(
  witness: unknown,
  reason: string
): boolean {
  if (!isRecord(witness) || witness.kind !== reason) return false;
  if (reason === "duplicate") {
    return isNonEmptyString(witness.retained_candidate_key);
  }
  if (reason === "dimension_limit") {
    return isNonEmptyString(witness.dimension) &&
      isNonNegativeInteger(witness.accepted_before) &&
      isNonNegativeInteger(witness.limit);
  }
  if (reason === "max_entries") {
    return isNonNegativeInteger(witness.accepted_before) &&
      isNonNegativeInteger(witness.limit);
  }
  if (reason === "max_total_tokens") {
    return isNonNegativeFinite(witness.token_total_before) &&
      isNonNegativeFinite(witness.token_estimate) &&
      isNonNegativeFinite(witness.limit);
  }
  return reason === "embedding_head_dominance" &&
    isNonEmptyString(witness.dominating_candidate_key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
