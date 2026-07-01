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
  const memories = await memoryService.findByScopeClassAndDimensionWithConflict(
    workspaceId,
    scopeClass,
    dimension,
    pagination
  );
  const totalCount = await memoryService.countByScopeClassAndDimensionWithConflict(
    workspaceId,
    scopeClass,
    dimension
  );
  return { memories, totalCount };
}

async function listScopeWithConflict(
  memoryService: MemoryService,
  workspaceId: string,
  scopeClass: NonNullable<WorkspaceMemoryListInput["scopeClass"]>,
  pagination: WorkspaceMemoryListInput["pagination"]
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  const memories = await memoryService.findByScopeClassWithConflict(
    workspaceId,
    scopeClass,
    pagination
  );
  const totalCount = await memoryService.countByScopeClassWithConflict(workspaceId, scopeClass);
  return { memories, totalCount };
}

async function listDimensionWithConflict(
  memoryService: MemoryService,
  workspaceId: string,
  dimension: NonNullable<WorkspaceMemoryListInput["dimension"]>,
  pagination: WorkspaceMemoryListInput["pagination"]
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  const memories = await memoryService.findByDimensionWithConflict(workspaceId, dimension, pagination);
  const totalCount = await memoryService.countByDimensionWithConflict(workspaceId, dimension);
  return { memories, totalCount };
}

async function listWorkspaceOnlyWithConflict(
  memoryService: MemoryService,
  workspaceId: string,
  pagination: WorkspaceMemoryListInput["pagination"]
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  const memories = await memoryService.findByWorkspaceIdWithConflict(workspaceId, pagination);
  const totalCount = await memoryService.countByWorkspaceIdWithConflict(workspaceId);
  return { memories, totalCount };
}
