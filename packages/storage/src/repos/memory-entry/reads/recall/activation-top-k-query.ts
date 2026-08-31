import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../../shared/errors.js";
import { parseMemoryEntryRow, parseStorageTier, type MemoryEntryRow } from "../../mappers/row-mapper.js";
import type { RecallActivationTopKQuery } from "../../types.js";
import type { RecallActivationTopKStatements } from "../../statements/recall/activation-top-k-statements.js";

export const MAX_RECALL_ACTIVATION_TOP_K = 102_400;

export function findRecallActivationTopK(
  statements: RecallActivationTopKStatements,
  query: RecallActivationTopKQuery
): readonly Readonly<MemoryEntry>[] {
  const tier = parseStorageTier(query.tier);
  const limit = parseActivationTopKLimit(query.limit);
  const minActivation = parseOptionalMinActivation(query.min_activation_score);
  const excludeJson = JSON.stringify(parseExcludeObjectIds(query.exclude_object_ids));
  try {
    const rows = statements.findRecallActivationTopKStatement.all(
      query.workspaceId,
      tier,
      minActivation,
      minActivation,
      excludeJson,
      limit
    ) as MemoryEntryRow[];
    return Object.freeze(rows.map((row) => parseMemoryEntryRow(row)));
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to load recall activation top-K for workspace ${query.workspaceId}.`,
      error
    );
  }
}

function parseActivationTopKLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RECALL_ACTIVATION_TOP_K) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Recall activation top-K limit must be between 1 and ${MAX_RECALL_ACTIVATION_TOP_K}.`
    );
  }
  return value;
}

function parseOptionalMinActivation(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) {
    throw new StorageError("VALIDATION_FAILED", "Recall activation top-K min score is invalid.");
  }
  return Math.round(value * 1e6) / 1e6;
}

function parseExcludeObjectIds(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined || values.length === 0) return Object.freeze([]);
  return Object.freeze([...new Set(values.filter((value) => value.length > 0))]);
}
