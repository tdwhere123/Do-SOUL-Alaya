import { afterEach, describe, expect, it, vi } from "vitest";
import type { PathAnchorRef, PathRelation } from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqlitePathRelationRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { GraphExploreService } from "../../path-graph/path-relations/graph-explore-service.js";

const databases = new Set<StorageDatabase>();
const WORKSPACE_ID = "workspace-1";
const TARGET_ID = "memory-target";
const PEER_ID = "memory-peer";

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("GraphExploreService backing-object path reads", () => {
  it("includes typed directional targets and both unordered endpoints", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    seedWorkspace(database);
    const pathRepo = new SqlitePathRelationRepo(database);
    pathRepo.create(relation(
      "path-directional",
      { kind: "object", object_id: "memory-source" },
      { kind: "object_facet", object_id: TARGET_ID, facet_key: "status" },
      "supports"
    ));
    pathRepo.create(relation(
      "path-unordered",
      { kind: "time_concern", source_object_id: TARGET_ID, window_digest: "week-1" },
      { kind: "obligation", source_object_id: PEER_ID, obligation_digest: "help-1" },
      "answers_with"
    ));
    const service = new GraphExploreService({
      pathRepo,
      eventLogRepo: { append: vi.fn(async (entry) => ({
        ...entry,
        event_id: "event-1",
        created_at: "2026-07-10T00:00:00.000Z",
        revision: 0
      })) }
    });

    await expect(service.countInboundEdgesWeighted(TARGET_ID, WORKSPACE_ID))
      .resolves.toBeCloseTo(1.3);
    await expect(service.countInboundEdgesWeighted(PEER_ID, WORKSPACE_ID))
      .resolves.toBeCloseTo(0.3);
    await expect(service.exploreOneHop(TARGET_ID, WORKSPACE_ID)).resolves.toEqual([
      { memory_id: "memory-source", edge_type: "supports", direction: "inbound", edge_id: "path-directional" },
      { memory_id: PEER_ID, edge_type: "recalls", direction: "outbound", edge_id: "path-unordered" }
    ]);
  });
});

function relation(
  pathId: string,
  sourceAnchor: PathAnchorRef,
  targetAnchor: PathAnchorRef,
  relationKind: string
): PathRelation {
  return {
    path_id: pathId,
    workspace_id: WORKSPACE_ID,
    anchors: { source_anchor: sourceAnchor, target_anchor: targetAnchor },
    constitution: { relation_kind: relationKind, why_this_relation_exists: ["test"] },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "source_to_target",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: { status: "active", retirement_rule: "manual" },
    legitimacy: { evidence_basis: ["test"], governance_class: "recall_allowed" },
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z"
  };
}

function seedWorkspace(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    WORKSPACE_ID,
    "Graph Explore Workspace",
    "/tmp/graph-explore",
    "local_repo",
    null,
    "active",
    "2026-07-10T00:00:00.000Z",
    null,
    null
  );
}
