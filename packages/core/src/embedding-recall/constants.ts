export const DEFAULT_QUERY_TIMEOUT_MS = 2500;
export const MAX_QUERY_TIMEOUT_MS = 5000;
export const MIN_QUERY_TIMEOUT_MS = 50;
export const DEFAULT_QUERY_EMBEDDING_CACHE_SIZE = 512;
export const MAX_QUERY_EMBEDDING_CACHE_SIZE = 4096;
export const DEFAULT_EMBEDDING_REQUEST_MAX_ATTEMPTS = 5;
export const MAX_EMBEDDING_REQUEST_ATTEMPTS = 5;
// invariant: retryDelayMs is the EXPONENTIAL BACKOFF BASE, not a constant delay.
// gap before retry N = base * 2^(N-1), clamped to
// MAX_EMBEDDING_REQUEST_RETRY_DELAY_MS, plus random jitter in [0, base) so
// concurrent embed calls do not retry a struggling provider in lockstep.
export const DEFAULT_EMBEDDING_REQUEST_RETRY_DELAY_MS = 250;
// invariant: per-gap cap; with base 250ms gaps are 250 / 500 / 1000 / 2000 (+jitter).
export const MAX_EMBEDDING_REQUEST_RETRY_DELAY_MS = 2_000;
// invariant: sum(backoff gaps) per embedTexts call <= this value.
// see also: packages/core/src/embedding-recall/openai-client.ts:computeEmbeddingBackoffMs
// see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.fetchEmbeddingWithRetry
export const MAX_EMBEDDING_REQUEST_TOTAL_BACKOFF_MS = 8_000;
// invariant: hard wall-clock ceiling on the whole fetchEmbeddingWithRetry loop
// (transport time across attempts + backoff gaps combined). A new attempt is NOT
// started once elapsed >= this ceiling; the last error surfaces instead. Caps
// the per-call worst case so a stalling provider degrades to keyword recall in
// bounded time rather than over minutes (per-attempt timeout x attempts could
// otherwise compound, and the backfill handler wraps this in its own item-level
// retry on top).
// see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.fetchEmbeddingWithRetry
// see also: packages/core/src/embedding-recall/embedding-backfill-handler.ts:EmbeddingBackfillHandler
export const MAX_EMBEDDING_REQUEST_TOTAL_WALLCLOCK_MS = 30_000;
// invariant: the wall-clock transport backstop is a safety net that is STRICTLY
// LATER than the request-level AbortController deadline (options.timeoutMs), so
// the abort stays the primary mechanism that frees the socket. The backstop only
// fires when undici does NOT honor the abort on a stalled/half-open connection
// (the abort cannot reliably terminate every undici stall phase on Node 24), in
// which case the fetch promise would otherwise never settle and hang the whole
// embedding-backfill pipeline. The backstop rejection flows through the SAME
// catch as a real fetch rejection, so it surfaces as the existing
// "Embedding request transport failed for host ..." error and the caller's
// retry/split + swallow path degrade to keyword recall instead of hanging.
// see also: packages/core/src/embedding-recall/embedding-backfill-handler.ts:EmbeddingBackfillHandler.embedBatchWithFallback
export const EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS = 2_000;
export const QUERY_EMBEDDING_WARMUP_BATCH_SIZE = 16;
// Hard cap on the workspace neighbor scan. The recall path drives this every
// query; without a cap the cost grows linearly with HOT memory count. Tuned
// large enough that benches keep deterministic coverage and small enough that
// the per-recall O(scan) cost stays bounded.
export const EMBEDDING_WORKSPACE_SCAN_CAP = 5_000;
