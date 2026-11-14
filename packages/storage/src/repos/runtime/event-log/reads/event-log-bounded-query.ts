import { StorageError } from "../../../../shared/errors.js";
import type { EventLogAllScopeKind } from "../mappers/event-log-rows.js";

export function wrapBoundedQueryError(
  scopeKind: EventLogAllScopeKind,
  error: unknown
): never {
  if (error instanceof StorageError) {
    throw error;
  }
  throw new StorageError("QUERY_FAILED", `Failed to query full event log by ${scopeKind}.`, error);
}
