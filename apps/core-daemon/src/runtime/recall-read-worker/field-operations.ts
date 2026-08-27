import { StorageTierSchema } from "@do-soul/alaya-protocol";
import type {
  KeywordSearchLaneScope,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServiceSynthesisSearchPort
} from "@do-soul/alaya-core";
import type { RecallReadWorkerOperation } from "./protocol.js";
import {
  asPayload,
  readNumber,
  readOptionalKeywordFieldCapture,
  readPositiveIntegerArray,
  readString,
  readStringArray
} from "./payload-readers.js";

type FieldMemoryRepo = Pick<
  RecallServiceMemoryRepoPort,
  "searchByKeywordField" | "searchByAnchorField"
>;

export async function runMemoryFieldOperation(
  repo: FieldMemoryRepo,
  operation: Extract<RecallReadWorkerOperation, `memory.${string}`>,
  payload: Record<string, unknown>
): Promise<unknown> {
  const workspaceId = readString(payload.workspaceId, "workspaceId");
  const limit = readNumber(payload.limit, "limit");
  if (operation === "memory.searchByKeywordField") {
    if (repo.searchByKeywordField === undefined) {
      throw new Error("memory keyword field is unavailable");
    }
    return await repo.searchByKeywordField(
      workspaceId,
      readString(payload.queryText, "queryText"),
      limit,
      readKeywordLaneScope(payload.scope),
      readRefinementDepths(payload.refinementDepths),
      readOptionalKeywordFieldCapture(payload.capture)
    );
  }
  if (operation !== "memory.searchByAnchorField" || repo.searchByAnchorField === undefined) {
    throw new Error("memory anchor field is unavailable");
  }
  return await repo.searchByAnchorField(
    workspaceId,
    readStringArray(payload.anchorTokens, "anchorTokens"),
    readStringArray(payload.optionalTokens, "optionalTokens"),
    limit,
    readKeywordLaneScope(payload.scope),
    readRefinementDepths(payload.refinementDepths)
  );
}

export async function runEvidenceFieldOperation(
  repo: Pick<RecallServiceEvidenceSearchPort, "searchByKeywordField">,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (repo.searchByKeywordField === undefined) {
    throw new Error("evidence keyword field is unavailable");
  }
  return await repo.searchByKeywordField(
    readString(payload.workspaceId, "workspaceId"),
    readString(payload.queryText, "queryText"),
    readNumber(payload.limit, "limit"),
    readRefinementDepths(payload.refinementDepths)
  );
}

export async function runSynthesisFieldOperation(
  repo: Pick<RecallServiceSynthesisSearchPort, "searchByKeywordField">,
  payload: Record<string, unknown>
): Promise<unknown> {
  if (repo.searchByKeywordField === undefined) {
    throw new Error("synthesis keyword field is unavailable");
  }
  return await repo.searchByKeywordField(
    readString(payload.workspaceId, "workspaceId"),
    readString(payload.queryText, "queryText"),
    readNumber(payload.limit, "limit"),
    readRefinementDepths(payload.refinementDepths)
  );
}

function readKeywordLaneScope(value: unknown): Readonly<KeywordSearchLaneScope> {
  if (value === undefined) return Object.freeze({});
  const scope = asPayload(value);
  return Object.freeze({
    ...(scope.objectIds === undefined
      ? {}
      : { objectIds: readStringArray(scope.objectIds, "scope.objectIds") }),
    ...(scope.tier === undefined
      ? {}
      : { tier: StorageTierSchema.parse(scope.tier) })
  });
}

function readRefinementDepths(value: unknown): readonly number[] {
  if (value === undefined) return Object.freeze([]);
  return readPositiveIntegerArray(value, "refinementDepths");
}
