import type { RecallReadWorkerRequest } from "./protocol.js";
import type { WorkerOperationPayload, WorkerOperationPayloadMap } from "./operation-schemas.js";
import { readEvidenceSearchMatches } from "./evidence-search-matches.js";
import { runEvidenceFieldOperation } from "./field-operations.js";
import { runOrderedKeywordSearchBatch } from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type EvidenceOperation = Extract<RecallReadWorkerRequest["operation"], `evidence.${string}`>;

export async function runEvidenceOperation(
  runtime: RecallReadWorkerRuntime,
  operation: EvidenceOperation,
  payload: WorkerOperationPayloadMap[EvidenceOperation]
) {
  const { evidenceCapsuleRepo } = runtime;
  if (operation === "evidence.searchByKeyword") {
    const keywordPayload = payload as WorkerOperationPayload<"evidence.searchByKeyword">;
    return await evidenceCapsuleRepo.searchByKeyword(
      keywordPayload.workspaceId,
      keywordPayload.queryText,
      keywordPayload.limit
    );
  }
  if (operation === "evidence.searchByKeywordField") {
    return await runEvidenceFieldOperation(
      evidenceCapsuleRepo,
      payload as WorkerOperationPayload<"evidence.searchByKeywordField">
    );
  }
  if (operation === "evidence.searchManyByKeywordField") {
    const batchPayload = payload as WorkerOperationPayload<"evidence.searchManyByKeywordField">;
    return await evidenceCapsuleRepo.searchManyByKeywordField(
      batchPayload.workspaceId,
      batchPayload.queries
    );
  }
  if (operation === "evidence.findSourceAnchorsByIds") {
    const anchorPayload = payload as WorkerOperationPayload<"evidence.findSourceAnchorsByIds">;
    return await evidenceCapsuleRepo.findSourceAnchorsByIds(
      anchorPayload.workspaceId,
      anchorPayload.evidenceObjectIds
    );
  }
  if (operation === "evidence.findRecallQualifiedByIds") {
    const qualifiedPayload = payload as WorkerOperationPayload<"evidence.findRecallQualifiedByIds">;
    return await evidenceCapsuleRepo.findRecallQualifiedByIds(
      qualifiedPayload.workspaceId,
      readEvidenceSearchMatches(qualifiedPayload.matches)
    );
  }
  if (operation === "evidence.findRecallQualifiedFactKeysByIds") {
    const factKeyPayload = payload as WorkerOperationPayload<"evidence.findRecallQualifiedFactKeysByIds">;
    return await evidenceCapsuleRepo.findRecallQualifiedFactKeysByIds(
      factKeyPayload.workspaceId,
      factKeyPayload.evidenceObjectIds
    );
  }
  const idsPayload = payload as WorkerOperationPayload<"evidence.findByIds">;
  return await evidenceCapsuleRepo.findByIds(idsPayload.workspaceId, idsPayload.evidenceObjectIds);
}
