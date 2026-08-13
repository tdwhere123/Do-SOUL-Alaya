import type {
  FineAssessmentSelectionBoundaryCase,
  FineAssessmentSelectionBoundaryInput,
  SelectionBoundaryNumberMap,
  SerializedRecallSupplementaryData
} from "./selection-boundary-types.js";
import {
  assertSelectionBoundaryJsonValue,
  selectionBoundaryJsonSha256
} from "./selection-boundary-json.js";
import { completeFineAssessmentPreProjection } from
  "./pre-projection/observation.js";
import {
  assertEvidenceSemanticReceipts,
} from "./validation/evidence-semantic-receipt.js";
import { assertEvidenceFtsReceipts } from
  "./validation/evidence-fts-receipt.js";
import {
  SELECTION_BOUNDARY_FIDELITY_MISMATCH,
  throwSelectionBoundaryFidelityMismatch
} from "./validation/fidelity-error.js";
import { verifyRecallFiniteFieldSeal } from "../../field/finite-field-seal.js";
import { verifyRecallRetrievalFieldRefinementReceipt } from
  "../../field/refinement/field-refinement-receipt.js";
import { verifyRecallQueryFieldAttributionReceipt } from
  "../../field/query-attribution/query-field-attribution.js";
import { verifyRecallQueryFactFrameExtractionCapture } from
  "../../field/query-attribution/query-fact-frame-attribution-producer.js";
import { verifyCoverageSelectionOperatorConfig } from
  "../../field/facility/selection-objective.js";
import { verifyRecallFieldRefinementStopCertificate } from
  "../../field/refinement/field-refinement-stop-certificate.js";
import { verifyRecallRelevanceUpperBoundReceipt } from
  "../../rerank/relevance-upper-bound-receipt.js";
import { assertOpenSemanticCandidateActivations } from
  "./validation/open-semantic-candidate-activation-receipt.js";
import { restoreCapturedPacketCandidates } from
  "./validation/packet-order.js";

export {
  createCapturedTokenEstimator,
  restoreSelectionParams,
  restoreSupplementaryData
} from "./restoration/selection-params.js";

export {
  SELECTION_BOUNDARY_FIDELITY_MISMATCH,
  throwSelectionBoundaryFidelityMismatch
};

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
  restoreCapturedPacketCandidates(boundary.input);
  for (const entries of serializedNumberMaps(boundary.input)) {
    assertNumberMapEntries(entries);
  }
  if (boundary.input.deep_head_trace_by_candidate_key !== undefined) {
    assertUniqueEntryKeys(boundary.input.deep_head_trace_by_candidate_key);
  }
  for (const entries of serializedSupplementaryMaps(boundary.input)) {
    assertUniqueEntryKeys(entries);
  }
  assertEvidenceSemanticReceipts(boundary.input.supplementary_data);
  assertOpenSemanticCandidateActivations(boundary.input.supplementary_data);
  assertEvidenceFtsReceipts(boundary.input.supplementary_data);
  assertRetrievalFieldSeal(boundary.input.supplementary_data);
  assertRetrievalFieldRefinements(boundary.input.supplementary_data);
  assertQueryFactFrameExtraction(boundary.input.supplementary_data);
  assertQueryFieldAttribution(boundary.input.supplementary_data);
  assertCoverageObjectiveConfig(boundary.input);
  assertCoverageRelevanceUpperBound(boundary.input);
  assertFieldRefinementStopCertificate(boundary);
  assertFinalCandidateIdentity(boundary);
  if (boundary.expected.pre_projection !== undefined) {
    assertPreProjection(
      boundary.expected.pre_projection,
      boundary.expected.candidate_keys
    );
  }
}

function assertCoverageRelevanceUpperBound(
  input: FineAssessmentSelectionBoundaryInput
): void {
  if (input.coverage_relevance_upper_bound === undefined ||
      input.coverage_relevance_upper_bound === null) return;
  try {
    verifyRecallRelevanceUpperBoundReceipt(input.coverage_relevance_upper_bound);
  } catch {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertFieldRefinementStopCertificate(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
  const receipt = boundary.expected.field_refinement_stop_certificate;
  if (receipt === undefined) return;
  try {
    verifyRecallFieldRefinementStopCertificate(receipt);
  } catch {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertCoverageObjectiveConfig(input: FineAssessmentSelectionBoundaryInput): void {
  if (input.coverage_objective_config === undefined) return;
  try {
    verifyCoverageSelectionOperatorConfig(input.coverage_objective_config);
  } catch {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertQueryFieldAttribution(data: SerializedRecallSupplementaryData): void {
  if (data.queryFieldAttribution === undefined) return;
  try {
    verifyRecallQueryFieldAttributionReceipt(data.queryFieldAttribution);
  } catch {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertQueryFactFrameExtraction(
  data: SerializedRecallSupplementaryData
): void {
  if (data.queryFactFrameExtraction === undefined) return;
  try {
    verifyRecallQueryFactFrameExtractionCapture(data.queryFactFrameExtraction);
  } catch {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertRetrievalFieldSeal(data: SerializedRecallSupplementaryData): void {
  if (data.retrievalFieldSeal === undefined) return;
  try {
    verifyRecallFiniteFieldSeal(data.retrievalFieldSeal);
  } catch {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function assertRetrievalFieldRefinements(data: SerializedRecallSupplementaryData): void {
  if (data.retrievalFieldRefinementReceipts === undefined) return;
  try {
    data.retrievalFieldRefinementReceipts.forEach(
      verifyRecallRetrievalFieldRefinementReceipt
    );
  } catch {
    throwSelectionBoundaryFidelityMismatch();
  }
}

function serializedNumberMaps(
  input: FineAssessmentSelectionBoundaryInput
): readonly SelectionBoundaryNumberMap[] {
  return [
    input.token_estimates_by_content,
    input.rank_by_candidate_key,
    ...(input.supplementary_data.evidenceSemanticScoresByCandidateKey === undefined
      ? []
      : [input.supplementary_data.evidenceSemanticScoresByCandidateKey]),
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

function serializedSupplementaryMaps(
  input: FineAssessmentSelectionBoundaryInput
): readonly (readonly (readonly [string, unknown])[])[] {
  return [
    ...(input.supplementary_data.evidenceSemanticActivationsByCandidateKey === undefined
      ? []
      : [input.supplementary_data.evidenceSemanticActivationsByCandidateKey]),
    ...(input.supplementary_data.evidenceSemanticWinnersByCandidateKey === undefined
      ? []
      : [input.supplementary_data.evidenceSemanticWinnersByCandidateKey]),
    ...(input.supplementary_data.openSemanticFactorCandidateActivationsByCandidateKey === undefined
      ? []
      : [input.supplementary_data.openSemanticFactorCandidateActivationsByCandidateKey]),
    ...(input.supplementary_data.routingKeysByOwnerIdentity === undefined
      ? []
      : [input.supplementary_data.routingKeysByOwnerIdentity]),
    ...(input.supplementary_data.keyActivationByOwnerIdentity === undefined
      ? []
      : [input.supplementary_data.keyActivationByOwnerIdentity])
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
  return false;
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

function isUnitNumber(value: unknown): value is number {
  return isNonNegativeFinite(value) && value <= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}
