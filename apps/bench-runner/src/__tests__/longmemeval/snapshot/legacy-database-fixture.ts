import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATION_FILE = /^(\d+)-.+\.sql$/u;

export function createDatabaseThroughMigration(path: string, maxVersion: number): void {
  const directory = join(process.cwd(), "packages/storage/src/migrations");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const markApplied = database.prepare(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
  );
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    const version = Number(MIGRATION_FILE.exec(file)?.[1]);
    if (!Number.isInteger(version) || version > maxVersion) continue;
    database.exec("BEGIN");
    try {
      database.exec(readFileSync(join(directory, file), "utf8"));
      markApplied.run(version, "2026-07-12T00:00:00.000Z");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.close();
}

export function executeSqlite(path: string, sql: string): void {
  const database = new DatabaseSync(path);
  database.exec(sql);
  database.close();
}
