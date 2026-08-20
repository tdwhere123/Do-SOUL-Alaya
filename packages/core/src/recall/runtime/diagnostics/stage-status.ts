export type RecallAnswerRerankStatus =
  | "not_requested"
  | "not_applicable"
  | "returned"
  | "failed";

export type RecallAnswerRerankFailureClass =
  | "invalid_score_count"
  | "invalid_score_value"
  | "service_error";

export type RecallEvidenceEmbeddingStatus =
  import("../../../embedding-recall/types.js").EvidenceCandidateScoringStatus;

export type RecallEvidenceEmbeddingFailureClass =
  import("../../../embedding-recall/types.js").EvidenceCandidateScoringFailureClass;

export interface RecallAnswerRerankDiagnostics {
  readonly status: RecallAnswerRerankStatus;
  readonly expected_count: number;
  readonly scored_count: number;
  readonly failure_class: RecallAnswerRerankFailureClass | null;
}
