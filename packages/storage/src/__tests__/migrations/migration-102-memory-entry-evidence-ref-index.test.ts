import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StorageDatabase } from "../../sqlite/db.js";
import { SqliteMemoryEntryRepo } from "../../repos/memory-entry/index.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
const MIGRATION_102 = "102-memory-entry-evidence-ref-index.sql";
const openDbs = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

describe("migration 102 memory_entry_evidence_refs", () => {
  it("backfills existing memory_entries evidence_refs into the indexed mapping table", async () => {
    const db = migrateThroughPre102();
    seedWorkspace(db, "workspace-1");
    seedMemoryEntry(db, {
      objectId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "workspace-1",
      evidenceRefs: ["ev-1", "ev-2", "ev-1"]
    });
    seedMemoryEntry(db, {
      objectId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "workspace-1",
      evidenceRefs: ["prefix-ev-1-suffix"]
    });

    applyMigration(db, MIGRATION_102);

    const indexedRows = db
      .prepare(
        `SELECT memory_id, evidence_ref
         FROM memory_entry_evidence_refs
         ORDER BY memory_id ASC, evidence_ref ASC`
      )
      .all() as Array<{ readonly memory_id: string; readonly evidence_ref: string }>;
    expect(indexedRows).toEqual([
      { memory_id: "11111111-1111-4111-8111-111111111111", evidence_ref: "ev-1" },
      { memory_id: "11111111-1111-4111-8111-111111111111", evidence_ref: "ev-2" },
      { memory_id: "22222222-2222-4222-8222-222222222222", evidence_ref: "prefix-ev-1-suffix" }
    ]);

    const database = new StorageDatabase(":memory:", db);
    const repo = new SqliteMemoryEntryRepo(database);
    const rows = await repo.findByEvidenceRefs("workspace-1", ["ev-1"]);
    expect(rows.map((row) => row.object_id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});

function migrateThroughPre102(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  openDbs.add(db);
  db.pragma("foreign_keys = ON");
  for (const fileName of listMigrationFiles()) {
    if (fileName === MIGRATION_102) {
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
    "Migration 102 Workspace",
    `/tmp/${workspaceId}`,
    "local_repo",
    null,
    "active",
    "2026-07-04T00:00:00.000Z",
    null,
    null
  );
}

function seedMemoryEntry(
  db: BetterSqlite3.Database,
  input: {
    readonly objectId: string;
    readonly workspaceId: string;
    readonly evidenceRefs: readonly string[];
  }
): void {
  db.prepare(
    `INSERT INTO memory_entries (
      object_id, created_at, updated_at, created_by,
      dimension, source_kind, formation_kind, scope_class, content,
      evidence_refs, workspace_id, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.objectId,
    "2026-07-04T00:00:00.000Z",
    "2026-07-04T00:00:00.000Z",
    "system",
    "fact",
    "compiler",
    "explicit",
    "project",
    `content for ${input.objectId}`,
    JSON.stringify(input.evidenceRefs),
    input.workspaceId,
    "run-1"
  );
}
