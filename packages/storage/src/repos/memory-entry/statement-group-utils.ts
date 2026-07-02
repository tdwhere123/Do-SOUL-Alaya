import type { StorageDatabase } from "../../sqlite/db.js";
import type {
  SqliteAllStatement,
  SqliteGetStatement,
  SqliteRunStatement
} from "./statement-types.js";

export type SqliteStatement = SqliteRunStatement & SqliteGetStatement & SqliteAllStatement;
export type SqlDefinitionMap<T extends object> = { readonly [K in keyof T]: string };

type StatementMap<T extends object> = { -readonly [K in keyof T]: SqliteStatement };

export function prepareStatementGroup<T extends object>(
  db: StorageDatabase,
  sqlByName: SqlDefinitionMap<T>
): T {
  const statements = {} as StatementMap<T>;
  for (const key of Object.keys(sqlByName) as Array<keyof T>) {
    statements[key] = db.connection.prepare(sqlByName[key]);
  }
  return statements as T;
}
