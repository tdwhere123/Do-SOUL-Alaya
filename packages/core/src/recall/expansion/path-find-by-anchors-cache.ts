import type { PathAnchorRef, PathRelation } from "@do-soul/alaya-protocol";
import type {
  RecallServicePathExpansionPort,
  RecallTemporalProjectionReadOptions
} from "../runtime/recall-service-ports.js";

export function memoizePathFindByAnchors(
  port: RecallServicePathExpansionPort | undefined
): RecallServicePathExpansionPort | undefined {
  if (port === undefined) {
    return undefined;
  }
  const cache = new Map<string, Promise<readonly Readonly<PathRelation>[]>>();
  return {
    ...port,
    findByAnchors(
      workspaceId: string,
      anchorRefs: readonly PathAnchorRef[],
      options?: RecallTemporalProjectionReadOptions
    ): Promise<readonly Readonly<PathRelation>[]> {
      const key = pathFindByAnchorsCacheKey(workspaceId, anchorRefs, options);
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const pending = Promise.resolve(port.findByAnchors(workspaceId, anchorRefs, options)).then(
        (paths) => paths,
        (error: unknown) => {
          cache.delete(key);
          throw error;
        }
      );
      cache.set(key, pending);
      return pending;
    }
  };
}

function pathFindByAnchorsCacheKey(
  workspaceId: string,
  anchorRefs: readonly PathAnchorRef[],
  options: RecallTemporalProjectionReadOptions | undefined
): string {
  return [
    workspaceId,
    options?.asOf ?? "",
    ...anchorRefs.map((anchor) => `${anchor.kind}:${anchor.object_id}`)
  ].join("\0");
}
