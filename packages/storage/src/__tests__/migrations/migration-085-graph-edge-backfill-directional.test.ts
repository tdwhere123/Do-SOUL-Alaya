import { afterEach, describe, expect, it } from "vitest";
import { StorageDatabase } from "../../sqlite/db.js";
import { SqlitePathRelationRepo } from "../../repos/path/path-relation-repo.js";
import {
  MIGRATION_085,
  applyMigration,
  closeOpenMigrationDbs,
  migrateThroughPre085,
  readPaths,
  seedExistingPath,
  seedLegacyEdge,
  seedMemory,
  seedWorkspace,
  type PathRow
} from "./migration-085-graph-edge-backfill-fixture.js";

// B2 regression: migration 085 retires memory_graph_edges. An upgraded DB
// (initialized before the path/edge spine cutover) can still hold durable
// legacy edges that were never copied into path_relations; 085 must backfill
// them into the active path plane before dropping the table, or durable graph
// truth is lost on upgrade. This test drives the migration set up to (but not
// including) 085, seeds legacy edges of several edge_types, applies 085, and
// asserts the equivalent active path_relations survive — and that a legacy edge
// already represented as an active path_relation is NOT double-inserted.
// cross-file ref: packages/storage/src/migrations/085-drop-memory-graph-edges.sql

afterEach(() => {
  closeOpenMigrationDbs();
});

describe("migration 085 directional and malformed edge handling", () => {
  it("dedupes reciprocal legacy `recalls` source rows before backfill", () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");
    for (const id of ["mem-low", "mem-high"]) {
      seedMemory(db, id, "workspace-1");
    }

    seedLegacyEdge(db, {
      edgeId: "edge-recalls-low-high",
      source: "mem-low",
      target: "mem-high",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:00:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-recalls-high-low",
      source: "mem-high",
      target: "mem-low",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:01:00.000Z"
    });

    applyMigration(db, MIGRATION_085);

    const paths = readPaths(db);
    const byPathId = new Map(paths.map((row) => [row.path_id, row]));
    expect(byPathId.has("legacy-edge:edge-recalls-low-high")).toBe(true);
    expect(byPathId.has("legacy-edge:edge-recalls-high-low")).toBe(false);

    const pairRows = paths.filter((row) => {
      const anchors = JSON.parse(row.anchors_json);
      const ids = new Set([anchors.source_anchor.object_id, anchors.target_anchor.object_id]);
      return (
        JSON.parse(row.constitution_json).relation_kind === "co_recalled" &&
        ids.has("mem-low") &&
        ids.has("mem-high")
      );
    });
    expect(pairRows).toHaveLength(1);
  });

  it("keeps DIRECTIONAL kinds same-orientation-only: a reverse-oriented active `supports` path does NOT dedup a forward legacy `supports` edge", () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");
    for (const id of ["mem-a", "mem-b"]) {
      seedMemory(db, id, "workspace-1");
    }

    // A directional `supports` path b -> a is a DISTINCT edge from a forward
    // legacy `supports` edge a -> b — reverse is NOT the same semantic edge for
    // directional kinds, so the forward legacy edge must STILL backfill. Only
    // the symmetric recalls tier gets orientation-agnostic dedup.
    db.prepare(
      `INSERT INTO path_relations (
        path_id, workspace_id, anchors_json, constitution_json,
        effect_vector_json, plasticity_state_json, lifecycle_json, legitimacy_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "active-supports-reverse",
      "workspace-1",
      JSON.stringify({
        source_anchor: { kind: "object", object_id: "mem-b" },
        target_anchor: { kind: "object", object_id: "mem-a" }
      }),
      JSON.stringify({ relation_kind: "supports", why_this_relation_exists: ["pre_existing_reverse"] }),
      JSON.stringify({
        salience: 0.5,
        recall_bias: 0.5,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "lens_entry"
      }),
      JSON.stringify({
        strength: 0.5,
        direction_bias: "bidirectional_asymmetric",
        stability_class: "stable",
        support_events_count: 0,
        contradiction_events_count: 0
      }),
      JSON.stringify({ status: "active", retirement_rule: "manual" }),
      JSON.stringify({ evidence_basis: ["pre_existing_reverse"], governance_class: "attention_only" }),
      "2026-04-17T00:30:00.000Z",
      "2026-04-17T00:30:00.000Z"
    );
    seedLegacyEdge(db, {
      edgeId: "edge-supports-forward",
      source: "mem-a",
      target: "mem-b",
      edgeType: "supports",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:00:00.000Z"
    });

    applyMigration(db, MIGRATION_085);

    const paths = readPaths(db);
    const byPathId = new Map(paths.map((row) => [row.path_id, row]));
    // Both the reverse active path AND the forward backfilled edge survive —
    // directional kinds keep same-orientation-only dedup.
    expect(byPathId.has("active-supports-reverse")).toBe(true);
    expect(byPathId.has("legacy-edge:edge-supports-forward")).toBe(true);
  });

  it("skips corrupt / FK-orphaned / malformed legacy rows and still completes the cutover (drops the table)", () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");
    for (const id of ["mem-a", "mem-b"]) {
      seedMemory(db, id, "workspace-1");
    }

    // One VALID legacy edge must migrate. The corrupt rows below would, without
    // the defensive WHERE guards, trip an FK or the recall_bias CASE and roll
    // back the whole 085 transaction — leaving memory_graph_edges undropped and
    // wedging the graph-plane cutover. Seed them under foreign_keys=OFF so the
    // FK-orphaned and malformed-edge_type rows can land in the legacy table.
    seedLegacyEdge(db, {
      edgeId: "edge-valid",
      source: "mem-a",
      target: "mem-b",
      edgeType: "supports",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:00:00.000Z"
    });

    db.pragma("foreign_keys = OFF");
    // FK-orphaned workspace (no such workspace row).
    seedLegacyEdge(db, {
      edgeId: "edge-orphan-workspace",
      source: "mem-a",
      target: "mem-b",
      edgeType: "supports",
      workspaceId: "workspace-missing",
      createdAt: "2026-04-17T01:01:00.000Z"
    });
    // FK-orphaned memory (target memory id does not exist).
    seedLegacyEdge(db, {
      edgeId: "edge-orphan-memory",
      source: "mem-a",
      target: "mem-missing",
      edgeType: "supports",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:02:00.000Z"
    });
    // Memory exists but in a DIFFERENT workspace than the edge claims (the
    // legacy FK never enforced same-workspace; the path plane is workspace
    // scoped, so this row is not safely backfillable).
    seedWorkspace(db, "workspace-2");
    seedMemory(db, "ws2-mem", "workspace-2");
    seedLegacyEdge(db, {
      edgeId: "edge-cross-workspace",
      source: "mem-a",
      target: "ws2-mem",
      edgeType: "supports",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:03:00.000Z"
    });
    // Malformed edge_type outside the migration-017 CHECK set — falls through
    // the recall_bias CASE to NULL and is not a known graph kind. The CHECK is
    // enforced independently of foreign_keys, so simulate an externally-mutated
    // DB by suppressing CHECK enforcement just for this insert.
    db.pragma("ignore_check_constraints = ON");
    db.prepare(
      `INSERT INTO memory_graph_edges (
        edge_id, source_memory_id, target_memory_id, edge_type, workspace_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      "edge-malformed-type",
      "mem-a",
      "mem-b",
      "totally_unknown_kind",
      "workspace-1",
      "2026-04-17T01:04:00.000Z"
    );
    db.pragma("ignore_check_constraints = OFF");
    db.pragma("foreign_keys = ON");

    applyMigration(db, MIGRATION_085);

    // The cutover completed: the legacy table is dropped, the migration did not
    // abort despite the corrupt rows.
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_graph_edges'")
        .get()
    ).toBeUndefined();

    const paths = readPaths(db);
    const byPathId = new Map(paths.map((row) => [row.path_id, row]));
    // The valid edge migrated.
    expect(byPathId.has("legacy-edge:edge-valid")).toBe(true);
    // Every corrupt / orphaned / malformed row was skipped (not inserted).
    for (const skipped of [
      "legacy-edge:edge-orphan-workspace",
      "legacy-edge:edge-orphan-memory",
      "legacy-edge:edge-cross-workspace",
      "legacy-edge:edge-malformed-type"
    ]) {
      expect(byPathId.has(skipped)).toBe(false);
    }
  });

  it("is a safe no-op when there are no legacy edges to backfill", () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");

    applyMigration(db, MIGRATION_085);

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_graph_edges'")
        .get()
    ).toBeUndefined();
    expect(readPaths(db)).toHaveLength(0);
  });
});
