import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setApiKeyCipherKeyMaterialForTests,
  isEncryptedApiKeyAtRest,
  migrateEngineBindingApiKeysToCiphertext
} from "../../repos/control/api-key-cipher.js";
import { initDatabase } from "../../sqlite/db.js";
import { applyBaselineSql } from "./apply-baseline.js";

const openDbs = new Set<BetterSqlite3.Database>();

afterEach(() => {
  __setApiKeyCipherKeyMaterialForTests(null);
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

describe("engine_bindings.api_key encryption", () => {
  it("encrypts plaintext api_key rows in place", () => {
    __setApiKeyCipherKeyMaterialForTests("migration-test-machine:migration-test-user:do-soul-alaya:engine-binding-api-key:v1");
    const db = new BetterSqlite3(":memory:");
    openDbs.add(db);
    db.pragma("foreign_keys = ON");
    applyBaselineSql(db);
    db.prepare(
      `INSERT INTO workspaces (
        workspace_id, name, root_path, workspace_kind,
        default_engine_binding, workspace_state, created_at, archived_at, default_engine_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "workspace-104",
      "Cipher Workspace",
      "/tmp/workspace-104",
      "local_repo",
      null,
      "active",
      "2026-07-04T00:00:00.000Z",
      null,
      null
    );
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

    migrateEngineBindingApiKeysToCiphertext(db);

    const row = db
      .prepare("SELECT api_key FROM engine_bindings WHERE binding_id = ?")
      .get("binding-legacy-104") as Readonly<{ readonly api_key: string }>;

    expect(row.api_key).not.toContain("sk-legacy-plaintext");
    expect(isEncryptedApiKeyAtRest(row.api_key)).toBe(true);
  });

  it("records the rebuilt baseline through initDatabase", () => {
    __setApiKeyCipherKeyMaterialForTests("init-test-machine:init-test-user:do-soul-alaya:engine-binding-api-key:v1");
    const database = initDatabase({ filename: ":memory:" });
    openDbs.add(database.connection);

    const version = database.connection
      .prepare("SELECT MAX(version) AS max_version FROM schema_version")
      .get() as Readonly<{ readonly max_version: number | null }>;

    expect(version.max_version).toBe(10);
  });
});
