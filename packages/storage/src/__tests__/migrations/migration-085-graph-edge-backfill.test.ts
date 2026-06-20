import { afterEach, describe, expect, it } from "vitest";
import { StorageDatabase } from "../../sqlite/db.js";
import { SqlitePathRelationRepo } from "../../repos/path/path-relation-repo.js";
import {
  MIGRATION_085,
  applyMigration,
  closeOpenMigrationDbs,
  migrateThroughPre085,
  readPaths,
  seedLegacyEdge,
  seedMemory,
  seedWorkspace} from "./migration-085-graph-edge-backfill-fixture.js";

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

describe("migration 085 legacy graph-edge backfill", () => {
  it("backfills surviving legacy edges into active path_relations, dedupes existing, drops the table", async () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");
    seedWorkspace(db, "workspace-2");
    for (const id of ["mem-a", "mem-b", "mem-c", "mem-d", "mem-e", "mem-f", "ws2-x", "ws2-y"]) {
      seedMemory(db, id, id.startsWith("ws2") ? "workspace-2" : "workspace-1");
    }

    // A representative spread including the neutral marker and the full
    // negative family, plus a workspace-2 edge to prove workspace is preserved.
    seedLegacyEdge(db, {
      edgeId: "edge-supports",
      source: "mem-a",
      target: "mem-b",
      edgeType: "supports",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:00:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-recalls",
      source: "mem-a",
      target: "mem-c",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:01:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-exception",
      source: "mem-c",
      target: "mem-d",
      edgeType: "exception_to",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:02:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-supersedes",
      source: "mem-d",
      target: "mem-e",
      edgeType: "supersedes",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:03:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-contradicts",
      source: "mem-e",
      target: "mem-f",
      edgeType: "contradicts",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:04:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-incompatible",
      source: "mem-a",
      target: "mem-f",
      edgeType: "incompatible_with",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:05:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-ws2",
      source: "ws2-x",
      target: "ws2-y",
      edgeType: "supports",
      workspaceId: "workspace-2",
      createdAt: "2026-04-17T01:06:00.000Z"
    });

    // Duplicate case: an ACTIVE path_relation already represents mem-b ->
    // mem-c / supports. The matching legacy edge must NOT be re-inserted.
    db.prepare(
      `INSERT INTO path_relations (
        path_id, workspace_id, anchors_json, constitution_json,
        effect_vector_json, plasticity_state_json, lifecycle_json, legitimacy_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "existing-path-dup",
      "workspace-1",
      JSON.stringify({
        source_anchor: { kind: "object", object_id: "mem-b" },
        target_anchor: { kind: "object", object_id: "mem-c" }
      }),
      JSON.stringify({ relation_kind: "supports", why_this_relation_exists: ["pre_existing"] }),
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
      JSON.stringify({ evidence_basis: ["pre_existing"], governance_class: "attention_only" }),
      "2026-04-17T00:30:00.000Z",
      "2026-04-17T00:30:00.000Z"
    );
    seedLegacyEdge(db, {
      edgeId: "edge-dup",
      source: "mem-b",
      target: "mem-c",
      edgeType: "supports",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:07:00.000Z"
    });

    applyMigration(db, MIGRATION_085);

    // The legacy table is gone.
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_graph_edges'")
      .get();
    expect(tableRow).toBeUndefined();

    const paths = readPaths(db);
    const byPathId = new Map(paths.map((row) => [row.path_id, row]));

    // The pre-existing duplicate path is the only supports/mem-b->mem-c row;
    // the legacy edge-dup did NOT mint a second path_relation.
    expect(byPathId.has("existing-path-dup")).toBe(true);
    expect(byPathId.has("legacy-edge:edge-dup")).toBe(false);
    const dupKindRows = paths.filter(
      (row) =>
        JSON.parse(row.constitution_json).relation_kind === "supports" &&
        JSON.parse(row.anchors_json).source_anchor.object_id === "mem-b" &&
        JSON.parse(row.anchors_json).target_anchor.object_id === "mem-c"
    );
    expect(dupKindRows).toHaveLength(1);

    // Every other legacy edge survives at a deterministic, edge-derived id.
    const expectations: ReadonlyArray<{
      readonly edgeId: string;
      readonly workspaceId: string;
      readonly source: string;
      readonly target: string;
      readonly relationKind: string;
      readonly recallBias: number;
      readonly governanceClass: string;
      readonly createdAt: string;
    }> = [
      {
        edgeId: "edge-supports",
        workspaceId: "workspace-1",
        source: "mem-a",
        target: "mem-b",
        relationKind: "supports",
        recallBias: 0.5,
        governanceClass: "attention_only",
        createdAt: "2026-04-17T01:00:00.000Z"
      },
      {
        edgeId: "edge-recalls",
        workspaceId: "workspace-1",
        source: "mem-a",
        target: "mem-c",
        // A legacy `recalls` edge backfills under the live associative seeder's
        // name `co_recalled`; both fold to the same graph edge_type and weight.
        relationKind: "co_recalled",
        recallBias: 0.5,
        governanceClass: "attention_only",
        createdAt: "2026-04-17T01:01:00.000Z"
      },
      {
        edgeId: "edge-exception",
        workspaceId: "workspace-1",
        source: "mem-c",
        target: "mem-d",
        relationKind: "exception_to",
        recallBias: 0,
        governanceClass: "recall_allowed",
        createdAt: "2026-04-17T01:02:00.000Z"
      },
      {
        edgeId: "edge-supersedes",
        workspaceId: "workspace-1",
        source: "mem-d",
        target: "mem-e",
        relationKind: "supersedes",
        recallBias: -0.5,
        governanceClass: "recall_allowed",
        createdAt: "2026-04-17T01:03:00.000Z"
      },
      {
        edgeId: "edge-contradicts",
        workspaceId: "workspace-1",
        source: "mem-e",
        target: "mem-f",
        relationKind: "contradicts",
        recallBias: -0.4,
        governanceClass: "recall_allowed",
        createdAt: "2026-04-17T01:04:00.000Z"
      },
      {
        edgeId: "edge-incompatible",
        workspaceId: "workspace-1",
        source: "mem-a",
        target: "mem-f",
        relationKind: "incompatible_with",
        recallBias: -0.3,
        governanceClass: "recall_allowed",
        createdAt: "2026-04-17T01:05:00.000Z"
      },
      {
        edgeId: "edge-ws2",
        workspaceId: "workspace-2",
        source: "ws2-x",
        target: "ws2-y",
        relationKind: "supports",
        recallBias: 0.5,
        governanceClass: "attention_only",
        createdAt: "2026-04-17T01:06:00.000Z"
      }
    ];

    for (const expectation of expectations) {
      const pathId = `legacy-edge:${expectation.edgeId}`;
      const row = byPathId.get(pathId);
      expect(row, `expected backfilled path ${pathId}`).toBeDefined();
      if (row === undefined) {
        continue;
      }
      expect(row.workspace_id).toBe(expectation.workspaceId);

      const anchors = JSON.parse(row.anchors_json);
      expect(anchors.source_anchor).toEqual({ kind: "object", object_id: expectation.source });
      expect(anchors.target_anchor).toEqual({ kind: "object", object_id: expectation.target });

      const constitution = JSON.parse(row.constitution_json);
      expect(constitution.relation_kind).toBe(expectation.relationKind);

      const effect = JSON.parse(row.effect_vector_json);
      expect(effect.recall_bias).toBe(expectation.recallBias);
      // recall_bias sign family: negatives are the suppression family.
      const sign = Math.sign(effect.recall_bias);
      const expectedSign = Math.sign(expectation.recallBias);
      expect(sign).toBe(expectedSign);

      const legitimacy = JSON.parse(row.legitimacy_json);
      expect(legitimacy.governance_class).toBe(expectation.governanceClass);
      expect(legitimacy.evidence_basis).toEqual([`legacy_memory_graph_edge:${expectation.edgeId}`]);

      const lifecycle = JSON.parse(row.lifecycle_json);
      expect(lifecycle.status).toBe("active");

      expect(row.created_at).toBe(expectation.createdAt);
      expect(row.updated_at).toBe(expectation.createdAt);
    }

    // The SQL-built JSON must survive the live repo parse path (PathRelationSchema)
    // and active-lifecycle detection, proving the backfilled shape matches what
    // the producer mints, not just well-formed JSON. The positive associative
    // families (supports / recalls) land active; exception_to (recall_bias 0)
    // and the negative family are active too — recall eligibility is decided
    // downstream by sign, not by lifecycle.
    const repo = new SqlitePathRelationRepo(new StorageDatabase(":memory:", db));
    const active1 = await repo.findActive("workspace-1");
    const active1Ids = new Set(active1.map((relation) => relation.path_id));
    for (const pathId of [
      "legacy-edge:edge-supports",
      "legacy-edge:edge-recalls",
      "legacy-edge:edge-exception",
      "legacy-edge:edge-supersedes",
      "legacy-edge:edge-contradicts",
      "legacy-edge:edge-incompatible"
    ]) {
      expect(active1Ids.has(pathId)).toBe(true);
    }
    const active2 = await repo.findActive("workspace-2");
    expect(active2.map((relation) => relation.path_id)).toEqual(["legacy-edge:edge-ws2"]);
  });

  it("dedupes a legacy `recalls` edge against a cutover-minted `co_recalled` path for the same pair", () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");
    for (const id of ["mem-a", "mem-b"]) {
      seedMemory(db, id, "workspace-1");
    }

    // The cutover already minted a `co_recalled` path for the mem-a -> mem-b
    // pair (the live associative seeder's name). A pre-spine `recalls` edge for
    // the SAME pair must NOT survive as a second associative path, or the pair
    // would carry double the recall weight. The dedup catches it because the
    // legacy `recalls` edge backfills under the same `co_recalled` name.
    db.prepare(
      `INSERT INTO path_relations (
        path_id, workspace_id, anchors_json, constitution_json,
        effect_vector_json, plasticity_state_json, lifecycle_json, legitimacy_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "cutover-co-recalled",
      "workspace-1",
      JSON.stringify({
        source_anchor: { kind: "object", object_id: "mem-a" },
        target_anchor: { kind: "object", object_id: "mem-b" }
      }),
      JSON.stringify({ relation_kind: "co_recalled", why_this_relation_exists: ["recalls_edge_co_usage"] }),
      JSON.stringify({
        salience: 0.5,
        recall_bias: 0.5,
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
      JSON.stringify({ evidence_basis: ["recalls_edge_co_usage"], governance_class: "attention_only" }),
      "2026-04-17T00:30:00.000Z",
      "2026-04-17T00:30:00.000Z"
    );
    seedLegacyEdge(db, {
      edgeId: "edge-recalls-dup",
      source: "mem-a",
      target: "mem-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:00:00.000Z"
    });

    applyMigration(db, MIGRATION_085);

    const paths = readPaths(db);
    const byPathId = new Map(paths.map((row) => [row.path_id, row]));
    // The cutover path survives; the legacy `recalls` edge did NOT mint a second.
    expect(byPathId.has("cutover-co-recalled")).toBe(true);
    expect(byPathId.has("legacy-edge:edge-recalls-dup")).toBe(false);
    const associativeRows = paths.filter(
      (row) =>
        JSON.parse(row.constitution_json).relation_kind === "co_recalled" &&
        JSON.parse(row.anchors_json).source_anchor.object_id === "mem-a" &&
        JSON.parse(row.anchors_json).target_anchor.object_id === "mem-b"
    );
    expect(associativeRows).toHaveLength(1);
  });

});
