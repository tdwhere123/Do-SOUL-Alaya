import { StorageError } from "../../shared/errors.js";
import {
  enforceEventLogAllHardCap,
  parseEventLogEntryRow,
  type EventLogRow
} from "./event-log-rows.js";
import type { EventLogEntry } from "@do-soul/alaya-protocol";

export function queryBoundedAll(
  loadRows: () => EventLogRow[],
  scopeKind: "entity" | "run" | "workspace",
  scopeId: string
): readonly EventLogEntry[] {
  const rows = loadRows();
  return enforceEventLogAllHardCap(rows, scopeKind, scopeId).map((row) => parseEventLogEntryRow(row));
}

export function wrapBoundedQueryError(
  scopeKind: "entity" | "run" | "workspace",
  error: unknown
): never {
  if (error instanceof StorageError) {
    throw error;
  }
  throw new StorageError("QUERY_FAILED", `Failed to query full event log by ${scopeKind}.`, error);
}
