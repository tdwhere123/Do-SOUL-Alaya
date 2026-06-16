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
