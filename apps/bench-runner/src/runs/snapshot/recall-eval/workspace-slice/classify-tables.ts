import { policyForGlobalTable, type GlobalTablePolicy } from "./handled-global.js";

export interface CatalogObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

export interface ColumnInfo {
  readonly name: string;
}

export interface CatalogReader {
  listObjects(): readonly CatalogObject[];
  listColumns(table: string): readonly ColumnInfo[];
}

export type ClassifiedTable =
  | { readonly kind: "workspace"; readonly name: string; readonly columns: readonly string[] }
  | { readonly kind: "fts_virtual"; readonly name: string }
  | { readonly kind: "fts_shadow"; readonly name: string }
  | { readonly kind: "sqlite_internal"; readonly name: string }
  | { readonly kind: "global"; readonly name: string; readonly policy: GlobalTablePolicy };

export interface ClassifiedCatalog {
  readonly workspace: readonly Extract<ClassifiedTable, { kind: "workspace" }>[];
  readonly ftsVirtual: readonly string[];
  readonly global: readonly Extract<ClassifiedTable, { kind: "global" }>[];
}

export function classifyPackedTables(reader: CatalogReader): ClassifiedCatalog {
  const objects = reader.listObjects();
  const tables = objects.filter((object) => object.type === "table");
  const ftsVirtual = tables
    .filter((table) => isFtsVirtual(table.sql))
    .map((table) => table.name);
  const classified = tables.map((table) => classifyTable(table, ftsVirtual, reader));
  return Object.freeze({
    workspace: Object.freeze(
      classified.filter((entry) => entry.kind === "workspace")
    ),
    ftsVirtual: Object.freeze(ftsVirtual),
    global: Object.freeze(classified.filter((entry) => entry.kind === "global"))
  });
}

function classifyTable(
  table: CatalogObject,
  ftsVirtual: readonly string[],
  reader: CatalogReader
): ClassifiedTable {
  if (table.name.startsWith("sqlite_")) {
    return { kind: "sqlite_internal", name: table.name };
  }
  if (isFtsVirtual(table.sql)) {
    return { kind: "fts_virtual", name: table.name };
  }
  if (ftsVirtual.some((fts) => table.name.startsWith(`${fts}_`))) {
    return { kind: "fts_shadow", name: table.name };
  }
  const columns = reader.listColumns(table.name).map((column) => column.name);
  const policy = policyForGlobalTable(table.name);
  if (policy !== undefined) {
    return { kind: "global", name: table.name, policy };
  }
  if (columns.includes("workspace_id")) {
    return { kind: "workspace", name: table.name, columns: Object.freeze(columns) };
  }
  throw new Error(
    `packed working copy has unhandled table ${table.name} without workspace_id`
  );
}

function isFtsVirtual(sql: string | null): boolean {
  if (sql === null) return false;
  return /VIRTUAL TABLE/i.test(sql) && /USING\s+fts5/i.test(sql);
}
