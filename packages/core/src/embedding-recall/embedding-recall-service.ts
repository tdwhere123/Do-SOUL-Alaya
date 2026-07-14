export {
  DEFAULT_QUERY_TIMEOUT_MS,
  EMBEDDING_WORKSPACE_SCAN_CAP,
  MAX_QUERY_TIMEOUT_MS,
  MIN_QUERY_TIMEOUT_MS
} from "./constants.js";
export { OpenAIEmbeddingClient } from "./openai-client.js";
export { EmbeddingRecallService } from "./service.js";
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
  EmbeddingWorkspaceNeighborResult,
  EmbeddingWorkspaceScanOptions,
  MaterializeEmbeddingSupplementFromSnapshotParams,
  PrepareRecallEmbeddingSnapshotParams,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingQuerySnapshot,
  PreparedEmbeddingSupplement
} from "./types.js";
export type {
  EmbeddingRetryEvent,
  OpenAIEmbeddingClientOptions
} from "./openai-client.js";
