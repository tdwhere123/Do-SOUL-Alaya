import type { RecallReadWorkerRequest } from "./protocol.js";
import { readEvidenceSearchMatches } from "./evidence-search-matches.js";
import { runEvidenceFieldOperation } from "./field-operations.js";
import {
  readNumber,
  readString,
  readStringArray
} from "./payload-readers.js";
import { readKeywordSearchBatchQueries } from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

export async function runEvidenceOperation(
  runtime: RecallReadWorkerRuntime,
  operation: Extract<RecallReadWorkerRequest["operation"], `evidence.${string}`>,
  payload: Record<string, unknown>
) {
  const { evidenceCapsuleRepo } = runtime;
  if (operation === "evidence.searchByKeyword") {
    return await evidenceCapsuleRepo.searchByKeyword(
      readString(payload.workspaceId, "workspaceId"),
      readString(payload.queryText, "queryText"),
      readNumber(payload.limit, "limit")
    );
  }
  if (operation === "evidence.searchByKeywordField") {
    return await runEvidenceFieldOperation(evidenceCapsuleRepo, payload);
  }
  if (operation === "evidence.searchManyByKeywordField") {
    return await evidenceCapsuleRepo.searchManyByKeywordField(
      readString(payload.workspaceId, "workspaceId"),
      readKeywordSearchBatchQueries(payload.queries)
    );
  }

  const workspaceId = readString(payload.workspaceId, "workspaceId");
  if (operation === "evidence.findSourceAnchorsByIds") {
    return await evidenceCapsuleRepo.findSourceAnchorsByIds(
      workspaceId,
      readStringArray(payload.evidenceObjectIds, "evidenceObjectIds")
    );
  }
  if (operation === "evidence.findRecallQualifiedByIds") {
    return await evidenceCapsuleRepo.findRecallQualifiedByIds(
      workspaceId,
      readEvidenceSearchMatches(payload.matches)
    );
  }
  if (operation === "evidence.findRecallQualifiedFactKeysByIds") {
    return await evidenceCapsuleRepo.findRecallQualifiedFactKeysByIds(
      workspaceId,
      readStringArray(payload.evidenceObjectIds, "evidenceObjectIds")
    );
  }
  return await evidenceCapsuleRepo.findByIds(
    workspaceId,
    readStringArray(payload.evidenceObjectIds, "evidenceObjectIds")
  );
}
