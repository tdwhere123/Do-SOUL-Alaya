export const RECALL_READ_WORKER_OPERATIONS = [
  "ready",
  "memory.findByWorkspaceId",
  "memory.findRecallTierWindow",
  "memory.findByEventTimeWindow",
  "memory.findByDimension",
  "memory.findByScopeClass",
  "memory.searchByKeyword",
  "memory.searchByKeywordField",
  "memory.searchByKeywordWithinObjectIds",
  "memory.searchByKeywordWithinTier",
  "memory.searchManyByKeywordWithinObjectIds",
  "memory.searchByAnchorWithinObjectIds",
  "memory.searchByAnchorWithinTier",
  "memory.searchByAnchorField",
  "memory.findByEvidenceRefs",
  "memory.findBoundEvidenceRefs",
  "memory.findByIds",
  "evidence.searchByKeyword",
  "evidence.searchByKeywordField",
  "evidence.searchManyByKeywordField",
  "evidence.findByIds",
  "evidence.findRecallQualifiedByIds",
  "evidence.findRecallQualifiedFactKeysByIds",
  "evidence.findSourceAnchorsByIds",
  "synthesis.searchByKeyword",
  "synthesis.searchByKeywordField",
  "synthesis.searchManyByKeywordField",
  "synthesis.findByIds",
  "path.findByAnchors",
  "path.findByTimeConcernWindowDigests",
  "pathPlasticity.getStrengthByMemoryId",
  "constraints.findActive",
  "snapshot.beginDeferred",
  "snapshot.commit",
  "snapshot.rollback",
  "close"
] as const;

export type RecallReadWorkerOperation = (typeof RECALL_READ_WORKER_OPERATIONS)[number];

const RECALL_READ_WORKER_OPERATION_SET: ReadonlySet<string> = new Set(
  RECALL_READ_WORKER_OPERATIONS
);

export function isRecallReadWorkerOperation(
  value: unknown
): value is RecallReadWorkerOperation {
  return typeof value === "string" && RECALL_READ_WORKER_OPERATION_SET.has(value);
}

export interface RecallReadWorkerRequest {
  readonly id: number;
  readonly operation: RecallReadWorkerOperation;
  readonly payload: unknown;
}

export type RecallReadWorkerResponse =
  | Readonly<{ readonly id: number; readonly ok: true; readonly result: unknown }>
  | Readonly<{
      readonly id: number;
      readonly ok: false;
      readonly error: Readonly<{
        readonly name: string;
        readonly message: string;
        readonly stack?: string;
      }>;
    }>;
