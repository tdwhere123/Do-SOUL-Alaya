import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it } from "vitest";
import { inspectSnapshotGraphPreflight } from
  "../../../longmemeval/snapshot/current/snapshot-graph-preflight.js";
import { validateSnapshotManifest } from
  "../../../longmemeval/snapshot/manifest-validation.js";
import { currentSnapshotManifestFor } from "./current-snapshot-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("snapshot graph preflight", () => {
  it("partitions every persisted path into eligible or one rejection reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "snapshot-graph-preflight-"));
    roots.push(root);
    const dbPath = join(root, "snapshot.db");
    const database = initDatabase({ filename: dbPath });
    seedWorkspace(database.connection);
    seedHqEndpoint(database.connection, "eligible-source");
    seedHqEndpoint(database.connection, "eligible-target");
    seedHqEndpoint(database.connection, "missing-direction-source");
    seedHqEndpoint(database.connection, "missing-direction-target");
    seedHqEndpoint(database.connection, "missing-source-kind-source");
    seedHqEndpoint(database.connection, "missing-source-kind-target");
    insertPath(database.connection, "eligible");
    insertPath(database.connection, "inactive", { status: "dormant" });
    insertPath(database.connection, "non-positive", { recallBias: 0 });
    insertPath(database.connection, "wrong-governance", { governance: "hint_only" });
    insertPath(database.connection, "other-kind", { relationKind: "supports" });
    insertPath(database.connection, "missing-governance", { omitGovernance: true });
    insertPath(database.connection, "missing-direction", { omitDirection: true });
    insertPath(database.connection, "dangling");
    insertPath(database.connection, "string-bias", { recallBias: "abc" });
    insertPath(database.connection, "boolean-bias", { recallBias: true });
    insertPath(database.connection, "invalid-evidence", {
      evidenceBasis: "not-an-array"
    });
    insertPath(database.connection, "missing-source-kind", {
      omitSourceKind: true
    });
    database.close();

    const result = inspectSnapshotGraphPreflight(dbPath);

    expect(result).toEqual({
      eligibilityBasis: "formation_recall_allowed",
      totalCount: 12,
      eligibleCount: 1,
      eligibleWorkspaceCount: 1,
      eligibleWorkspaceIds: ["workspace-graph"],
      relationKindCounts: {
        answers_with: 5,
        supports: 1,
        __invalid_or_unparseable__: 6
      },
      lifecycleStatusCounts: {
        active: 5,
        dormant: 1,
        __invalid_or_unparseable__: 6
      },
      rejectedByReason: {
        invalid_json: 0,
        invalid_shape: 6,
        other_relation_kind: 1,
        inactive: 1,
        non_positive: 1,
        wrong_governance: 1,
        missing_endpoint: 1,
        unsupported_direction: 0
      }
    });
    expect(
      result.eligibleCount +
      Object.values(result.rejectedByReason).reduce((sum, count) => sum + count, 0)
    ).toBe(result.totalCount);
    expect(Object.values(result.relationKindCounts)
      .reduce((sum, count) => sum + count, 0)).toBe(result.totalCount);
    expect(Object.values(result.lifecycleStatusCounts)
      .reduce((sum, count) => sum + count, 0)).toBe(result.totalCount);
  });

  it("binds the complete graph preflight into current snapshot manifests", () => {
    const graphPreflight = {
      eligibilityBasis: "formation_recall_allowed",
      totalCount: 1,
      eligibleCount: 1,
      eligibleWorkspaceCount: 1,
      eligibleWorkspaceIds: ["longmemeval-q-1"],
      relationKindCounts: { answers_with: 1 },
      lifecycleStatusCounts: { active: 1 },
      rejectedByReason: {
        invalid_json: 0,
        invalid_shape: 0,
        other_relation_kind: 0,
        inactive: 0,
        non_positive: 0,
        wrong_governance: 0,
        missing_endpoint: 0,
        unsupported_direction: 0
      }
    } as const;
    const parsed = validateSnapshotManifest({
      ...currentSnapshotManifestFor("q-1"),
      graph_preflight: graphPreflight
    }, "snapshot.db.manifest.json");

    expect(parsed.graph_preflight).toEqual(graphPreflight);
  });
});

type SqliteConnection = ReturnType<typeof initDatabase>["connection"];

function seedWorkspace(db: SqliteConnection): void {
  db.prepare(`INSERT INTO workspaces (
    workspace_id, name, root_path, workspace_kind, default_engine_binding,
    workspace_state, created_at, archived_at, default_engine_class
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "workspace-graph",
    "Graph Preflight Workspace",
    "/tmp/workspace-graph",
    "local_repo",
    null,
    "active",
    "2026-07-30T00:00:00.000Z",
    null,
    null
  );
}

function insertPath(
  db: SqliteConnection,
  pathId: string,
  overrides: Readonly<{
    status?: "active" | "dormant";
    recallBias?: unknown;
    governance?: "hint_only" | "recall_allowed";
    relationKind?: string;
    evidenceBasis?: unknown;
    omitGovernance?: boolean;
    omitDirection?: boolean;
    omitSourceKind?: boolean;
  }> = {}
): void {
  db.prepare(`INSERT INTO path_relations (
    path_id, workspace_id, anchors_json, constitution_json, effect_vector_json,
    plasticity_state_json, lifecycle_json, legitimacy_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    pathId,
    "workspace-graph",
    JSON.stringify({
      source_anchor: {
        ...(!overrides.omitSourceKind ? { kind: "object" } : {}),
        object_id: `${pathId}-source`
      },
      target_anchor: { kind: "object", object_id: `${pathId}-target` }
    }),
    JSON.stringify({
      relation_kind: overrides.relationKind ?? "answers_with",
      why_this_relation_exists: ["graph preflight fixture"]
    }),
    JSON.stringify({
      salience: 1,
      recall_bias: overrides.recallBias ?? 1,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    }),
    JSON.stringify({
      strength: 1,
      ...(!overrides.omitDirection
        ? { direction_bias: "source_to_target" }
        : {}),
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    }),
    JSON.stringify({
      status: overrides.status ?? "active",
      retirement_rule: "manual"
    }),
    JSON.stringify({
      evidence_basis: overrides.evidenceBasis ?? ["graph preflight fixture"],
      ...(!overrides.omitGovernance
        ? { governance_class: overrides.governance ?? "recall_allowed" }
        : {})
    }),
    "2026-07-30T00:00:00.000Z",
    "2026-07-30T00:00:00.000Z"
  );
}

function seedHqEndpoint(db: SqliteConnection, objectId: string): void {
  db.prepare(`INSERT INTO memory_entries (
    object_id, created_at, updated_at, created_by, dimension, source_kind,
    formation_kind, scope_class, content, workspace_id, run_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    objectId,
    "2026-07-30T00:00:00.000Z",
    "2026-07-30T00:00:00.000Z",
    "system",
    "procedure",
    "user",
    "explicit",
    "project",
    objectId,
    "workspace-graph",
    "run-graph"
  );
  db.prepare(`INSERT INTO memory_hq (
    object_id, workspace_id, hqs_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?)`).run(
    objectId,
    "workspace-graph",
    JSON.stringify([objectId]),
    "2026-07-30T00:00:00.000Z",
    "2026-07-30T00:00:00.000Z"
  );
}
