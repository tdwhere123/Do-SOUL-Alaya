import type { StorageTier } from "@do-soul/alaya-protocol";
import type { SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import type { WorkerOperationPayload } from "./operation-schemas.js";
import { MAX_WORKER_PAGE_LIMIT } from "./worker-readers.js";

const MEMORY_ENTRY_PAGE_LIMIT = 500;

export async function findMemoryEntriesByWorkspaceId(
  memoryEntryRepo: SqliteMemoryEntryRepo,
  workspaceId: string,
  tier: StorageTier | undefined,
  page: { readonly limit: number; readonly offset: number } | undefined
) {
  if (page !== undefined) {
    if (!Number.isInteger(page.limit) || page.limit < 0 || page.limit > MAX_WORKER_PAGE_LIMIT) {
      throw new Error(`page.limit must be an integer between 0 and ${MAX_WORKER_PAGE_LIMIT}`);
    }
    if (!Number.isInteger(page.offset) || page.offset < 0) {
      throw new Error("page.offset must be a non-negative integer");
    }
  }
  if (page === undefined || page.limit <= MEMORY_ENTRY_PAGE_LIMIT) {
    return await memoryEntryRepo.findByWorkspaceId(workspaceId, tier, page);
  }

  const rows = [];
  let remaining = page.limit;
  let offset = page.offset;
  while (remaining > 0) {
    const limit = Math.min(remaining, MEMORY_ENTRY_PAGE_LIMIT);
    const chunk = await memoryEntryRepo.findByWorkspaceId(workspaceId, tier, {
      limit,
      offset
    });
    rows.push(...chunk);
    if (chunk.length < limit) break;
    remaining -= chunk.length;
    offset += chunk.length;
  }
  return rows;
}

export function readRecallTierWindowQuery(
  payload: WorkerOperationPayload<"memory.findRecallTierWindow">
) {
  return {
    workspaceId: payload.workspaceId,
    tier: payload.tier,
    limit: payload.limit,
    ...(payload.cursor === undefined ? {} : { cursor: payload.cursor })
  };
}
