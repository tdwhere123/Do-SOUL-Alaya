import type { CoarseStageResult } from "../runtime/recall-service-runner-coarse.js";
import type { PreparedRecallRequest, RecallExecutionContext, RecallExecutionParams } from "../runtime/recall-service-runner-types.js";

export async function collectPoolEmbeddingRescore(
  context: RecallExecutionContext,
  params: RecallExecutionParams,
  prepared: PreparedRecallRequest,
  coarse: CoarseStageResult
): Promise<Readonly<Record<string, number>>> {
  const service = context.dependencies.embeddingRecallService;
  if (
    prepared.queryText === null ||
    service === undefined ||
    typeof service.scorePoolCandidates !== "function" ||
    prepared.policy.coarse_filter.semantic_supplement.embedding_enabled !== true
  ) {
    return {};
  }
  const objectIds = coarse.combinedCoarseCandidates.map((candidate) => candidate.entry.object_id);
  if (objectIds.length === 0) {
    return {};
  }
  const scores = await service.scorePoolCandidates({
    workspaceId: params.workspaceId,
    runId: params.runId ?? null,
    queryText: prepared.queryText,
    objectIds
  });
  return Object.fromEntries(scores);
}
