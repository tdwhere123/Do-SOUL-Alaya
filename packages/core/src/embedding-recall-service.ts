export {
  DEFAULT_QUERY_TIMEOUT_MS,
  EMBEDDING_WORKSPACE_SCAN_CAP,
  MAX_QUERY_TIMEOUT_MS,
  MIN_QUERY_TIMEOUT_MS
} from "./embedding-recall/constants.js";
export { OpenAIEmbeddingClient } from "./embedding-recall/openai-client.js";
export { EmbeddingRecallService } from "./embedding-recall/service.js";
export type {
  EmbeddingNeighborHit,
  EmbeddingProviderPort,
  EmbeddingQueryWarmupSummary,
  EmbeddingRecallEventLogPort,
  EmbeddingRecallRepoPort,
  EmbeddingRecallServiceDependencies,
  EmbeddingRecallSupplementResult,
  EmbeddingSimilarityHint,
  EmbeddingVectorRecord,
  EmbeddingWorkspaceNeighborResult,
  EmbeddingWorkspaceScanOptions,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingQuerySnapshot,
  PreparedEmbeddingSupplement
} from "./embedding-recall/types.js";
export type {
  EmbeddingRetryEvent,
  OpenAIEmbeddingClientOptions
} from "./embedding-recall/openai-client.js";
