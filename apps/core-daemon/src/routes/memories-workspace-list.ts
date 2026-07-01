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

export const MEMORY_SCAN_PAGE_LIMIT = 500;

export async function listWorkspaceMemories(
  memoryService: MemoryService,
  input: WorkspaceMemoryListInput
): Promise<{ readonly memories: readonly MemoryListRow[]; readonly totalCount: number }> {
  if (input.hasConflict === true) {
    return await listWorkspaceMemoriesWithConflict(memoryService, input);
  }

  if (input.scopeClass !== undefined && input.dimension === undefined) {
    const memories = await memoryService.findByScopeClass(
      input.workspaceId,
      input.scopeClass,
      input.pagination
    );
    const totalCount = await countWorkspaceMemoriesByScopeClass(memoryService, input);
    return { memories, totalCount };
  }

  const memories =
    input.dimension === undefined
      ? await memoryService.findByWorkspaceId(input.workspaceId, input.pagination)
      : await memoryService.findByDimension(input.workspaceId, input.dimension, input.pagination);
  const totalCount =
    input.dimension === undefined
      ? await memoryService.countByWorkspaceId(input.workspaceId)
      : await memoryService.countByDimension(input.workspaceId, input.dimension);
  return { memories, totalCount };
}

async function countWorkspaceMemoriesByScopeClass(
  memoryService: MemoryService,
  input: WorkspaceMemoryListInput
): Promise<number> {
  if (input.scopeClass === undefined) {
    return 0;
  }
  let totalCount = 0;
  let scanOffset = 0;
  for (;;) {
    const batch = await memoryService.findByScopeClass(input.workspaceId, input.scopeClass, {
      limit: MEMORY_SCAN_PAGE_LIMIT,
      offset: scanOffset
    });
    if (batch.length === 0) {
      break;
    }
    totalCount += batch.length;
    if (batch.length < MEMORY_SCAN_PAGE_LIMIT) {
      break;
    }
    scanOffset += MEMORY_SCAN_PAGE_LIMIT;
  }
  return totalCount;
}
