import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { quoteIdent } from "./names.js";

export interface DestTrigger {
  readonly name: string;
  readonly sql: string;
}

export interface PreparedSliceDest {
  readonly workspaceId: string;
  readonly dbPath: string;
  readonly database: StorageDatabase;
  readonly triggers: readonly DestTrigger[];
}

export function createSliceDest(workspaceId: string, dbPath: string): PreparedSliceDest {
  mkdirSync(dirname(dbPath), { recursive: true });
  const database = initDatabase({ filename: dbPath });
  const triggers = readTriggers(database);
  dropTriggers(database, triggers);
  database.connection.pragma("foreign_keys = OFF");
  return { workspaceId, dbPath, database, triggers };
}

export function finalizeSliceDest(dest: PreparedSliceDest): void {
  dest.database.connection.pragma("foreign_keys = ON");
  restoreTriggers(dest.database, dest.triggers);
  dest.database.connection.exec("ANALYZE");
}

export function readTriggers(database: StorageDatabase): readonly DestTrigger[] {
  const rows = database.connection.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND sql IS NOT NULL
  `).all() as ReadonlyArray<{ readonly name: string; readonly sql: string }>;
  return Object.freeze(rows.map((row) => Object.freeze({ name: row.name, sql: row.sql })));
}

export function dropTriggers(database: StorageDatabase, triggers: readonly DestTrigger[]): void {
  for (const trigger of triggers) {
    database.connection.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(trigger.name)}`);
  }
}

export function restoreTriggers(
  database: StorageDatabase,
  triggers: readonly DestTrigger[]
): void {
  for (const trigger of triggers) {
    database.connection.exec(trigger.sql);
  }
}

export function closeSliceDest(dest: PreparedSliceDest): void {
  dest.database.close();
}
