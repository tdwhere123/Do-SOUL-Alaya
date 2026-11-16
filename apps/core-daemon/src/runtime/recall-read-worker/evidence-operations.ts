import type { RecallReadWorkerRequest } from "./protocol.js";
import type { ParsedWorkerOperation } from "./operation-schemas.js";
import { readEvidenceSearchMatches } from "./evidence-search-matches.js";
import { runEvidenceFieldOperation } from "./field-operations.js";
import { runOrderedKeywordSearchBatch } from "./worker-readers.js";
import type { RecallReadWorkerRuntime } from "./runtime.js";

type EvidenceOperation = Extract<RecallReadWorkerRequest["operation"], `evidence.${string}`>;

export async function runEvidenceOperation(
  runtime: RecallReadWorkerRuntime,
  parsed: ParsedWorkerOperation<EvidenceOperation>
) {
  const { evidenceCapsuleRepo } = runtime;
  if (parsed.operation === "evidence.searchByKeyword") {
    const { payload } = parsed;
    return await evidenceCapsuleRepo.searchByKeyword(
      payload.workspaceId,
      payload.queryText,
      payload.limit
    );
  }
  if (parsed.operation === "evidence.searchByKeywordField") {
    return await runEvidenceFieldOperation(evidenceCapsuleRepo, parsed.payload);
  }
  if (parsed.operation === "evidence.searchManyByKeywordField") {
    const { payload } = parsed;
    return await evidenceCapsuleRepo.searchManyByKeywordField(
      payload.workspaceId,
      payload.queries
    );
  }
  if (parsed.operation === "evidence.findSourceAnchorsByIds") {
    const { payload } = parsed;
    return await evidenceCapsuleRepo.findSourceAnchorsByIds(
      payload.workspaceId,
      payload.evidenceObjectIds
    );
  }
  if (parsed.operation === "evidence.findRecallQualifiedByIds") {
    const { payload } = parsed;
    return await evidenceCapsuleRepo.findRecallQualifiedByIds(
      payload.workspaceId,
      readEvidenceSearchMatches(payload.matches)
    );
  }
  if (parsed.operation === "evidence.findRecallQualifiedFactKeysByIds") {
    const { payload } = parsed;
    return await evidenceCapsuleRepo.findRecallQualifiedFactKeysByIds(
      payload.workspaceId,
      payload.evidenceObjectIds
    );
  }
  const { payload } = parsed;
  return await evidenceCapsuleRepo.findByIds(payload.workspaceId, payload.evidenceObjectIds);
}
