import type { RecallReadWorkerRequest } from "./protocol.js";
import { runSynthesisFieldOperation } from "./field-operations.js";
import {
  readNumber,
  readString,
  readStringArray
} from "./payload-readers.js";
import { readKeywordSearchBatchQueries } from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

export async function runSynthesisOperation(
  runtime: RecallReadWorkerRuntime,
  operation: Extract<RecallReadWorkerRequest["operation"], `synthesis.${string}`>,
  payload: Record<string, unknown>
) {
  const { synthesisCapsuleRepo } = runtime;
  if (operation === "synthesis.searchByKeyword") {
    return await synthesisCapsuleRepo.searchByKeyword(
      readString(payload.workspaceId, "workspaceId"),
      readString(payload.queryText, "queryText"),
      readNumber(payload.limit, "limit")
    );
  }
  if (operation === "synthesis.searchByKeywordField") {
    return await runSynthesisFieldOperation(synthesisCapsuleRepo, payload);
  }
  if (operation === "synthesis.searchManyByKeywordField") {
    return await synthesisCapsuleRepo.searchManyByKeywordField(
      readString(payload.workspaceId, "workspaceId"),
      readKeywordSearchBatchQueries(payload.queries)
    );
  }

  return await synthesisCapsuleRepo.findByIds(
    readString(payload.workspaceId, "workspaceId"),
    readStringArray(payload.objectIds, "objectIds")
  );
}
