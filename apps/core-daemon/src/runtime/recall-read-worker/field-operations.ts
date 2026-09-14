import type {
  KeywordSearchLaneScope,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServiceSynthesisSearchPort
} from "@do-soul/alaya-core";
import type { RecallReadWorkerOperation } from "./protocol.js";
import type { WorkerOperationPayload, WorkerOperationPayloadMap } from "./operation-schemas.js";

type FieldMemoryOperation = Extract<
  RecallReadWorkerOperation,
  "memory.searchByKeywordField" | "memory.searchByAnchorField"
>;

type FieldMemoryRepo = Pick<
  RecallServiceMemoryRepoPort,
  "searchByKeywordField" | "searchByAnchorField"
>;

export async function runMemoryFieldOperation(
  repo: FieldMemoryRepo,
  operation: FieldMemoryOperation,
  payload: WorkerOperationPayloadMap[FieldMemoryOperation]
): Promise<unknown> {
  if (operation === "memory.searchByKeywordField") {
    const keywordPayload = payload as WorkerOperationPayload<"memory.searchByKeywordField">;
    if (repo.searchByKeywordField === undefined) {
      throw new Error("memory keyword field is unavailable");
    }
    return await repo.searchByKeywordField(
      keywordPayload.workspaceId,
      keywordPayload.queryText,
      keywordPayload.limit,
      readKeywordLaneScope(keywordPayload.scope),
      keywordPayload.refinementDepths,
      keywordPayload.capture
    );
  }
  const anchorPayload = payload as WorkerOperationPayload<"memory.searchByAnchorField">;
  if (repo.searchByAnchorField === undefined) {
    throw new Error("memory anchor field is unavailable");
  }
  return await repo.searchByAnchorField(
    anchorPayload.workspaceId,
    anchorPayload.anchorTokens,
    anchorPayload.optionalTokens,
    anchorPayload.limit,
    readKeywordLaneScope(anchorPayload.scope),
    anchorPayload.refinementDepths
  );
}

export async function runEvidenceFieldOperation(
  repo: Pick<RecallServiceEvidenceSearchPort, "searchByKeywordField">,
  payload: WorkerOperationPayload<"evidence.searchByKeywordField">
): Promise<unknown> {
  if (repo.searchByKeywordField === undefined) {
    throw new Error("evidence keyword field is unavailable");
  }
  return await repo.searchByKeywordField(
    payload.workspaceId,
    payload.queryText,
    payload.limit,
    payload.refinementDepths
  );
}

export async function runSynthesisFieldOperation(
  repo: Pick<RecallServiceSynthesisSearchPort, "searchByKeywordField">,
  payload: WorkerOperationPayload<"synthesis.searchByKeywordField">
): Promise<unknown> {
  if (repo.searchByKeywordField === undefined) {
    throw new Error("synthesis keyword field is unavailable");
  }
  return await repo.searchByKeywordField(
    payload.workspaceId,
    payload.queryText,
    payload.limit,
    payload.refinementDepths
  );
}

function readKeywordLaneScope(
  scope: WorkerOperationPayload<"memory.searchByKeywordField">["scope"]
): Readonly<KeywordSearchLaneScope> | undefined {
  if (scope === undefined) return undefined;
  return Object.freeze({
    ...(scope.objectIds === undefined ? {} : { objectIds: scope.objectIds }),
    ...(scope.tier === undefined ? {} : { tier: scope.tier })
  });
}
