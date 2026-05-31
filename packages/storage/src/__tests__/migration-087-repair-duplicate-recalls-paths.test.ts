import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const MIGRATION_087 = "087-repair-duplicate-recalls-paths.sql";

const openDbs = new Set<BetterSqlite3.Database>();

afterEach(() => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs.clear();
});

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

function migrateThroughPre087(): BetterSqlite3.Database {
  const db = new BetterSqlite3(":memory:");
  openDbs.add(db);
  db.pragma("foreign_keys = ON");
  for (const fileName of listMigrationFiles()) {
    if (fileName === MIGRATION_087) {
      break;
    }
    applyMigration(db, fileName);
  }
  return db;
}

function seedWorkspace(db: BetterSqlite3.Database): void {
  db.prepare(
    `INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind,
      default_engine_binding, workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "workspace-1",
    "Repair Workspace",
    "/tmp/workspace-1",
    "local_repo",
    null,
    "active",
    "2026-04-17T00:00:00.000Z",
    null,
    null
  );
}

function seedPath(
  db: BetterSqlite3.Database,
  input: {
    readonly pathId: string;
    readonly source: string;
    readonly target: string;
    readonly relationKind: string;
    readonly recallBias?: number;
    readonly createdAt: string;
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
    JSON.stringify({ relation_kind: input.relationKind, why_this_relation_exists: ["test"] }),
    JSON.stringify({
      salience: 0.5,
      recall_bias: input.recallBias ?? 0.5,
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
    JSON.stringify({ evidence_basis: ["test"], governance_class: "attention_only" }),
    input.createdAt,
    input.createdAt
  );
}

describe("migration 087 duplicate recalls-tier repair", () => {
  it("keeps the oldest active recalls-tier row and makes reciprocal duplicates dormant", () => {
    const db = migrateThroughPre087();
    seedWorkspace(db);

    seedPath(db, {
      pathId: "a-keeper-oldest",
      source: "mem-a",
      target: "mem-b",
      relationKind: "co_recalled",
      createdAt: "2026-04-17T01:00:00.000Z"
    });
    seedPath(db, {
      pathId: "duplicate-reverse",
      source: "mem-b",
      target: "mem-a",
      relationKind: "co_recalled",
      createdAt: "2026-04-17T01:01:00.000Z"
    });
    seedPath(db, {
      pathId: "z-duplicate-same-time-higher-id",
      source: "mem-a",
      target: "mem-b",
      relationKind: "shares_entity",
      createdAt: "2026-04-17T01:00:00.000Z"
    });
    seedPath(db, {
      pathId: "supports-directional",
      source: "mem-b",
      target: "mem-a",
      relationKind: "supports",
      createdAt: "2026-04-17T01:02:00.000Z"
    });

    applyMigration(db, MIGRATION_087);

    const rows = db
      .prepare(
        `SELECT path_id, lifecycle_json
        FROM path_relations
        ORDER BY path_id ASC`
      )
      .all() as ReadonlyArray<{ readonly path_id: string; readonly lifecycle_json: string }>;
    const statusByPathId = new Map(
      rows.map((row) => [row.path_id, JSON.parse(row.lifecycle_json).status ?? "active"])
    );

    expect(statusByPathId.get("a-keeper-oldest")).toBe("active");
    expect(statusByPathId.get("duplicate-reverse")).toBe("dormant");
    expect(statusByPathId.get("z-duplicate-same-time-higher-id")).toBe("dormant");
    expect(statusByPathId.get("supports-directional")).toBe("active");

    const indexes = db
      .prepare(
        `SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_path_relations_source_backing_object_id',
            'idx_path_relations_target_backing_object_id'
          )
        ORDER BY name ASC`
      )
      .all() as ReadonlyArray<{ readonly name: string }>;
    expect(indexes.map((row) => row.name)).toEqual([
      "idx_path_relations_source_backing_object_id",
      "idx_path_relations_target_backing_object_id"
    ]);
  });

  it("does not collapse negative or neutral recalls-tier rows into positive recalls duplicates", () => {
    const db = migrateThroughPre087();
    seedWorkspace(db);

    seedPath(db, {
      pathId: "positive-keeper",
      source: "mem-a",
      target: "mem-b",
      relationKind: "co_recalled",
      recallBias: 0.5,
      createdAt: "2026-04-17T01:00:00.000Z"
    });
    seedPath(db, {
      pathId: "positive-duplicate",
      source: "mem-b",
      target: "mem-a",
      relationKind: "shares_entity",
      recallBias: 0.5,
      createdAt: "2026-04-17T01:01:00.000Z"
    });
    seedPath(db, {
      pathId: "negative-same-pair",
      source: "mem-a",
      target: "mem-b",
      relationKind: "co_recalled",
      recallBias: -0.5,
      createdAt: "2026-04-17T00:30:00.000Z"
    });
    seedPath(db, {
      pathId: "neutral-same-pair",
      source: "mem-b",
      target: "mem-a",
      relationKind: "signal_graph_ref",
      recallBias: 0,
      createdAt: "2026-04-17T00:45:00.000Z"
    });

    applyMigration(db, MIGRATION_087);

    const rows = db
      .prepare(
        `SELECT path_id, lifecycle_json
        FROM path_relations
        ORDER BY path_id ASC`
      )
      .all() as ReadonlyArray<{ readonly path_id: string; readonly lifecycle_json: string }>;
    const statusByPathId = new Map(
      rows.map((row) => [row.path_id, JSON.parse(row.lifecycle_json).status ?? "active"])
    );

    expect(statusByPathId.get("positive-keeper")).toBe("active");
    expect(statusByPathId.get("positive-duplicate")).toBe("dormant");
    expect(statusByPathId.get("negative-same-pair")).toBe("active");
    expect(statusByPathId.get("neutral-same-pair")).toBe("active");
  });
});
