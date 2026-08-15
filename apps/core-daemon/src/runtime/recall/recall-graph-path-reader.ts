import {
  getPathAnchorBackingObjectId,
  serializePathAnchorRef,
  type PathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type {
  RecallPathProjectionReadOptions,
  RecallPathReadPorts
} from "./recall-path-readers.js";

export interface RecallGraphExplorePathReader {
  findByAnchors(
    workspaceId: string,
    anchorRefs: readonly PathAnchorRef[]
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByTargetAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByBackingObjectId(
    workspaceId: string,
    objectId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
  findByBackingObjectIds(
    workspaceId: string,
    objectIds: readonly string[]
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export function createRecallGraphExplorePathReader(
  readPorts: RecallPathReadPorts,
  options: RecallPathProjectionReadOptions = {}
): RecallGraphExplorePathReader {
  return Object.freeze({
    findByAnchors: async (workspaceId: string, anchorRefs: readonly PathAnchorRef[]) =>
      await readPorts.pathExpansionPort.findByAnchors(workspaceId, anchorRefs, options),
    findByTargetAnchor: async (workspaceId: string, anchorRef: PathAnchorRef) => {
      const anchorKey = serializePathAnchorRef(anchorRef);
      const paths = await readPorts.pathExpansionPort.findByAnchors(
        workspaceId,
        [anchorRef],
        options
      );
      return paths.filter((path) =>
        serializePathAnchorRef(path.anchors.target_anchor) === anchorKey
      );
    },
    findByBackingObjectId: async (workspaceId: string, objectId: string) =>
      await findPathsByBackingObjectIds(readPorts, workspaceId, new Set([objectId]), options),
    findByBackingObjectIds: async (workspaceId: string, objectIds: readonly string[]) =>
      await findPathsByBackingObjectIds(readPorts, workspaceId, new Set(objectIds), options)
  });
}

async function findPathsByBackingObjectIds(
  readPorts: RecallPathReadPorts,
  workspaceId: string,
  objectIds: ReadonlySet<string>,
  options: RecallPathProjectionReadOptions
): Promise<readonly Readonly<PathRelation>[]> {
  if (objectIds.size === 0) return Object.freeze([]);
  const paths = await readPorts.findActiveByWorkspace(workspaceId, options);
  return paths.filter((path) =>
    objectIds.has(getPathAnchorBackingObjectId(path.anchors.source_anchor)) ||
    objectIds.has(getPathAnchorBackingObjectId(path.anchors.target_anchor))
  );
}
