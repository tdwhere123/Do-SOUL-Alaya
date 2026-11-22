import { AlayaError } from "@do-soul/alaya-protocol";
import {
  bindEmbeddingOverlayIfPresent,
  detachEmbeddingOverlay,
  isLexicalDomainTrigger,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createSqliteCatalogReader } from "./catalog-reader.js";
import { classifyPackedTables, type ClassifiedCatalog } from "./classify-tables.js";
import {
  dropTriggers,
  readTriggers,
  restoreTriggers
} from "./dest-schema.js";
import type { GlobalTablePolicy } from "./handled-global.js";
import { quoteIdent, quoteLiteral } from "./names.js";
import { rebuildWorkspaceFts } from "./rebuild-fts.js";

const SLICE_ATTACH_ALIAS = "slice_src";

export function loadSliceIntoOpenDatabase(
  live: StorageDatabase,
  sliceDbPath: string
): void {
  if (live.connection.inTransaction) {
    throw new AlayaError("CONFLICT", "Workspace slice replacement requires a top-level SQLite transaction");
  }
  const catalog = classifyPackedTables(createSqliteCatalogReader(live.connection));
  const triggers = readTriggers(live);
  const foreignKeys = live.connection.pragma("foreign_keys", { simple: true });
  let primaryError: unknown = null;
  let hasPrimaryError = false;
  let attached = false;
  try {
    // TEMP overlay views must not shadow main table DML during slice replace.
    detachEmbeddingOverlay(live.connection);
    live.connection.pragma("foreign_keys = OFF");
    attachSlice(live, sliceDbPath);
    attached = true;
    live.connection.transaction(() => {
      dropTriggers(live, triggers);
      replaceAttachedTables(live, catalog);
      // The lexical rebuild installs its own domain triggers.
      restoreTriggers(live, triggers.filter((trigger) => !isLexicalDomainTrigger(trigger.name)));
    })();
    // Unqualified ANALYZE writes sqlite_stat on every attached schema, including the sealed slice.
    live.connection.exec("ANALYZE main");
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    throw error;
  } finally {
    cleanupSliceLoad(live, attached, foreignKeys, hasPrimaryError, primaryError);
  }
}

function cleanupSliceLoad(
  live: StorageDatabase,
  attached: boolean,
  foreignKeys: unknown,
  hasPrimaryError: boolean,
  primaryError: unknown
): void {
  const cleanupErrors: unknown[] = [];
  const runCleanup = (step: () => void) => {
    try {
      step();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  };
  if (attached) runCleanup(() => detachSlice(live));
  runCleanup(() => live.connection.pragma(foreignKeys === 1 ? "foreign_keys = ON" : "foreign_keys = OFF"));
  runCleanup(() => bindEmbeddingOverlayIfPresent(live.connection, live.filename));
  if (cleanupErrors.length === 0) return;
  const cleanupSummary =
    cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, "Workspace slice cleanup failed");
  if (!hasPrimaryError) {
    throw cleanupSummary;
  }
  if (primaryError instanceof Error && Object.isExtensible(primaryError) && primaryError.cause === undefined) {
    primaryError.cause = cleanupSummary;
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
  for (const table of catalog.workspace) {
    replaceAttachedTable(live, table.name);
  }
  for (const table of catalog.global) {
    applyAttachedGlobalTable(live, table.name, table.policy);
  }
  rebuildWorkspaceFts(live.connection, catalog.ftsVirtual);
}

function applyAttachedGlobalTable(
  live: StorageDatabase,
  table: string,
  policy: GlobalTablePolicy
): void {
  if (policy.action === "schema_ledger") return;
  if (policy.action === "copy_none") {
    live.connection.exec(`DELETE FROM ${quoteIdent(table)}`);
    return;
  }
  if (policy.action === "reset") {
    live.connection.exec(policy.sql);
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
