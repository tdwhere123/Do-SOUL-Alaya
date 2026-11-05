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
        SELECT CASE WHEN tables.type = 'shadow' THEN 'shadow' ELSE objects.type END AS type,
          objects.name, objects.sql
        FROM main.sqlite_master AS objects
        LEFT JOIN pragma_table_list AS tables ON tables.schema = 'main' AND tables.name = objects.name
        ORDER BY objects.type, objects.name
      `).all() as CatalogObject[];
    },
    listColumns(table: string): readonly ColumnInfo[] {
      return connection.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ColumnInfo[];
    }
  };
}
