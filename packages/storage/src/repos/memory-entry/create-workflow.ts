import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { buildMemoryEntryCreateParams } from "./create-params.js";
import {
  syncMemoryEntryEvidenceRefIndex,
  type MemoryEntryEvidenceRefIndexHost
} from "./evidence-ref-index.js";
import { parseMemoryEntry } from "./row-mapper.js";
import type { SqliteRunStatement } from "./statement-types.js";

export interface MemoryEntryCreateWorkflowHost extends MemoryEntryEvidenceRefIndexHost {
  readonly db: StorageDatabase;
  readonly createStatement: SqliteRunStatement;
  transaction<T>(fn: () => T, options?: { readonly immediate?: boolean }): T;
}

export async function createMemoryEntry(
  this: MemoryEntryCreateWorkflowHost,
  entry: MemoryEntry
): Promise<Readonly<MemoryEntry>> {
  const parsedEntry = parseMemoryEntry(entry);
  this.transaction(() => runCreateStatement(this, parsedEntry), { immediate: true });
  return parsedEntry;
}

export function createMemoryEntryWithinTransaction(
  this: MemoryEntryCreateWorkflowHost,
  entry: MemoryEntry,
  callbacks: {
    readonly beforeCreate?: () => void;
    readonly afterCreate?: () => void;
  }
): Readonly<MemoryEntry> {
  const parsedEntry = parseMemoryEntry(entry);
  this.transaction(() => {
    callbacks.beforeCreate?.();
    runCreateStatement(this, parsedEntry);
    callbacks.afterCreate?.();
  }, { immediate: true });
  return parsedEntry;
}

function runCreateStatement(
  host: MemoryEntryCreateWorkflowHost,
  parsedEntry: Readonly<MemoryEntry>
): void {
  try {
    host.createStatement.run(...buildMemoryEntryCreateParams(parsedEntry));
    syncMemoryEntryEvidenceRefIndex(host, parsedEntry);
  } catch (error) {
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to create memory entry ${parsedEntry.object_id}.`,
      error
    );
  }
}
