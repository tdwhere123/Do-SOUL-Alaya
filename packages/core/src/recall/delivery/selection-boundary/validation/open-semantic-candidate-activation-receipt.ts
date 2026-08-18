import { digestRecallFieldIdentity } from
  "../../../field/field-identity.js";
import type { SerializedRecallSupplementaryData } from
  "../selection-boundary-types.js";
import { isRecord } from "../record-guards.js";
import { throwSelectionBoundaryFidelityMismatch } from "./fidelity-error.js";

export function assertOpenSemanticCandidateActivations(
  data: SerializedRecallSupplementaryData
): void {
  const entries = data.openSemanticFactorCandidateActivationsByCandidateKey;
  if (entries === undefined) return;
  for (const [, receipt] of entries) {
    if (!isValidReceipt(receipt)) {
      throwSelectionBoundaryFidelityMismatch(
        "expected valid open_semantic_factor_candidate_activation_v1 receipt, actual invalid"
      );
    }
  }
}

function isValidReceipt(value: unknown): boolean {
  if (!isRecord(value) || value.schema_version !== 1 ||
      value.operator_id !== "open_semantic_factor_candidate_activation_v1" ||
      value.state !== "observed" ||
      typeof value.score !== "number" ||
      !Number.isFinite(value.score) ||
      value.score <= 0 ||
      value.score > 1 ||
      !Array.isArray(value.evidence_ids) ||
      typeof value.solution_count !== "number" ||
      !Number.isSafeInteger(value.solution_count) || value.solution_count <= 0 ||
      typeof value.proposition_match_count !== "number" ||
      !Number.isSafeInteger(value.proposition_match_count) ||
      value.proposition_match_count <= 0 || typeof value.receipt_digest !== "string") {
    return false;
  }
  const evidenceIds = value.evidence_ids;
  if (evidenceIds.length === 0 || evidenceIds.some((id) =>
    typeof id !== "string" || id.length === 0) ||
    evidenceIds.some((id, index) => index > 0 && evidenceIds[index - 1] >= id)) {
    return false;
  }
  const {
    receipt_digest: digest,
    ...body
  } = value;
  return digest === digestRecallFieldIdentity(body);
}

