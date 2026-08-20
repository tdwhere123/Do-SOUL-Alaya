export {
  DEFAULT_QUERY_TIMEOUT_MS,
  EVIDENCE_DOCUMENT_MAX_OPERATOR_ID,
  EMBEDDING_WORKSPACE_SCAN_CAP,
  MAX_QUERY_TIMEOUT_MS,
  MIN_QUERY_TIMEOUT_MS
} from "./constants.js";
export { OpenAIEmbeddingClient } from "./openai-client.js";
export { EmbeddingRecallService } from "./service.js";
export {
  EvidenceDocumentEmbeddingBackfillHandler,
  type EvidenceDocumentEmbeddingBackfillDependencies,
  type EvidenceDocumentEmbeddingBackfillResult
} from "./evidence/evidence-document-embedding-backfill-handler.js";
export type {
  EmbeddingNeighborHit,
  EmbeddingProviderPort,
  EmbeddingQueryWarmupSummary,
  EmbeddingRecallEventLogPort,
  EmbeddingRecallRequestScoreSnapshot,
  EmbeddingRecallRepoPort,
  EmbeddingRecallServiceDependencies,
  EmbeddingRecallSupplementResult,
  EmbeddingSimilarityHint,
  EmbeddingVectorRecord,
  EvidenceCandidateScoringFailureClass,
  EvidenceCandidateScoringResult,
  EvidenceCandidateScoringReceipt,
  EvidenceCandidateScoringStatus,
  EvidenceCandidateScoringWinner,
  EvidenceDocumentEmbeddingRecord,
  EvidenceDocumentEmbeddingRef,
  EvidenceDocumentEmbeddingRepoPort,
  EvidenceDocumentEmbeddingSource,
  EvidenceEmbeddingCandidate,
  EmbeddingWorkspaceNeighborResult,
  EmbeddingWorkspaceScanOptions,
  MaterializeEmbeddingSupplementFromSnapshotParams,
  PrepareRecallEmbeddingSnapshotParams,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingQuerySnapshot,
  PreparedEmbeddingSupplement,
  ScoreEvidenceCandidatesParams
} from "./types.js";
export type {
  EmbeddingRetryEvent,
  OpenAIEmbeddingClientOptions
} from "./openai-client.js";
