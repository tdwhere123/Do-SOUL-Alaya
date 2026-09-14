import type { RecallReadWorkerRequest } from "./protocol.js";
import type { WorkerOperationPayload, WorkerOperationPayloadMap } from "./operation-schemas.js";
import { runSynthesisFieldOperation } from "./field-operations.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type SynthesisOperation = Extract<RecallReadWorkerRequest["operation"], `synthesis.${string}`>;

export async function runSynthesisOperation(
  runtime: RecallReadWorkerRuntime,
  operation: SynthesisOperation,
  payload: WorkerOperationPayloadMap[SynthesisOperation]
) {
  const { synthesisCapsuleRepo } = runtime;
  if (operation === "synthesis.searchByKeyword") {
    const keywordPayload = payload as WorkerOperationPayload<"synthesis.searchByKeyword">;
    return await synthesisCapsuleRepo.searchByKeyword(
      keywordPayload.workspaceId,
      keywordPayload.queryText,
      keywordPayload.limit
    );
  }
  if (operation === "synthesis.searchByKeywordField") {
    return await runSynthesisFieldOperation(
      synthesisCapsuleRepo,
      payload as WorkerOperationPayload<"synthesis.searchByKeywordField">
    );
  }
  if (operation === "synthesis.searchManyByKeywordField") {
    const batchPayload = payload as WorkerOperationPayload<"synthesis.searchManyByKeywordField">;
    return await synthesisCapsuleRepo.searchManyByKeywordField(
      batchPayload.workspaceId,
      batchPayload.queries
    );
  }
  const idsPayload = payload as WorkerOperationPayload<"synthesis.findByIds">;
  return await synthesisCapsuleRepo.findByIds(idsPayload.workspaceId, idsPayload.objectIds);
}
