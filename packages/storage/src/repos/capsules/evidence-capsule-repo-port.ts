import type {
  EvidenceCapsule,
  EvidenceFactFrameFormationCapture,
  EvidenceHealthState,
  EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import type {
  EvidenceCapsuleKeywordHit,
  EvidenceKeywordFieldResult,
  EvidenceSearchMatch,
  RecallQualifiedEvidence
} from "./evidence-recall-types.js";

export interface EvidenceSourceAnchor {
  readonly evidence_object_id: string;
  readonly artifact_ref: string;
}

export interface EvidenceCapsuleRepo {
  create(
    capsule: EvidenceCapsule,
    searchProjections?: readonly Readonly<EvidenceSearchProjection>[],
    factFrameFormation?: Readonly<EvidenceFactFrameFormationCapture>
  ): Promise<Readonly<EvidenceCapsule>>;
  deleteById(objectId: string): Promise<void>;
  findById(objectId: string): Promise<Readonly<EvidenceCapsule> | null>;
  findByIds(workspaceId: string, objectIds: readonly string[]): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findRecallQualifiedByIds(
    workspaceId: string,
    matches: readonly EvidenceSearchMatch[]
  ): Promise<readonly RecallQualifiedEvidence[]>;
  findRecallQualifiedFactKeysByIds(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly RecallQualifiedEvidence[]>;
  findSourceAnchorsByIds(
    workspaceId: string,
    evidenceObjectIds: readonly string[]
  ): Promise<readonly EvidenceSourceAnchor[]>;
  findByRunIdPage?(
    runId: string,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByRunId(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByRunIdAll?(runId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceIdPage?(
    workspaceId: string,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByWorkspaceIdAll?(workspaceId: string): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealthPage?(
    health: EvidenceHealthState,
    page: EvidenceCapsuleListPageOptions
  ): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealth(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]>;
  findByHealthAll?(health: EvidenceHealthState): Promise<readonly Readonly<EvidenceCapsule>[]>;
  updateHealth(
    objectId: string,
    health: EvidenceHealthState,
    updatedAt: string
  ): Promise<Readonly<EvidenceCapsule>>;
  // see also: memory_content_fts -- parallel raw FTS surface
  searchByKeyword?(
    workspaceId: string,
    query: string,
    limit: number
  ): Promise<readonly EvidenceCapsuleKeywordHit[]>;
  searchByKeywordField?(
    workspaceId: string,
    query: string,
    limit: number,
    refinementDepths?: readonly number[]
  ): Promise<Readonly<EvidenceKeywordFieldResult>>;
  searchManyByKeywordField?(
    workspaceId: string,
    queries: readonly Readonly<{
      readonly queryText: string;
      readonly limit: number;
      readonly refinement_depths?: readonly number[];
    }>[]
  ): Promise<readonly Readonly<EvidenceKeywordFieldResult>[]>;
}

export interface EvidenceCapsuleListPageOptions {
  readonly limit: number;
  readonly offset: number;
}
