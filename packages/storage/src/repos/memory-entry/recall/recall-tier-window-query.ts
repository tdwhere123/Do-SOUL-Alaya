import { StorageTier, type MemoryEntry } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import { parseMemoryEntryRow, parseStorageTier, type MemoryEntryRow } from "../row-mapper.js";
import type { RecallTierWindowQuery, RecallTierWindowResult } from "../types.js";
import type { RecallTierWindowStatements } from "./recall-tier-window-statements.js";

const MAX_RECALL_TIER_WINDOW_LIMIT = 102_400;

export function findRecallTierWindow(
  statements: RecallTierWindowStatements,
  query: RecallTierWindowQuery
): Readonly<RecallTierWindowResult> {
  const tier = parseStorageTier(query.tier);
  const limit = parseRecallTierWindowLimit(query.limit);
  const cursor = parseRecallTierWindowCursor(query.cursor);
  try {
    const params = recallTierWindowParams(query.workspaceId, tier, cursor, limit + 1);
    const rows = (tier === StorageTier.HOT
      ? statements.findRecallHotWindowStatement.all(...params.hot)
      : statements.findRecallTierWindowStatement.all(...params.tier)) as MemoryEntryRow[];
    return buildRecallTierWindowResult(rows, limit);
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to load recall tier window for workspace ${query.workspaceId}.`,
      error
    );
  }
}

function buildRecallTierWindowResult(
  rows: readonly MemoryEntryRow[],
  limit: number
): Readonly<RecallTierWindowResult> {
  const truncated = rows.length > limit;
  const memories = rows.slice(0, limit).map((row) => parseMemoryEntryRow(row));
  const last = truncated ? memories.at(-1) : undefined;
  return Object.freeze({
    memories: Object.freeze(memories),
    next_cursor: last === undefined ? null : toRecallTierWindowCursor(last),
    truncated
  });
}

function toRecallTierWindowCursor(memory: Readonly<MemoryEntry>) {
  return Object.freeze({ created_at: memory.created_at, object_id: memory.object_id });
}

function parseRecallTierWindowLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RECALL_TIER_WINDOW_LIMIT) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Recall tier window limit must be between 1 and ${MAX_RECALL_TIER_WINDOW_LIMIT}.`
    );
  }
  return value;
}

function parseRecallTierWindowCursor(
  cursor: RecallTierWindowQuery["cursor"]
): RecallTierWindowQuery["cursor"] | null {
  if (cursor === undefined) return null;
  if (cursor.created_at.length === 0 || cursor.object_id.length === 0) {
    throw new StorageError("VALIDATION_FAILED", "Recall tier window cursor is invalid.");
  }
  return cursor;
}

function recallTierWindowParams(
  workspaceId: string,
  tier: StorageTier,
  cursor: RecallTierWindowQuery["cursor"] | null,
  sqlLimit: number
): Readonly<{ readonly hot: readonly unknown[]; readonly tier: readonly unknown[] }> {
  const after = [
    cursor?.created_at ?? null,
    cursor?.created_at ?? null,
    cursor?.created_at ?? null,
    cursor?.object_id ?? null,
    sqlLimit
  ] as const;
  return Object.freeze({
    hot: [workspaceId, ...after],
    tier: [workspaceId, tier, ...after]
  });
}
