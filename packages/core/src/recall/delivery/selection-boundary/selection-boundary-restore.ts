import type {
  FineAssessmentSelectionBoundaryCase,
  FineAssessmentSelectionBoundaryInput,
  FineAssessmentPreProjectionObservation,
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
  SelectionBoundaryFidelityMismatchError,
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
  SelectionBoundaryFidelityMismatchError,
  throwSelectionBoundaryFidelityMismatch
};

export function validateSelectionBoundary(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
  if (boundary.schema_version !== 2) {
    throwSelectionBoundaryFidelityMismatch(
      `expected schema_version=2, actual ${String(boundary.schema_version)}`
    );
  }
  assertSelectionBoundaryJsonValue(boundary);
  if (!/^sha256:[0-9a-f]{64}$/u.test(
    boundary.expected.visible_result_sha256
  )) {
    const digest = boundary.expected.visible_result_sha256;
    throwSelectionBoundaryFidelityMismatch(
      "expected visible_result_sha256 matching sha256:<64 hex>, actual " +
      (typeof digest === "string" ? `chars=${digest.length}` : typeof digest)
    );
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

function requireValidReceipt(detail: string, verify: () => void): void {
  try {
    verify();
  } catch {
    throwSelectionBoundaryFidelityMismatch(detail);
  }
}

function assertCoverageRelevanceUpperBound(
  input: FineAssessmentSelectionBoundaryInput
): void {
  const receipt = input.coverage_relevance_upper_bound;
  if (receipt === undefined || receipt === null) return;
  requireValidReceipt(
    "expected valid coverage_relevance_upper_bound receipt, actual invalid",
    () => verifyRecallRelevanceUpperBoundReceipt(receipt)
  );
}

function assertFieldRefinementStopCertificate(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
  const receipt = boundary.expected.field_refinement_stop_certificate;
  if (receipt === undefined) return;
  requireValidReceipt(
    "expected valid field_refinement_stop_certificate, actual invalid",
    () => verifyRecallFieldRefinementStopCertificate(receipt)
  );
}

function assertCoverageObjectiveConfig(input: FineAssessmentSelectionBoundaryInput): void {
  const config = input.coverage_objective_config;
  if (config === undefined) return;
  requireValidReceipt(
    "expected valid coverage_objective_config, actual invalid",
    () => verifyCoverageSelectionOperatorConfig(config)
  );
}

function assertQueryFieldAttribution(data: SerializedRecallSupplementaryData): void {
  const receipt = data.queryFieldAttribution;
  if (receipt === undefined) return;
  requireValidReceipt(
    "expected valid queryFieldAttribution receipt, actual invalid",
    () => verifyRecallQueryFieldAttributionReceipt(receipt)
  );
}

function assertQueryFactFrameExtraction(
  data: SerializedRecallSupplementaryData
): void {
  const capture = data.queryFactFrameExtraction;
  if (capture === undefined) return;
  requireValidReceipt(
    "expected valid queryFactFrameExtraction capture, actual invalid",
    () => verifyRecallQueryFactFrameExtractionCapture(capture)
  );
}

function assertRetrievalFieldSeal(data: SerializedRecallSupplementaryData): void {
  const seal = data.retrievalFieldSeal;
  if (seal === undefined) return;
  requireValidReceipt(
    "expected valid retrievalFieldSeal, actual invalid",
    () => verifyRecallFiniteFieldSeal(seal)
  );
}

function assertRetrievalFieldRefinements(data: SerializedRecallSupplementaryData): void {
  const receipts = data.retrievalFieldRefinementReceipts;
  if (receipts === undefined) return;
  requireValidReceipt(
    "expected valid retrievalFieldRefinementReceipts, actual invalid",
    () => receipts.forEach(verifyRecallRetrievalFieldRefinementReceipt)
  );
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
  const emptyOrNonString = keys.filter(
    (key) => typeof key !== "string" || key.length === 0
  ).length;
  const unique = new Set(keys).size;
  if (emptyOrNonString !== 0 || unique !== keys.length) {
    throwSelectionBoundaryFidelityMismatch(
      `expected unique non-empty keys, actual count=${keys.length} ` +
      `unique=${unique} empty_or_nonstring=${emptyOrNonString}`
    );
  }
}

function assertNumberMapEntries(entries: SelectionBoundaryNumberMap): void {
  assertUniqueEntryKeys(entries);
  if (entries.some((entry) => typeof entry[1] !== "number")) {
    throwSelectionBoundaryFidelityMismatch(
      `expected number map values, actual non-number among ${entries.length} entries`
    );
  }
}

function assertUniqueEntryKeys(
  entries: readonly (readonly [string, unknown])[]
): void {
  if (entries.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
    throwSelectionBoundaryFidelityMismatch(
      `expected [key, value] entries, actual malformed among ${entries.length} entries`
    );
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
    throwSelectionBoundaryFidelityMismatch(
      `expected candidate_keys arrays, actual final=${Array.isArray(finalCandidateKeys)} consensus=${Array.isArray(consensusCandidateKeys)}`
    );
  }
  assertUniqueKeys(finalCandidateKeys);
  assertUniqueKeys(consensusCandidateKeys);
  const firstMismatch = finalCandidateKeys.findIndex((key, index) =>
    key !== consensusCandidateKeys[index]
  );
  if (
    finalCandidateKeys.length !== consensusCandidateKeys.length ||
    firstMismatch !== -1
  ) {
    throwSelectionBoundaryFidelityMismatch(
      `expected identical final and consensus candidate_keys, actual lengths ` +
      `${finalCandidateKeys.length}/${consensusCandidateKeys.length} ` +
      `first_mismatch_index=${firstMismatch}`
    );
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
): FineAssessmentPreProjectionObservation {
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
    throwSelectionBoundaryFidelityMismatch(
      "expected pre_projection schema_version=1 with action arrays, actual invalid"
    );
  }
  const parsed = observation as FineAssessmentPreProjectionObservation;
  if (
    parsed.admission_actions.some((action) => !isRecord(action)) ||
    parsed.projection_actions.some((action) => !isRecord(action))
  ) {
    throwSelectionBoundaryFidelityMismatch(
      "expected record admission/projection actions, actual non-record"
    );
  }
  return parsed;
}

function assertAdmissionActions(
  parsed: FineAssessmentPreProjectionObservation
): void {
  let retainedIndex = 0;
  let retainedTokenTotal = 0;
  for (const [index, action] of parsed.admission_actions.entries()) {
    if (
      !Number.isInteger(action.selection_order) ||
      action.selection_order !== index + 1
    ) {
      throwSelectionBoundaryFidelityMismatch(
        `expected admission selection_order=${index + 1}, actual ${String(action.selection_order)}`
      );
    }
    const next = applyAdmissionAction(
      parsed,
      action,
      retainedIndex,
      retainedTokenTotal
    );
    retainedIndex = next.retainedIndex;
    retainedTokenTotal = next.retainedTokenTotal;
  }
  if (
    retainedIndex !== parsed.candidate_keys.length ||
    retainedTokenTotal !== parsed.token_total
  ) {
    throwSelectionBoundaryFidelityMismatch(
      `expected retainedIndex=${parsed.candidate_keys.length} ` +
      `token_total=${parsed.token_total}, actual retainedIndex=${retainedIndex} ` +
      `token_total=${retainedTokenTotal}`
    );
  }
}

function applyAdmissionAction(
  parsed: FineAssessmentPreProjectionObservation,
  action: FineAssessmentPreProjectionObservation["admission_actions"][number],
  retainedIndex: number,
  retainedTokenTotal: number
): { retainedIndex: number; retainedTokenTotal: number } {
  if (action.action === "retain") {
    const nextIndex = retainedIndex + 1;
    if (
      action.dropped_reason !== null ||
      action.pre_projection_rank !== nextIndex ||
      parsed.candidate_keys[nextIndex - 1] !== action.candidate_key
    ) {
      throwSelectionBoundaryFidelityMismatch(
        `expected retain rank=${nextIndex} matching candidate_keys, ` +
        `actual rank=${String(action.pre_projection_rank)}`
      );
    }
    return {
      retainedIndex: nextIndex,
      retainedTokenTotal: assertRetainedWitness(
        action.witness,
        nextIndex - 1,
        retainedTokenTotal
      )
    };
  }
  if (
    action.action !== "exclude" ||
    action.dropped_reason === null ||
    action.pre_projection_rank !== null ||
    !witnessMatchesExclusion(action.witness, action.dropped_reason)
  ) {
    throwSelectionBoundaryFidelityMismatch(
      `expected exclude with dropped_reason witness, actual action=${String(action.action)}`
    );
  }
  return { retainedIndex, retainedTokenTotal };
}

function assertProjectionActions(
  observation: FineAssessmentPreProjectionObservation,
  deliveredCandidateKeys: readonly string[]
): void {
  const expected = completeFineAssessmentPreProjection({
    schema_version: observation.schema_version,
    candidate_keys: observation.candidate_keys,
    token_total: observation.token_total,
    admission_actions: observation.admission_actions
  }, deliveredCandidateKeys);
  const expectedDigest = selectionBoundaryJsonSha256(expected);
  const actualDigest = selectionBoundaryJsonSha256(observation);
  if (expectedDigest !== actualDigest) {
    throwSelectionBoundaryFidelityMismatch(
      `expected pre_projection digest ${expectedDigest}, actual ${actualDigest}`
    );
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
    throwSelectionBoundaryFidelityMismatch(
      `expected retained witness selected_count_before=${selectedCountBefore} ` +
      `token_total_before=${tokenTotalBefore}, actual invalid`
    );
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
