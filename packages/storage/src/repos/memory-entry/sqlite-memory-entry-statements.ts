import type { StorageDatabase } from "../../sqlite/db.js";
import {
  prepareMemoryEntryGarbageCollectionStatements,
  type MemoryEntryGarbageCollectionStatements
} from "./memory-entry-garbage-collection-statements.js";
import {
  prepareMemoryEntryCreateStatements,
  prepareMemoryEntryLifecycleStatements,
  prepareMemoryEntryReadStatements,
  prepareMemoryEntrySearchStatements,
  prepareMemoryEntryUpdateStatements,
  type MemoryEntryCreateStatements,
  type MemoryEntryLifecycleStatements,
  type MemoryEntryReadStatements,
  type MemoryEntrySearchStatements,
  type MemoryEntryUpdateStatements
} from "./memory-entry-statement-groups.js";

export interface MemoryEntryStatements
  extends MemoryEntryCreateStatements,
    MemoryEntryReadStatements,
    MemoryEntryUpdateStatements,
    MemoryEntrySearchStatements,
    MemoryEntryLifecycleStatements,
    MemoryEntryGarbageCollectionStatements {}

export function prepareMemoryEntryStatements(db: StorageDatabase): MemoryEntryStatements {
  return {
    ...prepareMemoryEntryCreateStatements(db),
    ...prepareMemoryEntryReadStatements(db),
    ...prepareMemoryEntryUpdateStatements(db),
    ...prepareMemoryEntrySearchStatements(db),
    ...prepareMemoryEntryLifecycleStatements(db),
    ...prepareMemoryEntryGarbageCollectionStatements(db)
  };
}
