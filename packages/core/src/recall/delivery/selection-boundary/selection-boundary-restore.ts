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
import { assertPreProjection } from "./pre-projection/validation.js";
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
  assertSelectionBoundaryEnvelope(boundary);
  assertSelectionBoundaryInputs(boundary);
  assertSelectionBoundaryReceipts(boundary);
  assertFinalCandidateIdentity(boundary);
  assertPreProjection(
    boundary.expected.pre_projection,
    boundary.expected.candidate_keys
  );
}

function assertSelectionBoundaryEnvelope(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
  const schemaVersion = (boundary as Readonly<{ schema_version: unknown }>)
    .schema_version;
  if (schemaVersion === 2) {
    throwSelectionBoundaryFidelityMismatch(
      "legacy selection boundary schema_version=2 is non-authoritative; " +
      "versioned Select_Gamma selection receipt requires schema_version=3"
    );
  }
  if (schemaVersion !== 3) {
    throwSelectionBoundaryFidelityMismatch(
      `expected schema_version=3, actual ${String(schemaVersion)}`
    );
  }
  assertSelectionBoundaryJsonValue(boundary);
  assertCoverageObjective(boundary.expected.coverage_objective);
  if (!/^sha256:[0-9a-f]{64}$/u.test(
    boundary.expected.visible_result_sha256
  )) {
    const digest = boundary.expected.visible_result_sha256;
    throwSelectionBoundaryFidelityMismatch(
      "expected visible_result_sha256 matching sha256:<64 hex>, actual " +
      (typeof digest === "string" ? `chars=${digest.length}` : typeof digest)
    );
  }
}

function assertCoverageObjective(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    throwSelectionBoundaryFidelityMismatch(
      "expected canonical coverage_objective, actual absent"
    );
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.schema_version !== 1 ||
      typeof receipt.operator_id !== "string" ||
      receipt.operator_id.length === 0 ||
      (receipt.mathematical_class !== null &&
        receipt.mathematical_class !== "monotone_submodular") ||
      (receipt.configuration_digest !== null &&
        typeof receipt.configuration_digest !== "string")) {
    throwSelectionBoundaryFidelityMismatch(
      "expected canonical coverage_objective, actual invalid"
    );
  }
}

function assertSelectionBoundaryInputs(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
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
}

function assertSelectionBoundaryReceipts(
  boundary: FineAssessmentSelectionBoundaryCase
): void {
  assertEvidenceSemanticReceipts(boundary.input.supplementary_data);
  assertOpenSemanticCandidateActivations(boundary.input.supplementary_data);
  assertEvidenceFtsReceipts(boundary.input.supplementary_data);
  assertRetrievalFieldSeal(boundary.input.supplementary_data);
  assertRetrievalFieldRefinements(boundary.input.supplementary_data);
  assertQueryFactFrameExtraction(boundary.input.supplementary_data);
  assertQueryFieldAttribution(boundary.input.supplementary_data);
  assertCoverageRelevanceUpperBound(boundary.input);
  assertFieldRefinementStopCertificate(boundary);
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
