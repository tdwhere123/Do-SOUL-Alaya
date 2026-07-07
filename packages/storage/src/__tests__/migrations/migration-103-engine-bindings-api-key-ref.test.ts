import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEngineBindingRepo } from "../../repos/control/engine-binding-repo.js";
import { StorageDatabase } from "../../sqlite/db.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const MIGRATION_103 = "103-engine-bindings-api-key-ref.sql";
const openDbs = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

describe("migration 103 engine_bindings.api_key_ref", () => {
  it("adds api_key_ref and supports ref-only upsert round-trip", async () => {
    const db = migrateThroughPre102();
    seedWorkspace(db, "workspace-1");

    applyMigration(db, MIGRATION_103);

    const columns = db
      .prepare(`PRAGMA table_info(engine_bindings)`)
      .all() as Array<{ readonly name: string }>;
    expect(columns.some((column) => column.name === "api_key_ref")).toBe(true);

    const database = new StorageDatabase(":memory:", db);
    const repo = new SqliteEngineBindingRepo(database);
    const saved = repo.upsert({
      binding_id: "binding-ref-103",
      workspace_id: "workspace-1",
      provider_type: "openai",
      base_url: null,
      api_key: "",
      api_key_ref: "OPENAI_API_KEY",
      model: "gpt-4o-mini",
      config: {},
      enable_tools: true
    });

    expect(saved.api_key_ref).toBe("OPENAI_API_KEY");
    expect(await repo.getById("binding-ref-103")).toEqual(saved);
  });
});

function migrateThroughPre102(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  openDbs.add(db);
  db.pragma("foreign_keys = ON");
  for (const fileName of listMigrationFiles()) {
    if (fileName === MIGRATION_103) {
      break;
    }
    applyMigration(db, fileName);
  }
  return db;
}

function listMigrationFiles(): readonly string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

function applyMigration(db: BetterSqlite3.Database, fileName: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
  db.transaction(() => {
    db.exec(sql);
  })();
}

function seedWorkspace(db: BetterSqlite3.Database, workspaceId: string): void {
  db.prepare(
    `INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind,
      default_engine_binding, workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workspaceId,
    "Migration 103 Workspace",
    `/tmp/${workspaceId}`,
    "local_repo",
    null,
    "active",
    "2026-07-04T00:00:00.000Z",
    null,
    null
  );
}
