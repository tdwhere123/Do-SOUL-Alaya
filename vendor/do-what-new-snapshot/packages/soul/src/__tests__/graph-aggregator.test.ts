import { afterEach, describe, expect, it } from "vitest";
import {
  AcceptedBy,
  MemoryDimension,
  ObjectKind,
  ProjectMappingState,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type GlobalMemoryEntry,
  type MemoryEntry,
  type MemoryGraphEdge,
  type ProjectMappingAnchor
} from "@do-what/protocol";
import {
  SqliteGlobalMemoryRepo,
  SqliteMemoryEntryRepo,
  SqliteMemoryGraphEdgeRepo,
  SqliteProjectMappingAnchorRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-what/storage";
import { SoulGraphAggregator } from "../graph/graph-aggregator.js";

const databases = new Set<ReturnType<typeof initDatabase>>();
const MEMORY_1_ID = "11111111-1111-4111-8111-111111111111";
const MEMORY_2_ID = "22222222-2222-4222-8222-222222222222";
const MAPPING_1_ID = "44444444-4444-4444-8444-444444444444";
const MAPPING_2_ID = "55555555-5555-4555-8555-555555555555";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SoulGraphAggregator", () => {
  it("builds a depth-1 workspace graph from local memories and scope edges only", async () => {
    const { aggregator } = await createGraphContext();

    const graph = await aggregator.buildSoulGraph({
      workspaceId: "workspace-1",
      depth: 1,
      limit: 50
    });

    expect(graph).toMatchObject({
      workspace_id: "workspace-1",
      truncated: false,
      node_total: 3,
      edge_total: 3
    });
    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: `memory:${MEMORY_1_ID}`,
        kind: "memory",
        label: "Remember repo conventions",
        scope_id: "scope:project",
        origin_plane: "project"
      }),
      expect.objectContaining({
        id: `memory:${MEMORY_2_ID}`,
        kind: "memory",
        label: "Reuse the existing daemon route stack",
        scope_id: "scope:project",
        origin_plane: "project"
      }),
      expect.objectContaining({
        id: "scope:project",
        kind: "scope",
        label: "project"
      })
    ]);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        id: `belongs_to:memory:${MEMORY_1_ID}:scope:project`,
        kind: "belongs_to",
        source_id: `memory:${MEMORY_1_ID}`,
        target_id: "scope:project"
      }),
      expect.objectContaining({
        id: `belongs_to:memory:${MEMORY_2_ID}:scope:project`,
        kind: "belongs_to",
        source_id: `memory:${MEMORY_2_ID}`,
        target_id: "scope:project"
      }),
      expect.objectContaining({
        id: "derived_from:memory-edge-1",
        kind: "derived_from",
        source_id: `memory:${MEMORY_2_ID}`,
        target_id: `memory:${MEMORY_1_ID}`
      })
    ]);
  });

  it("omits unsupported durable memory edge kinds instead of relabeling them into references", async () => {
    const { aggregator } = await createGraphContext({
      additionalMemoryEdges: [
        createMemoryGraphEdge({
          edge_id: "memory-edge-recalls",
          source_memory_id: MEMORY_1_ID,
          target_memory_id: MEMORY_2_ID,
          edge_type: "recalls",
          created_at: "2026-04-23T00:02:30.000Z"
        })
      ]
    });

    const graph = await aggregator.buildSoulGraph({
      workspaceId: "workspace-1",
      depth: 1,
      limit: 50
    });

    expect(graph).toMatchObject({
      workspace_id: "workspace-1",
      truncated: false,
      node_total: 3,
      edge_total: 3
    });
    expect(graph.edges).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "references:memory-edge-recalls"
        })
      ])
    );
  });

  it("includes signals, local references, and adopted global-memory context when depth reaches two hops", async () => {
    const { aggregator } = await createGraphContext();

    const graph = await aggregator.buildSoulGraph({
      workspaceId: "workspace-1",
      depth: 2,
      limit: 50
    });

    expect(graph).toMatchObject({
      workspace_id: "workspace-1",
      truncated: false,
      node_total: 7,
      edge_total: 6
    });
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "signal:signal-1",
          kind: "signal",
          label: "potential_claim",
          scope_id: "scope:project"
        }),
        expect.objectContaining({
          id: "signal:signal-2",
          kind: "signal"
        }),
        expect.objectContaining({
          id: "memory:global:global-memory-1",
          kind: "memory",
          label: "Global workflow baseline",
          scope_id: "scope:global_domain",
          origin_plane: "global"
        }),
        expect.objectContaining({
          id: "scope:global_domain",
          kind: "scope",
          label: "global_domain"
        })
      ])
    );
    expect(graph.nodes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "memory:global:global-memory-rejected"
        }),
        expect.objectContaining({
          kind: "projection"
        })
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "belongs_to:signal:signal-1:scope:project",
          kind: "belongs_to",
          source_id: "signal:signal-1",
          target_id: "scope:project"
        }),
        expect.objectContaining({
          id: `references:signal-1:${MEMORY_1_ID}`,
          kind: "references",
          source_id: "signal:signal-1",
          target_id: `memory:${MEMORY_1_ID}`
        })
      ])
    );
  });

  it("keeps depth-three output truthful without requiring reserved surface repos", async () => {
    const { aggregator } = await createGraphContext();

    const depthThree = await aggregator.buildSoulGraph({
      workspaceId: "workspace-1",
      depth: 3,
      limit: 50
    });

    expect(depthThree).toMatchObject({
      workspace_id: "workspace-1",
      truncated: false,
      node_total: 7,
      edge_total: 6
    });
    expect(depthThree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "memory:global:global-memory-1",
          kind: "memory",
          label: "Global workflow baseline",
          scope_id: "scope:global_domain",
          origin_plane: "global"
        }),
        expect.objectContaining({
          id: "scope:global_domain",
          kind: "scope",
          label: "global_domain"
        })
      ])
    );
    expect(depthThree.nodes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "projection:surface://editor"
        })
      ])
    );
  });

  it("rejects unsupported depth values above the truthful 1..3 contract", async () => {
    const { aggregator } = await createGraphContext();

    await expect(
      aggregator.buildSoulGraph({
        workspaceId: "workspace-1",
        depth: 4,
        limit: 50
      })
    ).rejects.toThrow("depth must be an integer between 1 and 3");
  });

  it("caps the graph deterministically and only returns edges between included nodes", async () => {
    const { aggregator } = await createGraphContext();

    const graph = await aggregator.buildSoulGraph({
      workspaceId: "workspace-1",
      depth: 2,
      limit: 3
    });

    expect(graph).toMatchObject({
      workspace_id: "workspace-1",
      truncated: true,
      node_total: 7,
      edge_total: 6
    });
    expect(graph.nodes).toEqual([
      expect.objectContaining({ id: `memory:${MEMORY_1_ID}` }),
      expect.objectContaining({ id: `memory:${MEMORY_2_ID}` }),
      expect.objectContaining({ id: "scope:project" })
    ]);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        id: `belongs_to:memory:${MEMORY_1_ID}:scope:project`,
        source_id: `memory:${MEMORY_1_ID}`,
        target_id: "scope:project"
      }),
      expect.objectContaining({
        id: `belongs_to:memory:${MEMORY_2_ID}:scope:project`,
        source_id: `memory:${MEMORY_2_ID}`,
        target_id: "scope:project"
      }),
      expect.objectContaining({
        id: "derived_from:memory-edge-1",
        source_id: `memory:${MEMORY_2_ID}`,
        target_id: `memory:${MEMORY_1_ID}`
      })
    ]);
  });

  it("keeps totals truthful when a workspace graph exceeds the one-hop neighbor cap", async () => {
    const {
      aggregator,
      bridgeEdgeId,
      memoryCount,
      memoryEdgeCount
    } = await createHighEdgeGraphContext();

    const graph = await aggregator.buildSoulGraph({
      workspaceId: "workspace-1",
      depth: 1,
      limit: 1000
    });

    expect(graph).toMatchObject({
      workspace_id: "workspace-1",
      truncated: false,
      node_total: memoryCount + 1,
      edge_total: memoryCount + memoryEdgeCount
    });
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `derived_from:${bridgeEdgeId}`
        })
      ])
    );
  });
});

async function createGraphContext(options?: {
  readonly additionalMemoryEdges?: readonly MemoryGraphEdge[];
}): Promise<{
  readonly aggregator: SoulGraphAggregator;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const edgeRepo = new SqliteMemoryGraphEdgeRepo(database);
  const signalRepo = new SqliteSignalRepo(database);
  const projectMappingRepo = new SqliteProjectMappingAnchorRepo(database);
  const globalMemoryRepo = new SqliteGlobalMemoryRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-2",
    workspace_id: "workspace-1",
    title: "run two",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  await memoryRepo.create(
    createMemoryEntry("workspace-1", "run-1", {
      object_id: MEMORY_1_ID,
      content: "Remember repo conventions"
    })
  );
  await memoryRepo.create(
    createMemoryEntry("workspace-1", "run-2", {
      object_id: MEMORY_2_ID,
      content: "Reuse the existing daemon route stack",
      created_at: "2026-04-23T00:01:00.000Z",
      updated_at: "2026-04-23T00:01:00.000Z"
    })
  );
  await edgeRepo.create(
    createMemoryGraphEdge({
      edge_id: "memory-edge-1",
      source_memory_id: MEMORY_2_ID,
      target_memory_id: MEMORY_1_ID,
      edge_type: "derives_from"
    })
  );
  for (const edge of options?.additionalMemoryEdges ?? []) {
    await edgeRepo.create(edge);
  }
  await signalRepo.create(
    createSignal("workspace-1", "run-1", {
      signal_id: "signal-1",
      scope_hint: ScopeClass.PROJECT,
      raw_payload: {
        source_memory_refs: [MEMORY_1_ID]
      }
    })
  );
  await signalRepo.create(
    createSignal("workspace-1", "run-2", {
      signal_id: "signal-2",
      scope_hint: null
    })
  );
  await globalMemoryRepo.upsert(
    createGlobalMemoryEntry({
      global_object_id: "global-memory-1",
      content: "Global workflow baseline"
    })
  );
  await globalMemoryRepo.upsert(
    createGlobalMemoryEntry({
      global_object_id: "global-memory-rejected",
      content: "Rejected global memory"
    })
  );
  await projectMappingRepo.create(
    createProjectMappingAnchor("workspace-1", "global-memory-1", {
      object_id: MAPPING_1_ID,
      mapping_state: ProjectMappingState.ACCEPTED,
      accepted_by: AcceptedBy.USER
    })
  );
  await projectMappingRepo.create(
    createProjectMappingAnchor("workspace-1", "global-memory-rejected", {
      object_id: MAPPING_2_ID,
      mapping_state: ProjectMappingState.REJECTED
    })
  );

  return {
    aggregator: new SoulGraphAggregator({
      memoryRepo,
      edgeRepo,
      runRepo,
      signalRepo,
      projectMappingRepo,
      globalMemoryRepo
    })
  };
}

async function createHighEdgeGraphContext(): Promise<{
  readonly aggregator: SoulGraphAggregator;
  readonly bridgeEdgeId: string;
  readonly memoryCount: number;
  readonly memoryEdgeCount: number;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const edgeRepo = new SqliteMemoryGraphEdgeRepo(database);
  const signalRepo = new SqliteSignalRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  const sourceMemoryAId = createFixtureObjectId(600);
  const sourceMemoryBId = createFixtureObjectId(601);
  const bridgeEdgeId = "edge-zz-bridge";
  const leafCount = 201;

  await memoryRepo.create(
    createMemoryEntry("workspace-1", "run-1", {
      object_id: sourceMemoryAId,
      content: "High degree source A"
    })
  );
  await memoryRepo.create(
    createMemoryEntry("workspace-1", "run-1", {
      object_id: sourceMemoryBId,
      content: "High degree source B"
    })
  );

  for (let index = 0; index < leafCount; index += 1) {
    const leafId = createFixtureObjectId(1000 + index);
    await memoryRepo.create(
      createMemoryEntry("workspace-1", "run-1", {
        object_id: leafId,
        content: `Leaf memory ${index}`
      })
    );
    await edgeRepo.create(
      createMemoryGraphEdge({
        edge_id: `edge-a-${index.toString().padStart(3, "0")}`,
        source_memory_id: sourceMemoryAId,
        target_memory_id: leafId
      })
    );
    await edgeRepo.create(
      createMemoryGraphEdge({
        edge_id: `edge-b-${index.toString().padStart(3, "0")}`,
        source_memory_id: sourceMemoryBId,
        target_memory_id: leafId
      })
    );
  }

  await edgeRepo.create(
    createMemoryGraphEdge({
      edge_id: bridgeEdgeId,
      source_memory_id: sourceMemoryAId,
      target_memory_id: sourceMemoryBId
    })
  );

  return {
    aggregator: new SoulGraphAggregator({
      memoryRepo,
      edgeRepo,
      runRepo,
      signalRepo
    }),
    bridgeEdgeId,
    memoryCount: leafCount + 2,
    memoryEdgeCount: leafCount * 2 + 1
  };
}

function createMemoryEntry(
  workspaceId: string,
  runId: string,
  overrides: Partial<MemoryEntry> = {}
): MemoryEntry {
  return {
    object_id: overrides.object_id ?? MEMORY_1_ID,
    object_kind: ObjectKind.MEMORY_ENTRY,
    schema_version: 1,
    lifecycle_state: "active",
    created_at: overrides.created_at ?? "2026-04-23T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-23T00:00:00.000Z",
    created_by: "system",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: overrides.source_kind ?? "user",
    formation_kind: overrides.formation_kind ?? "explicit",
    scope_class: overrides.scope_class ?? ScopeClass.PROJECT,
    content: overrides.content ?? "Project memory",
    domain_tags: overrides.domain_tags ?? [],
    evidence_refs: overrides.evidence_refs ?? [],
    workspace_id: workspaceId,
    run_id: runId,
    surface_id: overrides.surface_id ?? null,
    storage_tier: overrides.storage_tier ?? "hot",
    activation_score: overrides.activation_score ?? 0.5,
    retention_score: overrides.retention_score ?? null,
    manifestation_state: overrides.manifestation_state ?? null,
    retention_state: overrides.retention_state ?? null,
    decay_profile: overrides.decay_profile ?? null,
    confidence: overrides.confidence ?? null,
    last_used_at: overrides.last_used_at ?? null,
    last_hit_at: overrides.last_hit_at ?? null,
    reinforcement_count: overrides.reinforcement_count ?? null,
    contradiction_count: overrides.contradiction_count ?? null,
    superseded_by: overrides.superseded_by ?? null
  };
}

function createMemoryGraphEdge(overrides: Partial<MemoryGraphEdge> = {}): MemoryGraphEdge {
  return {
    edge_id: overrides.edge_id ?? "memory-edge-1",
    source_memory_id: overrides.source_memory_id ?? MEMORY_2_ID,
    target_memory_id: overrides.target_memory_id ?? MEMORY_1_ID,
    edge_type: overrides.edge_type ?? "derives_from",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    created_at: overrides.created_at ?? "2026-04-23T00:02:00.000Z"
  };
}

function createSignal(
  workspaceId: string,
  runId: string,
  overrides: Partial<CandidateMemorySignal> = {}
): CandidateMemorySignal {
  return {
    signal_id: overrides.signal_id ?? "signal-1",
    workspace_id: workspaceId,
    run_id: runId,
    surface_id: overrides.surface_id ?? null,
    source: overrides.source ?? "garden_compile",
    signal_kind: overrides.signal_kind ?? "potential_claim",
    signal_state: overrides.signal_state ?? "emitted",
    object_kind: overrides.object_kind ?? "candidate_memory_signal",
    scope_hint: overrides.scope_hint === undefined ? ScopeClass.PROJECT : overrides.scope_hint,
    domain_tags: overrides.domain_tags ?? ["workflow"],
    confidence: overrides.confidence ?? 0.8,
    evidence_refs: overrides.evidence_refs ?? [],
    raw_payload: overrides.raw_payload ?? {},
    created_at: overrides.created_at ?? "2026-04-23T00:03:00.000Z"
  };
}

function createGlobalMemoryEntry(overrides: Partial<GlobalMemoryEntry> = {}): GlobalMemoryEntry {
  return {
    global_object_id: overrides.global_object_id ?? "global-memory-1",
    object_kind: "global_memory_entry",
    canonical_identity: overrides.canonical_identity ?? "identity://global-memory-1",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    scope_class: overrides.scope_class ?? ScopeClass.GLOBAL_DOMAIN,
    content: overrides.content ?? "Global memory content",
    domain_tags: overrides.domain_tags ?? ["workflow"],
    provenance: overrides.provenance ?? "operator-curated",
    activation_score: overrides.activation_score ?? 0.9,
    version: overrides.version ?? 1,
    created_at: overrides.created_at ?? "2026-04-23T00:06:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-23T00:06:00.000Z"
  };
}

function createProjectMappingAnchor(
  workspaceId: string,
  globalObjectId: string,
  overrides: Partial<ProjectMappingAnchor> = {}
): ProjectMappingAnchor {
  return {
    object_id: overrides.object_id ?? MAPPING_1_ID,
    object_kind: ObjectKind.PROJECT_MAPPING_ANCHOR,
    schema_version: 1,
    lifecycle_state: "active",
    created_at: overrides.created_at ?? "2026-04-23T00:07:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-23T00:07:00.000Z",
    created_by: "system",
    global_object_id: globalObjectId,
    project_id: workspaceId,
    workspace_id: workspaceId,
    mapping_state: overrides.mapping_state ?? ProjectMappingState.ACCEPTED,
    accepted_by: overrides.accepted_by ?? null,
    last_transition_at: overrides.last_transition_at ?? "2026-04-23T00:07:00.000Z"
  };
}

function createFixtureObjectId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
