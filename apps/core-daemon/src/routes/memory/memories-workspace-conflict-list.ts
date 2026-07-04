import type { MemoryService } from "@do-soul/alaya-core";
import type { WorkspaceMemoryListInput } from "./memories-workspace-list.js";

type MemoryListRow = Awaited<ReturnType<MemoryService["findByWorkspaceId"]>>[number];

export async function listWorkspaceMemoriesWithConflict(
  memoryService: MemoryService,
  input: WorkspaceMemoryListInput
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  const { workspaceId, scopeClass, dimension, pagination } = input;
  if (scopeClass !== undefined && dimension !== undefined) {
    return listScopeAndDimensionWithConflict(memoryService, workspaceId, scopeClass, dimension, pagination);
  }
  if (scopeClass !== undefined) {
    return listScopeWithConflict(memoryService, workspaceId, scopeClass, pagination);
  }
  if (dimension !== undefined) {
    return listDimensionWithConflict(memoryService, workspaceId, dimension, pagination);
  }
  return listWorkspaceOnlyWithConflict(memoryService, workspaceId, pagination);
}

async function listScopeAndDimensionWithConflict(
  memoryService: MemoryService,
  workspaceId: string,
  scopeClass: NonNullable<WorkspaceMemoryListInput["scopeClass"]>,
  dimension: NonNullable<WorkspaceMemoryListInput["dimension"]>,
  pagination: WorkspaceMemoryListInput["pagination"]
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  const [memories, totalCount] = await resolveListAndCount(
    memoryService.findByScopeClassAndDimensionWithConflict(workspaceId, scopeClass, dimension, pagination),
    memoryService.countByScopeClassAndDimensionWithConflict(workspaceId, scopeClass, dimension)
  );
  return { memories, totalCount };
}

async function listScopeWithConflict(
  memoryService: MemoryService,
  workspaceId: string,
  scopeClass: NonNullable<WorkspaceMemoryListInput["scopeClass"]>,
  pagination: WorkspaceMemoryListInput["pagination"]
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  const [memories, totalCount] = await resolveListAndCount(
    memoryService.findByScopeClassWithConflict(workspaceId, scopeClass, pagination),
    memoryService.countByScopeClassWithConflict(workspaceId, scopeClass)
  );
  return { memories, totalCount };
}

async function listDimensionWithConflict(
  memoryService: MemoryService,
  workspaceId: string,
  dimension: NonNullable<WorkspaceMemoryListInput["dimension"]>,
  pagination: WorkspaceMemoryListInput["pagination"]
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  const [memories, totalCount] = await resolveListAndCount(
    memoryService.findByDimensionWithConflict(workspaceId, dimension, pagination),
    memoryService.countByDimensionWithConflict(workspaceId, dimension)
  );
  return { memories, totalCount };
}

async function listWorkspaceOnlyWithConflict(
  memoryService: MemoryService,
  workspaceId: string,
  pagination: WorkspaceMemoryListInput["pagination"]
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  const [memories, totalCount] = await resolveListAndCount(
    memoryService.findByWorkspaceIdWithConflict(workspaceId, pagination),
    memoryService.countByWorkspaceIdWithConflict(workspaceId)
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
