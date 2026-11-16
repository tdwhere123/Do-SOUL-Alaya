import type {
  KeywordSearchLaneScope,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServiceSynthesisSearchPort
} from "@do-soul/alaya-core";
import type { ParsedWorkerOperation, WorkerOperationPayload } from "./operation-schemas.js";

type FieldMemoryOperation = "memory.searchByKeywordField" | "memory.searchByAnchorField";

type FieldMemoryRepo = Pick<
  RecallServiceMemoryRepoPort,
  "searchByKeywordField" | "searchByAnchorField"
>;

export async function runMemoryFieldOperation(
  repo: FieldMemoryRepo,
  parsed: ParsedWorkerOperation<FieldMemoryOperation>
): Promise<unknown> {
  if (parsed.operation === "memory.searchByKeywordField") {
    const { payload } = parsed;
    if (repo.searchByKeywordField === undefined) {
      throw new Error("memory keyword field is unavailable");
    }
    return await repo.searchByKeywordField(
      payload.workspaceId,
      payload.queryText,
      payload.limit,
      readKeywordLaneScope(payload.scope),
      payload.refinementDepths,
      payload.capture
    );
  }
  const { payload } = parsed;
  if (repo.searchByAnchorField === undefined) {
    throw new Error("memory anchor field is unavailable");
  }
  return await repo.searchByAnchorField(
    payload.workspaceId,
    payload.anchorTokens,
    payload.optionalTokens,
    payload.limit,
    readKeywordLaneScope(payload.scope),
    payload.refinementDepths
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
