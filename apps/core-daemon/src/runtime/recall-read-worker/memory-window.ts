import { StorageTierSchema, type StorageTier } from "@do-soul/alaya-protocol";
import type { SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";

const MEMORY_ENTRY_PAGE_LIMIT = 500;

export async function findMemoryEntriesByWorkspaceId(
  memoryEntryRepo: SqliteMemoryEntryRepo,
  workspaceId: string,
  tier: StorageTier | undefined,
  page: { readonly limit: number; readonly offset: number } | undefined
) {
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

export function readRecallTierWindowQuery(payload: Record<string, unknown>) {
  const cursor = payload.cursor === undefined
    ? undefined
    : readRecallTierWindowCursor(payload.cursor);
  return {
    workspaceId: readString(payload.workspaceId, "workspaceId"),
    tier: StorageTierSchema.parse(payload.tier),
    limit: readNumber(payload.limit, "limit"),
    ...(cursor === undefined ? {} : { cursor })
  };
}

function readRecallTierWindowCursor(value: unknown) {
  const cursor = asPayload(value);
  return {
    created_at: readString(cursor.created_at, "cursor.created_at"),
    object_id: readString(cursor.object_id, "cursor.object_id")
  };
}

function asPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("worker payload must be an object");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`worker payload ${name} must be a string`);
  }
  return value;
}

function readNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`worker payload ${name} must be a finite number`);
  }
  return value;
}
