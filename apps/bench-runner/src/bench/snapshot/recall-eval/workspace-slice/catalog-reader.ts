import { quoteIdent } from "./names.js";
import type { CatalogObject, CatalogReader, ColumnInfo } from "./classify-tables.js";

export interface SqliteCatalogConnection {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

export function createSqliteCatalogReader(connection: SqliteCatalogConnection): CatalogReader {
  return {
    listObjects(): readonly CatalogObject[] {
      return connection.prepare(`
        SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all() as CatalogObject[];
    },
    listColumns(table: string): readonly ColumnInfo[] {
      return connection.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ColumnInfo[];
    }
  };
}
