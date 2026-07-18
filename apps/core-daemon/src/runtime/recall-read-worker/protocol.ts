export type RecallReadWorkerOperation =
  | "ready"
  | "memory.findByWorkspaceId"
  | "memory.findRecallTierWindow"
  | "memory.findByDimension"
  | "memory.findByScopeClass"
  | "memory.searchByKeyword"
  | "memory.searchByKeywordWithinObjectIds"
  | "memory.searchByKeywordWithinTier"
  | "memory.searchManyByKeywordWithinObjectIds"
  | "memory.searchByAnchorWithinObjectIds"
  | "memory.searchByAnchorWithinTier"
  | "memory.findByEvidenceRefs"
  | "memory.findByIds"
  | "evidence.searchByKeyword"
  | "evidence.searchManyByKeyword"
  | "evidence.findByIds"
  | "evidence.findSourceAnchorsByIds"
  | "synthesis.searchByKeyword"
  | "synthesis.findByIds"
  | "path.findByAnchors"
  | "path.findByTimeConcernWindowDigests"
  | "pathPlasticity.getStrengthByMemoryId"
  | "constraints.findActive"
  | "close";

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
