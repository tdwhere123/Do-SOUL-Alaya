import { describe, expect, it, vi } from "vitest";
import {
  GraphAuditorEventType,
  type EventLogEntry,
  type MemoryGraphEdgeTypeValue,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { GraphExploreService } from "../../path-graph/path-relations/graph-explore-service.js";

function createEventLogEntry(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
  return {
    event_id: `event-${event.event_type}-${event.entity_id}`,
    created_at: "2026-03-28T10:00:00.000Z",
    revision: 0,
    ...event
  };
}

function createPath(overrides: {
  readonly pathId: string;
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly relationKind?: string;
  readonly status?: "active" | "retired" | "dormant";
  readonly recallBias?: number;
}): PathRelation {
  return {
    path_id: overrides.pathId,
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: overrides.sourceMemoryId },
      target_anchor: { kind: "object", object_id: overrides.targetMemoryId }
    },
    constitution: {
      relation_kind: overrides.relationKind ?? "supports",
      why_this_relation_exists: ["test"]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: overrides.recallBias ?? 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: overrides.status ?? "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: ["test_evidence"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-03-28T10:00:00.000Z",
    updated_at: "2026-03-28T10:00:00.000Z"
  };
}

function createPathRepo(paths: readonly PathRelation[] = []) {
  return {
    findByAnchors: vi.fn(async () => paths),
    findByBackingObjectId: vi.fn(async () => paths),
    findByBackingObjectIds: vi.fn(async () => paths),
    findByTargetAnchor: vi.fn(async (_workspaceId: string, anchorRef: { kind: string; object_id?: string }) =>
      paths.filter((path) => {
        const target = path.anchors.target_anchor;
        return (
          target.kind === "object" &&
          anchorRef.kind === "object" &&
          target.object_id === anchorRef.object_id
        );
      })
    )
  };
}

// invariant: GraphExploreService reads the unified path plane (PathRelation),
// not memory_graph_edges. It is path-only — no edge repo, no edge-write
// surface; recall graph_support counts read the path plane.
describe("GraphExploreService", () => {
  it("explores one-hop path neighbors in both directions by default and emits an explore event", async () => {
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
      createEventLogEntry(event)
    );
    const service = new GraphExploreService({
      pathRepo: createPathRepo([
        createPath({ pathId: "path-out", sourceMemoryId: "memory-a", targetMemoryId: "memory-b" }),
        createPath({ pathId: "path-in", sourceMemoryId: "memory-c", targetMemoryId: "memory-a" })
      ]),
      eventLogRepo: { append },
      now: () => "2026-03-28T10:00:00.000Z"
    });

    const neighbors = await service.exploreOneHop("memory-a", "workspace-1");

    expect(neighbors).toEqual([
      {
        memory_id: "memory-b",
        edge_type: "supports",
        direction: "outbound",
        edge_id: "path-out"
      },
      {
        memory_id: "memory-c",
        edge_type: "supports",
        direction: "inbound",
        edge_id: "path-in"
      }
    ]);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GraphAuditorEventType.SOUL_GRAPH_EXPLORE_COMPLETED,
        entity_type: "memory_entry",
        entity_id: "memory-a",
        payload_json: expect.objectContaining({
          exploration_kind: "memory_neighbors",
          source_memory_id: "memory-a",
          workspace_id: "workspace-1",
          direction: "both",
          neighbor_count: 2
        })
      })
    );
  });

  it("projects non-enum relation_kind (co_recalled) onto the recalls edge_type", async () => {
    const service = new GraphExploreService({
      pathRepo: createPathRepo([
        createPath({
          pathId: "path-corecall",
          sourceMemoryId: "memory-a",
          targetMemoryId: "memory-b",
          relationKind: "co_recalled"
        })
      ]),
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) }
    });

    const neighbors = await service.exploreOneHop("memory-a", "workspace-1");
    expect(neighbors).toEqual([
      { memory_id: "memory-b", edge_type: "recalls", direction: "outbound", edge_id: "path-corecall" }
    ]);
  });

  it("excludes non-active paths and filters by edge_type", async () => {
    const service = new GraphExploreService({
      pathRepo: createPathRepo([
        createPath({ pathId: "path-active", sourceMemoryId: "memory-a", targetMemoryId: "memory-b", relationKind: "supports" }),
        createPath({ pathId: "path-supersedes", sourceMemoryId: "memory-a", targetMemoryId: "memory-c", relationKind: "supersedes" }),
        createPath({ pathId: "path-retired", sourceMemoryId: "memory-a", targetMemoryId: "memory-d", status: "retired" })
      ]),
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) }
    });

    const neighbors = await service.exploreOneHop("memory-a", "workspace-1", {
      edgeTypes: ["supports"]
    });
    expect(neighbors).toEqual([
      { memory_id: "memory-b", edge_type: "supports", direction: "outbound", edge_id: "path-active" }
    ]);
  });

  it("returns an empty neighbor list without emitting an explore event when no paths match", async () => {
    const append = vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) =>
      createEventLogEntry(event)
    );
    const service = new GraphExploreService({
      pathRepo: createPathRepo(),
      eventLogRepo: { append }
    });

    await expect(service.exploreOneHop("memory-a", "workspace-1")).resolves.toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("translates invalid edge_types into a validation error", async () => {
    const pathRepo = createPathRepo();
    const service = new GraphExploreService({
      pathRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) }
    });

    await expect(
      service.exploreOneHop("memory-a", "workspace-1", {
        edgeTypes: ["not-a-real-edge"] as unknown as readonly MemoryGraphEdgeTypeValue[]
      })
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "VALIDATION",
      message: "Invalid edge_type"
    });
    expect(pathRepo.findByBackingObjectId).not.toHaveBeenCalled();
  });
});

// invariant: graph_support counts read positive recall-eligible paths. Ordered
// kinds contribute at the target; unordered semantic kinds at both endpoints.
describe("GraphExploreService countInbound* on the path plane", () => {
  const TARGET = "memory-target";

  function createServiceWithInboundPaths(paths: readonly PathRelation[]): GraphExploreService {
    return new GraphExploreService({
      pathRepo: createPathRepo(paths),
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) }
    });
  }

  it("weights inbound recall-eligible paths from EDGE_TYPE_RECALL_MODEL (zero-drift vs the equivalent positive edge graph)", async () => {
    const service = createServiceWithInboundPaths([
      createPath({ pathId: "p-supports", sourceMemoryId: "src-1", targetMemoryId: TARGET, relationKind: "supports" }),
      createPath({ pathId: "p-derives", sourceMemoryId: "src-2", targetMemoryId: TARGET, relationKind: "derives_from" }),
      createPath({ pathId: "p-recalls", sourceMemoryId: "src-3", targetMemoryId: TARGET, relationKind: "recalls" })
    ]);

    // supports 1.0 + derives_from 0.5 + recalls 0.3 = 1.8, exactly the
    // EDGE_TYPE_RECALL_MODEL contribution weights the edge world summed.
    expect(await service.countInboundEdgesWeighted(TARGET, "workspace-1")).toBeCloseTo(1.8);
  });

  it("excludes inbound active negative paths from the weighted sum (positive-only guard)", async () => {
    const service = createServiceWithInboundPaths([
      createPath({ pathId: "p-supports", sourceMemoryId: "src-1", targetMemoryId: TARGET, relationKind: "supports" }),
      // Active negative path (recall_bias < 0): suppression is the recall-plane
      // channel's job; it must not subtract from or enter graph_support here.
      createPath({
        pathId: "p-supersedes",
        sourceMemoryId: "src-2",
        targetMemoryId: TARGET,
        relationKind: "supersedes",
        recallBias: -0.5
      }),
      createPath({
        pathId: "p-contradicts",
        sourceMemoryId: "src-3",
        targetMemoryId: TARGET,
        relationKind: "contradicts",
        recallBias: -0.4
      })
    ]);

    // Only the supports path counts; the negatives contribute 0 and do not
    // pull the value below the positive-only total.
    expect(await service.countInboundEdgesWeighted(TARGET, "workspace-1")).toBeCloseTo(1.0);
  });

  it("excludes inbound non-active (dormant/retired) paths", async () => {
    const service = createServiceWithInboundPaths([
      createPath({ pathId: "p-active", sourceMemoryId: "src-1", targetMemoryId: TARGET, relationKind: "supports" }),
      createPath({
        pathId: "p-dormant",
        sourceMemoryId: "src-2",
        targetMemoryId: TARGET,
        relationKind: "supports",
        status: "dormant"
      }),
      createPath({
        pathId: "p-retired",
        sourceMemoryId: "src-3",
        targetMemoryId: TARGET,
        relationKind: "supports",
        status: "retired"
      })
    ]);

    expect(await service.countInboundEdgesWeighted(TARGET, "workspace-1")).toBeCloseTo(1.0);
  });

  it("counts only recalls-tier inbound paths for countInboundRecalls", async () => {
    const service = createServiceWithInboundPaths([
      createPath({ pathId: "p-recalls", sourceMemoryId: "src-1", targetMemoryId: TARGET, relationKind: "recalls" }),
      // co_recalled folds to the recalls edge_type (mapper-consistent).
      createPath({ pathId: "p-corecalled", sourceMemoryId: "src-2", targetMemoryId: TARGET, relationKind: "co_recalled" }),
      createPath({ pathId: "p-supports", sourceMemoryId: "src-3", targetMemoryId: TARGET, relationKind: "supports" })
    ]);

    expect(await service.countInboundRecalls(TARGET, "workspace-1")).toBe(2);
  });

  it("ignores the source endpoint of directional paths", async () => {
    const service = createServiceWithInboundPaths([
      // TARGET is the SOURCE here, so this is outbound, not inbound.
      createPath({ pathId: "p-outbound", sourceMemoryId: TARGET, targetMemoryId: "other", relationKind: "supports" })
    ]);

    expect(await service.countInboundEdgesWeighted(TARGET, "workspace-1")).toBe(0);
    expect(await service.countInboundRecalls(TARGET, "workspace-1")).toBe(0);
  });

  it("credits both endpoints of bidirectional semantic paths", async () => {
    const service = createServiceWithInboundPaths([
      createPath({ pathId: "p-answer", sourceMemoryId: TARGET, targetMemoryId: "answer-peer", relationKind: "answers_with" }),
      createPath({ pathId: "p-coherent", sourceMemoryId: TARGET, targetMemoryId: "coherent-peer", relationKind: "coheres_with" }),
      createPath({ pathId: "p-corecalled", sourceMemoryId: TARGET, targetMemoryId: "recall-peer", relationKind: "co_recalled" }),
      createPath({ pathId: "p-directional", sourceMemoryId: TARGET, targetMemoryId: "support-peer", relationKind: "supports" })
    ]);

    expect(await service.countInboundEdgesWeighted(TARGET, "workspace-1")).toBeCloseTo(0.9);
    expect(await service.countInboundRecalls(TARGET, "workspace-1")).toBe(3);
  });

  it("gives either endpoint the same contribution for one unordered path", async () => {
    const peer = "memory-peer";
    const service = createServiceWithInboundPaths([
      createPath({
        pathId: "p-answer",
        sourceMemoryId: TARGET,
        targetMemoryId: peer,
        relationKind: "answers_with"
      })
    ]);

    const sourceContribution = await service.countInboundEdgesWeighted(TARGET, "workspace-1");
    const targetContribution = await service.countInboundEdgesWeighted(peer, "workspace-1");
    expect(sourceContribution).toBe(targetContribution);
  });

  it("computes weighted and recalls metrics from one bulk path read", async () => {
    const peer = "memory-peer";
    const pathRepo = createPathRepo([
      createPath({ pathId: "p-supports", sourceMemoryId: "source", targetMemoryId: TARGET, relationKind: "supports" }),
      createPath({ pathId: "p-recalls", sourceMemoryId: TARGET, targetMemoryId: peer, relationKind: "co_recalled" }),
      createPath({ pathId: "p-outbound", sourceMemoryId: TARGET, targetMemoryId: "other", relationKind: "supports" })
    ]);
    const service = new GraphExploreService({
      pathRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) }
    });

    const metrics = await service.countInboundRecallMetricsByMemoryId(
      [TARGET, peer, TARGET],
      "workspace-1"
    );

    expect(metrics).toEqual(new Map([
      [TARGET, { weightedEdgeCount: 1.3, recallCount: 1 }],
      [peer, { weightedEdgeCount: 0.3, recallCount: 1 }]
    ]));
    expect(pathRepo.findByBackingObjectIds).toHaveBeenCalledTimes(1);
    expect(pathRepo.findByBackingObjectIds).toHaveBeenCalledWith(
      "workspace-1",
      [TARGET, peer]
    );
    expect(pathRepo.findByBackingObjectId).not.toHaveBeenCalled();
  });

  it("returns empty bulk metrics without reading paths", async () => {
    const pathRepo = createPathRepo();
    const service = new GraphExploreService({
      pathRepo,
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) }
    });

    await expect(
      service.countInboundRecallMetricsByMemoryId([], "workspace-1")
    ).resolves.toEqual(new Map());
    expect(pathRepo.findByBackingObjectIds).not.toHaveBeenCalled();
  });

  it("matches legacy metrics across eligibility and direction rules", async () => {
    const peer = "memory-peer";
    const paths = [
      createPath({ pathId: "p-supports", sourceMemoryId: "source", targetMemoryId: TARGET, relationKind: "supports" }),
      createPath({ pathId: "p-unordered", sourceMemoryId: TARGET, targetMemoryId: peer, relationKind: "co_recalled" }),
      createPath({ pathId: "p-negative", sourceMemoryId: "source", targetMemoryId: TARGET, relationKind: "contradicts", recallBias: -0.5 }),
      createPath({ pathId: "p-retired", sourceMemoryId: "source", targetMemoryId: peer, relationKind: "recalls", status: "retired" }),
      createPath({ pathId: "p-directional", sourceMemoryId: TARGET, targetMemoryId: "other", relationKind: "supports" })
    ];
    const legacy = createServiceWithInboundPaths(paths);
    const bulk = createServiceWithInboundPaths(paths);
    const expected = new Map([
      [TARGET, {
        weightedEdgeCount: await legacy.countInboundEdgesWeighted(TARGET, "workspace-1"),
        recallCount: await legacy.countInboundRecalls(TARGET, "workspace-1")
      }],
      [peer, {
        weightedEdgeCount: await legacy.countInboundEdgesWeighted(peer, "workspace-1"),
        recallCount: await legacy.countInboundRecalls(peer, "workspace-1")
      }]
    ]);

    await expect(
      bulk.countInboundRecallMetricsByMemoryId([TARGET, peer], "workspace-1")
    ).resolves.toEqual(expected);
  });

  it("matches per-object legacy metrics when the path repo has no bulk reader", async () => {
    const peer = "memory-peer";
    const paths = [
      createPath({ pathId: "p-inbound", sourceMemoryId: "source", targetMemoryId: TARGET, relationKind: "supports" }),
      createPath({ pathId: "p-unordered", sourceMemoryId: TARGET, targetMemoryId: peer, relationKind: "co_recalled" }),
      createPath({ pathId: "p-outbound", sourceMemoryId: TARGET, targetMemoryId: "other", relationKind: "supports" }),
      createPath({ pathId: "p-negative", sourceMemoryId: "source", targetMemoryId: TARGET, relationKind: "contradicts", recallBias: -0.5 }),
      createPath({ pathId: "p-dormant", sourceMemoryId: "source", targetMemoryId: peer, relationKind: "recalls", status: "dormant" })
    ];
    const legacy = createServiceWithInboundPaths(paths);
    const repo = createPathRepo(paths);
    const fallback = new GraphExploreService({
      pathRepo: {
        findByAnchors: repo.findByAnchors,
        findByBackingObjectId: repo.findByBackingObjectId,
        findByTargetAnchor: repo.findByTargetAnchor
      },
      eventLogRepo: { append: vi.fn(async (event) => createEventLogEntry(event)) }
    });
    const memoryIds = [TARGET, peer];
    const expected = new Map(await Promise.all(memoryIds.map(async (memoryId) => [
      memoryId,
      {
        weightedEdgeCount: await legacy.countInboundEdgesWeighted(memoryId, "workspace-1"),
        recallCount: await legacy.countInboundRecalls(memoryId, "workspace-1")
      }
    ] as const)));

    await expect(
      fallback.countInboundRecallMetricsByMemoryId(memoryIds, "workspace-1")
    ).resolves.toEqual(expected);
    expect(repo.findByBackingObjectId).toHaveBeenCalledTimes(memoryIds.length);
    expect(repo.findByBackingObjectIds).not.toHaveBeenCalled();
  });
});
