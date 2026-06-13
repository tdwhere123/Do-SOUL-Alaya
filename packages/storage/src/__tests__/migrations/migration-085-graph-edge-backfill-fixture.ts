import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));
export const MIGRATION_085 = "085-drop-memory-graph-edges.sql";

interface OpenDb {
  readonly db: BetterSqlite3.Database;
}

const openDbs = new Set<BetterSqlite3.Database>();

export function closeOpenMigrationDbs(): void {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
}

function listMigrationFiles(): readonly string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
}

export function applyMigration(db: BetterSqlite3.Database, fileName: string): void {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf8");
  db.transaction(() => {
    db.exec(sql);
  })();
}

// Open a fresh DB and run every migration strictly before 085, mirroring the
// runner's per-file exec-in-transaction. Foreign keys are enabled to match
// production (initDatabase) so the seeded edges must reference real rows.
export function migrateThroughPre085(): OpenDb {
  const db = new BetterSqlite3(":memory:");
  openDbs.add(db);
  db.pragma("foreign_keys = ON");
  for (const fileName of listMigrationFiles()) {
    if (fileName === MIGRATION_085) {
      break;
    }
    applyMigration(db, fileName);
  }
  return { db };
}

export function seedWorkspace(db: BetterSqlite3.Database, workspaceId: string): void {
  db.prepare(
    `INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind,
      default_engine_binding, workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workspaceId,
    "Backfill Workspace",
    `/tmp/${workspaceId}`,
    "local_repo",
    null,
    "active",
    "2026-04-17T00:00:00.000Z",
    null,
    null
  );
}

export function seedMemory(
  db: BetterSqlite3.Database,
  objectId: string,
  workspaceId: string
): void {
  db.prepare(
    `INSERT INTO memory_entries (
      object_id, created_at, updated_at, created_by,
      dimension, source_kind, formation_kind, scope_class, content,
      workspace_id, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    objectId,
    "2026-04-17T00:00:00.000Z",
    "2026-04-17T00:00:00.000Z",
    "system",
    "knowledge",
    "agent",
    "asserted",
    "workspace",
    `content for ${objectId}`,
    workspaceId,
    "run-1"
  );
}

export function seedLegacyEdge(
  db: BetterSqlite3.Database,
  edge: {
    readonly edgeId: string;
    readonly source: string;
    readonly target: string;
    readonly edgeType: string;
    readonly workspaceId: string;
    readonly createdAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO memory_graph_edges (
      edge_id, source_memory_id, target_memory_id, edge_type, workspace_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(edge.edgeId, edge.source, edge.target, edge.edgeType, edge.workspaceId, edge.createdAt);
}

export interface PathRow {
  readonly path_id: string;
  readonly workspace_id: string;
  readonly anchors_json: string;
  readonly constitution_json: string;
  readonly effect_vector_json: string;
  readonly lifecycle_json: string;
  readonly legitimacy_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function readPaths(db: BetterSqlite3.Database): readonly PathRow[] {
  return db
    .prepare(
      `SELECT path_id, workspace_id, anchors_json, constitution_json,
        effect_vector_json, lifecycle_json, legitimacy_json, created_at, updated_at
      FROM path_relations ORDER BY path_id ASC`
    )
    .all() as PathRow[];
}

export function seedExistingPath(
  db: BetterSqlite3.Database,
  input: {
    readonly pathId: string;
    readonly source: string;
    readonly target: string;
    readonly relationKind: string;
    readonly recallBias: number;
  }
): void {
  db.prepare(
    `INSERT INTO path_relations (
      path_id, workspace_id, anchors_json, constitution_json,
      effect_vector_json, plasticity_state_json, lifecycle_json, legitimacy_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.pathId,
    "workspace-1",
    JSON.stringify({
      source_anchor: { kind: "object", object_id: input.source },
      target_anchor: { kind: "object", object_id: input.target }
    }),
    JSON.stringify({ relation_kind: input.relationKind, why_this_relation_exists: ["pre_existing"] }),
    JSON.stringify({
      salience: 0.5,
      recall_bias: input.recallBias,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    }),
    JSON.stringify({
      strength: 0.3,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 0,
      contradiction_events_count: 0
    }),
    JSON.stringify({ status: "active", retirement_rule: "manual" }),
    JSON.stringify({ evidence_basis: ["pre_existing"], governance_class: "attention_only" }),
    "2026-04-17T00:30:00.000Z",
    "2026-04-17T00:30:00.000Z"
  );
}
