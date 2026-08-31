import {
  MAX_TEMPORAL_RECALL_CANDIDATES,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../../shared/errors.js";
import { parsePageLimit } from "../../../shared/validators.js";
import {
  parseMemoryEntryRow,
  parseStorageTier,
  type MemoryEntryRow
} from "../../mappers/row-mapper.js";
import type { RecallEventTimeWindowQuery } from "../../types.js";
import type { RecallEventTimeWindowStatements } from "../../statements/recall/event-time-window-statements.js";

export function findByEventTimeWindow(
  statements: RecallEventTimeWindowStatements,
  query: RecallEventTimeWindowQuery
): readonly Readonly<MemoryEntry>[] {
  const window = parseEventTimeWindow(query);
  try {
    const rows = statements.findByEventTimeWindowStatement.all(
      query.workspaceId,
      parseStorageTier(query.tier),
      window.endTime,
      window.startTime,
      window.limit
    ) as MemoryEntryRow[];
    return rows.map((row) => parseMemoryEntryRow(row));
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to load event-time recall window for workspace ${query.workspaceId}.`,
      error
    );
  }
}

function parseEventTimeWindow(
  query: RecallEventTimeWindowQuery
): Readonly<{ readonly startTime: string; readonly endTime: string; readonly limit: number }> {
  const startMs = Date.parse(query.startTime);
  const endMs = Date.parse(query.endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new StorageError("VALIDATION_FAILED", "Event-time recall window is invalid.");
  }
  const limit = parsePageLimit(
    query.limit,
    "event-time recall window limit",
    MAX_TEMPORAL_RECALL_CANDIDATES
  );
  if (limit === 0) {
    throw new StorageError("VALIDATION_FAILED", "Event-time recall window limit must be positive.");
  }
  return Object.freeze({
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    limit
  });
}
