import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import BetterSqlite3Ctor from "better-sqlite3";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

export function applyBaselineSql(
  database: BetterSqlite3.Database,
  maxVersion = 6
): void {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
  for (const name of files) {
    const version = Number.parseInt(name, 10);
    if (version > maxVersion) break;
    database.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
  }
}

export function openBaselineDatabase(): BetterSqlite3.Database {
  const database = new BetterSqlite3Ctor(":memory:");
  database.pragma("foreign_keys = ON");
  applyBaselineSql(database);
  return database;
}

export function seedWorkspaceRow(
  database: BetterSqlite3.Database,
  workspaceId: string
): void {
  database.prepare(
    `INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind,
      default_engine_binding, workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, 'local_repo', NULL, 'active', '2026-07-04T00:00:00.000Z', NULL, NULL)`
  ).run(workspaceId, workspaceId, `/tmp/${workspaceId}`);
}

export function insertEvidenceCapsule(
  database: BetterSqlite3.Database,
  objectId: string,
  input: {
    readonly gist: string;
    readonly excerpt?: string | null;
    readonly workspaceId?: string;
  }
): void {
  database.prepare(
    `INSERT INTO evidence_capsules (
      object_id, created_at, updated_at, created_by,
      evidence_kind, semantic_anchor, gist, excerpt, run_id, workspace_id
    ) VALUES (?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'test',
      'turn', 'anchor', ?, ?, 'run-1', ?)`
  ).run(objectId, input.gist, input.excerpt ?? null, input.workspaceId ?? "workspace-1");
}

export function insertMemoryEntryRow(
  database: BetterSqlite3.Database,
  objectId: string,
  content: string,
  workspaceId = "workspace-1"
): void {
  database.prepare(
    `INSERT INTO memory_entries (
      object_id, created_at, updated_at, created_by,
      dimension, source_kind, formation_kind, scope_class, content,
      workspace_id, run_id
    ) VALUES (?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'test',
      'fact', 'compiler', 'explicit', 'project', ?, ?, 'run-1')`
  ).run(objectId, content, workspaceId);
}
