import { EvidenceCandidateScoringSelectionReceiptSchema } from
  "../../../../harness/recall/evidence/evidence-scoring-schema.js";
import type { NarrowRecallDiagnostics } from "../diagnostics-types.js";

export function readEvidenceEmbeddingSelectionReceipt(
  value: unknown
): NarrowRecallDiagnostics["evidenceEmbeddingSelectionReceipt"] {
  if (value == null) return null;
  const parsed = EvidenceCandidateScoringSelectionReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readAnswerRerankStatus(
  value: unknown
): NarrowRecallDiagnostics["answerRerankStatus"] {
  return value === "not_requested" || value === "not_applicable" ||
    value === "returned" || value === "failed"
    ? value
    : null;
}

export function readAnswerRerankFailureClass(
  value: unknown
): NarrowRecallDiagnostics["answerRerankFailureClass"] {
  return value === "invalid_score_count" || value === "invalid_score_value" ||
    value === "service_error"
    ? value
    : null;
}

export function readEvidenceEmbeddingStatus(
  value: unknown
): NarrowRecallDiagnostics["evidenceEmbeddingStatus"] {
  return value === "not_requested" || value === "not_applicable" ||
    value === "returned" || value === "failed"
    ? value
    : null;
}

export function readEvidenceEmbeddingFailureClass(
  value: unknown
): NarrowRecallDiagnostics["evidenceEmbeddingFailureClass"] {
  return value === "provider_unavailable" || value === "query_embedding_failed" ||
    value === "candidate_embedding_failed" || value === "service_error"
    ? value
    : null;
}
