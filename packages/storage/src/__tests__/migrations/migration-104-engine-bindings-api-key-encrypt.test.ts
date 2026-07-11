import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setApiKeyCipherKeyMaterialForTests,
  isEncryptedApiKeyAtRest,
  migrateEngineBindingApiKeysToCiphertext
} from "../../repos/shared/api-key-cipher.js";
import { initDatabase } from "../../sqlite/db.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const MIGRATION_104 = "104-engine-bindings-api-key-encrypt.sql";
const openDbs = new Set<BetterSqlite3.Database>();

afterEach(() => {
  __setApiKeyCipherKeyMaterialForTests(null);
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

describe("migration 104 engine_bindings.api_key encryption", () => {
  it("encrypts legacy plaintext api_key rows during upgrade", () => {
    __setApiKeyCipherKeyMaterialForTests("migration-test-machine:migration-test-user:do-soul-alaya:engine-binding-api-key:v1");
    const db = migrateThroughPre103();
    seedWorkspace(db, "workspace-104");
    db.prepare(
      `INSERT INTO engine_bindings (
        binding_id, workspace_id, provider_type, base_url, api_key, model, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "binding-legacy-104",
      "workspace-104",
      "openai",
      null,
      "sk-legacy-plaintext",
      "gpt-4o-mini",
      "{}",
      "2026-07-11T00:00:00.000Z",
      "2026-07-11T00:00:00.000Z"
    );

    applyMigration(db, MIGRATION_104);

    const row = db
      .prepare("SELECT api_key FROM engine_bindings WHERE binding_id = ?")
      .get("binding-legacy-104") as Readonly<{ readonly api_key: string }>;

    expect(row.api_key).not.toContain("sk-legacy-plaintext");
    expect(isEncryptedApiKeyAtRest(row.api_key)).toBe(true);
  });

  it("runs migration 104 through initDatabase on fresh databases", () => {
    __setApiKeyCipherKeyMaterialForTests("init-test-machine:init-test-user:do-soul-alaya:engine-binding-api-key:v1");
    const database = initDatabase({ filename: ":memory:" });
    openDbs.add(database.connection);

    const version = database.connection
      .prepare("SELECT MAX(version) AS max_version FROM schema_version")
      .get() as Readonly<{ readonly max_version: number | null }>;

    expect(version.max_version).toBeGreaterThanOrEqual(104);
  });
});

function migrateThroughPre103(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  openDbs.add(db);
  db.pragma("foreign_keys = ON");
  for (const fileName of listMigrationFiles()) {
    if (fileName === MIGRATION_104) {
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
  const version = Number(/^(\d+)-.+\.sql$/.exec(fileName)?.[1]);
  db.transaction(() => {
    db.exec(sql);
    if (version === 104) {
      migrateEngineBindingApiKeysToCiphertext(db);
    }
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
    "Migration 104 Workspace",
    `/tmp/${workspaceId}`,
    "local_repo",
    null,
    "active",
    "2026-07-04T00:00:00.000Z",
    null,
    null
  );
}
