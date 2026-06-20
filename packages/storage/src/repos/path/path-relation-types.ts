import type { PathAnchorRef, PathRelation } from "@do-soul/alaya-protocol";

export interface PathRelationRepo {
  create(relation: PathRelation): Readonly<PathRelation>;
  update(
    pathId: string,
    updates: Partial<
      Pick<
        PathRelation,
        "constitution" | "effect_vector" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at"
      >
    >
  ): Readonly<PathRelation>;
  findById(pathId: string): Promise<Readonly<PathRelation> | null>;
  findByWorkspacePage?(
    workspaceId: string,
    page: PathRelationPageOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  findByWorkspaceAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  findByAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTargetAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  findActivePage?(
    workspaceId: string,
    page: PathRelationPageOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
  findActive(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  findActiveAll(workspaceId: string): Promise<readonly Readonly<PathRelation>[]>;
  findDormant(
    workspaceId: string,
    olderThanIso: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  findDormantAll(
    workspaceId: string,
    olderThanIso: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  findDormantPage?(
    workspaceId: string,
    olderThanIso: string,
    page: PathRelationPageOptions
  ): Promise<readonly Readonly<PathRelation>[]>;
  delete(pathId: string): Promise<void>;
}

export interface PathRelationPageOptions {
  readonly limit: number;
  readonly offset: number;
}
