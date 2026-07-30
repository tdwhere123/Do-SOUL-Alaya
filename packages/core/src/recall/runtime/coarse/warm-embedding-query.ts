import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../recall-service-runner.js";

const EMBEDDING_QUERY_WARM_TIMEOUT_MS = 2_500;

/** Warm the query-embedding cache while lexical/synthesis coarse work runs. */
export async function warmEmbeddingQuery(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest
): Promise<void> {
  const service = context.dependencies.embeddingRecallService;
  const prepareQueryEmbedding = service?.prepareQueryEmbedding;
  // Snapshot injection reuses the query-embedding cache; legacy prep has its own path.
  if (
    prepared.policy.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    prepared.queryText === null ||
    typeof prepareQueryEmbedding !== "function" ||
    typeof service?.prepareRecallEmbeddingSnapshot !== "function"
  ) {
    return;
  }
  const handle = prepareQueryEmbedding.call(service, {
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText
  });
  if (typeof handle.waitForSnapshot === "function") {
    await handle.waitForSnapshot(EMBEDDING_QUERY_WARM_TIMEOUT_MS);
  }
}
