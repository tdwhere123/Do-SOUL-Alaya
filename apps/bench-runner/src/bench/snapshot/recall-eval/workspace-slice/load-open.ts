import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createSqliteCatalogReader } from "./catalog-reader.js";
import { classifyPackedTables, type ClassifiedCatalog } from "./classify-tables.js";
import {
  dropTriggers,
  readTriggers,
  restoreTriggers
} from "./dest-schema.js";
import { quoteIdent, quoteLiteral } from "./names.js";
import { rebuildWorkspaceFts } from "./rebuild-fts.js";

const SLICE_ATTACH_ALIAS = "slice_src";

export function loadSliceIntoOpenDatabase(
  live: StorageDatabase,
  sliceDbPath: string
): void {
  const catalog = classifyPackedTables(createSqliteCatalogReader(live.connection));
  const triggers = readTriggers(live);
  dropTriggers(live, triggers);
  live.connection.pragma("foreign_keys = OFF");
  let attached = false;
  try {
    attachSlice(live, sliceDbPath);
    attached = true;
    replaceAttachedTables(live, catalog);
    rebuildWorkspaceFts(live.connection, catalog.ftsVirtual);
    live.connection.exec("ANALYZE");
  } finally {
    if (attached) {
      try {
        detachSlice(live);
      } catch {
        // Keep FK/trigger restore even if DETACH fails.
      }
    }
    live.connection.pragma("foreign_keys = ON");
    restoreTriggers(live, triggers);
  }
}

function attachSlice(live: StorageDatabase, sliceDbPath: string): void {
  live.connection.exec(
    `ATTACH DATABASE ${quoteLiteral(sliceDbPath)} AS ${quoteIdent(SLICE_ATTACH_ALIAS)}`
  );
}

function detachSlice(live: StorageDatabase): void {
  live.connection.exec(`DETACH DATABASE ${quoteIdent(SLICE_ATTACH_ALIAS)}`);
}

function replaceAttachedTables(live: StorageDatabase, catalog: ClassifiedCatalog): void {
  live.connection.exec("BEGIN");
  try {
    for (const table of catalog.workspace) {
      replaceAttachedTable(live, table.name);
    }
    for (const table of catalog.global) {
      applyAttachedGlobalTable(live, table.name, table.policy.action);
    }
    live.connection.exec("COMMIT");
  } catch (error) {
    try {
      live.connection.exec("ROLLBACK");
    } catch {
      // live may already be rolled back
    }
    throw error;
  }
}

function applyAttachedGlobalTable(
  live: StorageDatabase,
  table: string,
  action: string
): void {
  if (action === "schema_ledger") return;
  if (action === "copy_none") {
    live.connection.exec(`DELETE FROM ${quoteIdent(table)}`);
    return;
  }
  replaceAttachedTable(live, table);
}

function replaceAttachedTable(live: StorageDatabase, table: string): void {
  const ident = quoteIdent(table);
  live.connection.exec(`DELETE FROM ${ident}`);
  live.connection.exec(
    `INSERT INTO ${ident} SELECT * FROM ${quoteIdent(SLICE_ATTACH_ALIAS)}.${ident}`
  );
}
