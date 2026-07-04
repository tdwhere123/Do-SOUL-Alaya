import type { MemoryService } from "@do-soul/alaya-core";
import type { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { listWorkspaceMemoriesWithConflict } from "./memories-workspace-conflict-list.js";

type MemoryListRow = Awaited<ReturnType<MemoryService["findByWorkspaceId"]>>[number];

export type WorkspaceMemoryListInput = {
  readonly workspaceId: string;
  readonly dimension?: MemoryDimension;
  readonly scopeClass?: ScopeClass;
  readonly hasConflict?: boolean;
  readonly pagination: { readonly limit: number; readonly offset: number };
};

export async function listWorkspaceMemories(
  memoryService: MemoryService,
  input: WorkspaceMemoryListInput
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  if (input.hasConflict === true) {
    return await listWorkspaceMemoriesWithConflict(memoryService, input);
  }

  if (input.scopeClass !== undefined && input.dimension === undefined) {
    const [memories, totalCount] = await resolveListAndCount(
      memoryService.findByScopeClass(input.workspaceId, input.scopeClass, input.pagination),
      memoryService.countByScopeClass(input.workspaceId, input.scopeClass)
    );
    return { memories, totalCount };
  }

  const [memories, totalCount] = input.dimension === undefined
    ? await resolveListAndCount(
        memoryService.findByWorkspaceId(input.workspaceId, input.pagination),
        memoryService.countByWorkspaceId(input.workspaceId)
      )
    : await resolveListAndCount(
        memoryService.findByDimension(input.workspaceId, input.dimension, input.pagination),
        memoryService.countByDimension(input.workspaceId, input.dimension)
      );
  return { memories, totalCount };
}

async function resolveListAndCount<T>(
  listPromise: Promise<readonly T[]>,
  countPromise: Promise<number>
): Promise<readonly [readonly T[], number]> {
  const [listResult, countResult] = await Promise.allSettled([listPromise, countPromise]);
  if (listResult.status === "rejected") {
    throw listResult.reason;
  }
  if (countResult.status === "rejected") {
    throw countResult.reason;
  }
  return [listResult.value, countResult.value] as const;
}
