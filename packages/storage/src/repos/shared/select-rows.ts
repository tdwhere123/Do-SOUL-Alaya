import type BetterSqlite3 from "better-sqlite3";
import { parseRows, type RowParser } from "./parse-row.js";

type SqliteConnection = InstanceType<typeof BetterSqlite3>;

export function selectRows<T>(
  database: SqliteConnection,
  sql: string,
  args: readonly unknown[] | Record<string, unknown>,
  parser: RowParser<T>,
  label: string
): readonly T[] {
  const statement = database.prepare(sql);
  const values = Array.isArray(args) ? statement.all(...args) : statement.all(args);
  return parseRows(values, parser, label);
}
