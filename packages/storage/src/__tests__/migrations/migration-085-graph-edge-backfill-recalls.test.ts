import { afterEach, describe, expect, it } from "vitest";
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

describe("migration 085 recalls-family dedupe", () => {
  it("dedupes a legacy `recalls` edge against ANY recalls-tier path (shares_entity / signal_graph_ref) for the same pair", () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");
    for (const id of ["mem-a", "mem-b", "mem-c", "mem-d"]) {
      seedMemory(db, id, "workspace-1");
    }

    // Graph support / recalls counts consume the MAPPED graph edge_type. Several
    // relation kinds fold to graph `recalls`: recalls / co_recalled /
    // shares_entity / signal_graph_ref. A pre-upgrade DB can already hold an
    // active `shares_entity` (or `signal_graph_ref`) path for a pair. A legacy
    // `recalls` edge for that SAME pair must dedupe against the WHOLE recalls
    // tier, not just the literal `co_recalled` rename — else the pair carries
    // two associative paths and double-counts the same semantic edge.
    // cross-file ref: packages/protocol/src/soul/memory-graph.ts mapRelationKindToGraphEdgeType
    const seedAssociativePath = (
      pathId: string,
      relationKind: string,
      source: string,
      target: string
    ): void => {
      db.prepare(
        `INSERT INTO path_relations (
          path_id, workspace_id, anchors_json, constitution_json,
          effect_vector_json, plasticity_state_json, lifecycle_json, legitimacy_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        pathId,
        "workspace-1",
        JSON.stringify({
          source_anchor: { kind: "object", object_id: source },
          target_anchor: { kind: "object", object_id: target }
        }),
        JSON.stringify({ relation_kind: relationKind, why_this_relation_exists: ["pre_existing"] }),
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
        JSON.stringify({ evidence_basis: ["pre_existing"], governance_class: "attention_only" }),
        "2026-04-17T00:30:00.000Z",
        "2026-04-17T00:30:00.000Z"
      );
    };

    // Pair A: an active `shares_entity` path already exists.
    seedAssociativePath("existing-shares-entity", "shares_entity", "mem-a", "mem-b");
    // Pair B: an active `signal_graph_ref` path already exists.
    seedAssociativePath("existing-signal-graph-ref", "signal_graph_ref", "mem-c", "mem-d");

    // Legacy `recalls` edges for both pairs — both must be deduped (skipped).
    seedLegacyEdge(db, {
      edgeId: "edge-recalls-vs-shares",
      source: "mem-a",
      target: "mem-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:00:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-recalls-vs-signal",
      source: "mem-c",
      target: "mem-d",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:01:00.000Z"
    });

    applyMigration(db, MIGRATION_085);

    const paths = readPaths(db);
    const byPathId = new Map(paths.map((row) => [row.path_id, row]));

    // The pre-existing tier paths survive; neither legacy `recalls` edge minted
    // a second associative duplicate for its pair.
    expect(byPathId.has("existing-shares-entity")).toBe(true);
    expect(byPathId.has("existing-signal-graph-ref")).toBe(true);
    expect(byPathId.has("legacy-edge:edge-recalls-vs-shares")).toBe(false);
    expect(byPathId.has("legacy-edge:edge-recalls-vs-signal")).toBe(false);

    // No new `legacy-edge:*` associative path of ANY recalls-tier kind landed
    // for either pair.
    const recallsTier = new Set(["recalls", "co_recalled", "shares_entity", "signal_graph_ref"]);
    const pairAssociative = (source: string, target: string): readonly PathRow[] =>
      paths.filter((row) => {
        const anchors = JSON.parse(row.anchors_json);
        return (
          recallsTier.has(JSON.parse(row.constitution_json).relation_kind) &&
          anchors.source_anchor.object_id === source &&
          anchors.target_anchor.object_id === target
        );
      });
    expect(pairAssociative("mem-a", "mem-b")).toHaveLength(1);
    expect(pairAssociative("mem-c", "mem-d")).toHaveLength(1);
  });

  it("does not dedupe positive legacy `recalls` against negative or neutral recalls-tier paths", () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");
    for (const id of ["mem-a", "mem-b", "mem-c", "mem-d"]) {
      seedMemory(db, id, "workspace-1");
    }

    seedExistingPath(db, {
      pathId: "existing-negative-co-recalled",
      source: "mem-a",
      target: "mem-b",
      relationKind: "co_recalled",
      recallBias: -0.5
    });
    seedExistingPath(db, {
      pathId: "existing-neutral-shares-entity",
      source: "mem-c",
      target: "mem-d",
      relationKind: "shares_entity",
      recallBias: 0
    });
    seedLegacyEdge(db, {
      edgeId: "edge-recalls-vs-negative",
      source: "mem-a",
      target: "mem-b",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:00:00.000Z"
    });
    seedLegacyEdge(db, {
      edgeId: "edge-recalls-vs-neutral",
      source: "mem-c",
      target: "mem-d",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:01:00.000Z"
    });

    applyMigration(db, MIGRATION_085);

    const paths = readPaths(db);
    const byPathId = new Map(paths.map((row) => [row.path_id, row]));
    expect(byPathId.has("existing-negative-co-recalled")).toBe(true);
    expect(byPathId.has("existing-neutral-shares-entity")).toBe(true);
    expect(byPathId.has("legacy-edge:edge-recalls-vs-negative")).toBe(true);
    expect(byPathId.has("legacy-edge:edge-recalls-vs-neutral")).toBe(true);

    const recallBiasByPathId = new Map(
      paths.map((row) => [row.path_id, JSON.parse(row.effect_vector_json).recall_bias])
    );
    expect(recallBiasByPathId.get("legacy-edge:edge-recalls-vs-negative")).toBe(0.5);
    expect(recallBiasByPathId.get("legacy-edge:edge-recalls-vs-neutral")).toBe(0.5);
  });

  it("dedupes a REVERSE-oriented legacy `recalls` edge against a cutover-minted `co_recalled` path for the same pair", () => {
    const { db } = migrateThroughPre085();
    seedWorkspace(db, "workspace-1");
    // mem-low < mem-high lexically; the live co_recalled producer mints SORTED
    // (source=low, target=high) while the legacy librarian wrote `recalls`
    // UNSORTED. So the only realistic collision is a REVERSE-oriented legacy
    // edge (high->low) against a sorted cutover path (low->high). The recalls
    // tier is symmetric: that reverse edge is the SAME semantic edge and MUST
    // dedup, else the pair carries two associative paths and graph_support
    // double-counts the recall weight at both endpoints.
    // cross-file ref: packages/core/src/path-graph/path-relation-proposal-service.ts accrueCoOccurrence (sorts then mints low->high)
    for (const id of ["mem-low", "mem-high"]) {
      seedMemory(db, id, "workspace-1");
    }

    // Cutover path: SORTED orientation low -> high.
    db.prepare(
      `INSERT INTO path_relations (
        path_id, workspace_id, anchors_json, constitution_json,
        effect_vector_json, plasticity_state_json, lifecycle_json, legitimacy_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "cutover-co-recalled-sorted",
      "workspace-1",
      JSON.stringify({
        source_anchor: { kind: "object", object_id: "mem-low" },
        target_anchor: { kind: "object", object_id: "mem-high" }
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
    // Legacy `recalls` edge in the REVERSE orientation high -> low.
    seedLegacyEdge(db, {
      edgeId: "edge-recalls-reverse",
      source: "mem-high",
      target: "mem-low",
      edgeType: "recalls",
      workspaceId: "workspace-1",
      createdAt: "2026-04-17T01:00:00.000Z"
    });

    applyMigration(db, MIGRATION_085);

    const paths = readPaths(db);
    const byPathId = new Map(paths.map((row) => [row.path_id, row]));
    // The sorted cutover path survives; the reverse-oriented legacy edge did NOT
    // mint a second associative path.
    expect(byPathId.has("cutover-co-recalled-sorted")).toBe(true);
    expect(byPathId.has("legacy-edge:edge-recalls-reverse")).toBe(false);

    // Exactly ONE associative path links the {mem-low, mem-high} pair, counting
    // BOTH orientations.
    const recallsTier = new Set(["recalls", "co_recalled", "shares_entity", "signal_graph_ref"]);
    const pairAssociative = paths.filter((row) => {
      const anchors = JSON.parse(row.anchors_json);
      const ids = new Set([anchors.source_anchor.object_id, anchors.target_anchor.object_id]);
      return (
        recallsTier.has(JSON.parse(row.constitution_json).relation_kind) &&
        ids.has("mem-low") &&
        ids.has("mem-high")
      );
    });
    expect(pairAssociative).toHaveLength(1);
  });


});
