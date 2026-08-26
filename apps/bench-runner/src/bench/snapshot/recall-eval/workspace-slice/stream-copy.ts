import { quoteIdent } from "./names.js";
import type { ClassifiedCatalog } from "./classify-tables.js";
import type { GlobalTablePolicy } from "./handled-global.js";

export interface CopyConnection {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    iterate(...params: unknown[]): IterableIterator<unknown>;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

export function copyWorkspaceTablesOnce(input: {
  readonly packed: CopyConnection;
  readonly destByWorkspace: ReadonlyMap<string, CopyConnection>;
  readonly catalog: ClassifiedCatalog;
}): void {
  for (const table of input.catalog.workspace) {
    copyOneWorkspaceTable(input.packed, input.destByWorkspace, table.name, table.columns);
  }
}

export function applyGlobalTablePolicies(input: {
  readonly packed: CopyConnection;
  readonly destByWorkspace: ReadonlyMap<string, CopyConnection>;
  readonly catalog: ClassifiedCatalog;
}): void {
  for (const table of input.catalog.global) {
    applyOneGlobalPolicy(input.packed, input.destByWorkspace, table.name, table.policy);
  }
}

function copyOneWorkspaceTable(
  packed: CopyConnection,
  destByWorkspace: ReadonlyMap<string, CopyConnection>,
  table: string,
  columns: readonly string[]
): void {
  const inserts = prepareInserts(destByWorkspace, table, columns);
  streamPackedRows(packed, table, columns, (row) => {
    const workspaceId = row.workspace_id;
    if (typeof workspaceId !== "string") return;
    inserts.get(workspaceId)?.run(...columns.map((column) => row[column]));
  });
}

function applyOneGlobalPolicy(
  packed: CopyConnection,
  destByWorkspace: ReadonlyMap<string, CopyConnection>,
  table: string,
  policy: GlobalTablePolicy
): void {
  if (policy.action === "schema_ledger") {
    for (const dest of destByWorkspace.values()) {
      assertSchemaLedgerMatches(packed, dest, table);
    }
    return;
  }
  if (policy.action === "copy_none") return;
  const columns = listColumns(packed, table);
  if (policy.action === "copy_all") {
    copyAllGlobalRows(packed, destByWorkspace, table, columns);
    return;
  }
  copyGlobalRowsViaFk(packed, destByWorkspace, table, columns, policy);
}

function copyAllGlobalRows(
  packed: CopyConnection,
  destByWorkspace: ReadonlyMap<string, CopyConnection>,
  table: string,
  columns: readonly string[]
): void {
  const inserts = prepareInserts(destByWorkspace, table, columns);
  for (const dest of destByWorkspace.values()) {
    dest.exec(`DELETE FROM ${quoteIdent(table)}`);
  }
  streamPackedRows(packed, table, columns, (row) => {
    const values = columns.map((column) => row[column]);
    for (const insert of inserts.values()) insert.run(...values);
  });
}

function copyGlobalRowsViaFk(
  packed: CopyConnection,
  destByWorkspace: ReadonlyMap<string, CopyConnection>,
  table: string,
  columns: readonly string[],
  policy: Extract<GlobalTablePolicy, { action: "copy_via_fk" }>
): void {
  const inserts = prepareInserts(destByWorkspace, table, columns);
  const parents = new Map<string, Set<unknown>>();
  for (const [workspaceId, dest] of destByWorkspace) {
    parents.set(workspaceId, readParentKeys(dest, policy.parentTable, policy.parentKey));
  }
  streamPackedRows(packed, table, columns, (row) => {
    const key = row[policy.childKey];
    const values = columns.map((column) => row[column]);
    for (const [workspaceId, insert] of inserts) {
      if (parents.get(workspaceId)?.has(key) === true) insert.run(...values);
    }
  });
}

function prepareInserts(
  destByWorkspace: ReadonlyMap<string, CopyConnection>,
  table: string,
  columns: readonly string[]
): Map<string, ReturnType<CopyConnection["prepare"]>> {
  const quoted = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const inserts = new Map<string, ReturnType<CopyConnection["prepare"]>>();
  for (const [workspaceId, dest] of destByWorkspace) {
    inserts.set(
      workspaceId,
      dest.prepare(
        `INSERT INTO ${quoteIdent(table)} (${quoted}) VALUES (${placeholders})`
      )
    );
  }
  return inserts;
}

function streamPackedRows(
  packed: CopyConnection,
  table: string,
  columns: readonly string[],
  onRow: (row: Record<string, unknown>) => void
): void {
  const quoted = columns.map(quoteIdent).join(", ");
  for (const row of packed.prepare(`SELECT ${quoted} FROM ${quoteIdent(table)}`).iterate()) {
    onRow(row as Record<string, unknown>);
  }
}

function listColumns(packed: CopyConnection, table: string): readonly string[] {
  const rows = packed.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ReadonlyArray<{
    readonly name: string;
  }>;
  return rows.map((row) => row.name);
}

function readParentKeys(
  dest: CopyConnection,
  parentTable: string,
  parentKey: string
): Set<unknown> {
  const rows = dest.prepare(
    `SELECT ${quoteIdent(parentKey)} AS key FROM ${quoteIdent(parentTable)}`
  ).all() as ReadonlyArray<{ readonly key: unknown }>;
  return new Set(rows.map((row) => row.key));
}

function assertSchemaLedgerMatches(
  packed: CopyConnection,
  dest: CopyConnection,
  table: string
): void {
  const destVersions = dest.prepare(
    `SELECT version FROM ${quoteIdent(table)} ORDER BY version`
  ).all() as ReadonlyArray<{ readonly version: number }>;
  const packedVersions = packed.prepare(
    `SELECT version FROM ${quoteIdent(table)} ORDER BY version`
  ).all() as ReadonlyArray<{ readonly version: number }>;
  if (JSON.stringify(destVersions) !== JSON.stringify(packedVersions)) {
    throw new Error("packed working copy schema_version ledger does not match dest migrations");
  }
}
