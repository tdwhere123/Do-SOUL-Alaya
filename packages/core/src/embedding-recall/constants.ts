import { getCoreConfig } from "../config/install-core-config.js";

export const DEFAULT_QUERY_TIMEOUT_MS = 2500;
export const MAX_QUERY_TIMEOUT_MS = 5000;
export const MIN_QUERY_TIMEOUT_MS = 50;
export const DEFAULT_QUERY_EMBEDDING_CACHE_SIZE = 512;
export const MAX_QUERY_EMBEDDING_CACHE_SIZE = 4096;
export const DEFAULT_EMBEDDING_REQUEST_MAX_ATTEMPTS = 5;
export const MAX_EMBEDDING_REQUEST_ATTEMPTS = 5;
export const DEFAULT_EMBEDDING_REQUEST_RETRY_DELAY_MS = 250;
export const MAX_EMBEDDING_REQUEST_RETRY_DELAY_MS = 2_000;
export const MAX_EMBEDDING_REQUEST_TOTAL_BACKOFF_MS = 8_000;
export const MAX_EMBEDDING_REQUEST_TOTAL_WALLCLOCK_MS = 30_000;
export const EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS = 2_000;
export const QUERY_EMBEDDING_WARMUP_BATCH_SIZE = 16;
export const EMBEDDING_WORKSPACE_SCAN_CAP = 5_000;

export function resolveEmbeddingWorkspaceScanCap(): number {
  const configured = getCoreConfig().embedding.workspaceScanCap;
  if (configured !== undefined && configured > 0) {
    return configured;
  }
  return EMBEDDING_WORKSPACE_SCAN_CAP;
}
