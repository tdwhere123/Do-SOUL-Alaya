import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type MemoryGraphEdge
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteMemoryGraphEdgeRepo } from "../repos/memory-graph-edge-repo.js";
import { SqliteMemoryEntryRepo } from "../repos/memory-entry-repo.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "7f7204d1-96e0-4ad0-bc85-ec8322bcd4ac",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["tooling"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: null,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function createMemoryId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function createGraphEdge(overrides: Partial<MemoryGraphEdge> = {}): MemoryGraphEdge {
  return {
    edge_id: "edge-1",
    source_memory_id: createMemoryId(1),
    target_memory_id: createMemoryId(2),
    edge_type: "supports",
    workspace_id: "workspace-1",
    created_at: "2026-03-28T00:00:00.000Z",
    ...overrides
  };
}

async function createMemory(
  memoryRepo: SqliteMemoryEntryRepo,
  objectId: string,
  runId = "run-1"
): Promise<void> {
  await memoryRepo.create(createMemoryEntry({ object_id: objectId, run_id: runId }));
}

describe("SqliteMemoryGraphEdgeRepo", () => {
  it("creates graph edges and finds one-hop neighbors by memory id", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteMemoryGraphEdgeRepo(database);
    const sourceMemoryId = createMemoryId(1);
    const outboundTargetMemoryId = createMemoryId(2);
    const inboundSourceMemoryId = createMemoryId(3);

    await createMemory(memoryRepo, sourceMemoryId);
    await createMemory(memoryRepo, outboundTargetMemoryId, "run-2");
    await createMemory(memoryRepo, inboundSourceMemoryId, "run-2");

    const outbound = createGraphEdge({
      edge_id: "edge-1",
      source_memory_id: sourceMemoryId,
      target_memory_id: outboundTargetMemoryId,
      created_at: "2026-03-28T00:00:00.000Z"
    });
    const inbound = createGraphEdge({
      edge_id: "edge-2",
      source_memory_id: inboundSourceMemoryId,
      target_memory_id: sourceMemoryId,
      edge_type: "recalls",
      created_at: "2026-03-28T00:00:01.000Z"
    });

    expect(repo.create(outbound)).toEqual(outbound);
    expect(repo.create(inbound)).toEqual(inbound);
    await expect(repo.findById("edge-1")).resolves.toEqual(outbound);
    await expect(repo.findByMemoryId(sourceMemoryId, "workspace-1")).resolves.toEqual([
      outbound,
      inbound
    ]);

    await repo.delete("edge-1");
    await expect(repo.findById("edge-1")).resolves.toBeNull();
    await expect(repo.findByMemoryId(sourceMemoryId, "workspace-1")).resolves.toEqual([inbound]);
  });

  it("finds edges by source and target and counts inbound supports", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteMemoryGraphEdgeRepo(database);
    const sourceMemoryId = createMemoryId(10);
    const targetMemoryId = createMemoryId(11);
    const secondSourceMemoryId = createMemoryId(12);
    const otherTargetMemoryId = createMemoryId(13);

    await createMemory(memoryRepo, sourceMemoryId);
    await createMemory(memoryRepo, targetMemoryId, "run-2");
    await createMemory(memoryRepo, secondSourceMemoryId);
    await createMemory(memoryRepo, otherTargetMemoryId, "run-2");

    const supportEdge = createGraphEdge({
      edge_id: "edge-support-1",
      source_memory_id: sourceMemoryId,
      target_memory_id: targetMemoryId
    });
    const recallEdge = createGraphEdge({
      edge_id: "edge-recall-1",
      source_memory_id: sourceMemoryId,
      target_memory_id: targetMemoryId,
      edge_type: "recalls",
      created_at: "2026-03-28T00:00:01.000Z"
    });
    const secondSupportEdge = createGraphEdge({
      edge_id: "edge-support-2",
      source_memory_id: secondSourceMemoryId,
      target_memory_id: targetMemoryId,
      created_at: "2026-03-28T00:00:02.000Z"
    });
    const unrelatedSupportEdge = createGraphEdge({
      edge_id: "edge-support-3",
      source_memory_id: secondSourceMemoryId,
      target_memory_id: otherTargetMemoryId,
      created_at: "2026-03-28T00:00:03.000Z"
    });

    await repo.create(supportEdge);
    await repo.create(recallEdge);
    await repo.create(secondSupportEdge);
    await repo.create(unrelatedSupportEdge);

    await expect(
      repo.findBySourceAndTarget(sourceMemoryId, targetMemoryId, "supports", "workspace-1")
    ).resolves.toEqual(supportEdge);
    await expect(
      repo.findBySourceAndTarget(sourceMemoryId, otherTargetMemoryId, "supports", "workspace-1")
    ).resolves.toBeNull();
    await expect(repo.countInboundSupports(targetMemoryId, "workspace-1")).resolves.toBe(2);
    await expect(repo.countInboundSupports(sourceMemoryId, "workspace-1")).resolves.toBe(0);
  });

  it("countInboundEdgesWeighted sums by edge_type weight (supports=1, derives_from=0.5, recalls=0.3, supersedes=-0.5, contradicts=-0.4, incompatible_with=-0.3, exception_to=0)", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteMemoryGraphEdgeRepo(database);
    const targetId = createMemoryId(20);
    const srcA = createMemoryId(21);
    const srcB = createMemoryId(22);
    const srcC = createMemoryId(23);
    const srcD = createMemoryId(24);
    const srcE = createMemoryId(25);
    const outsideTargetId = createMemoryId(26);

    await createMemory(memoryRepo, targetId);
    await createMemory(memoryRepo, srcA);
    await createMemory(memoryRepo, srcB);
    await createMemory(memoryRepo, srcC);
    await createMemory(memoryRepo, srcD);
    await createMemory(memoryRepo, srcE);
    await createMemory(memoryRepo, outsideTargetId);

    // 2 × supports → +2.0
    await repo.create(createGraphEdge({
      edge_id: "wedge-sup-1",
      source_memory_id: srcA,
      target_memory_id: targetId,
      edge_type: "supports",
      created_at: "2026-04-01T00:00:00.000Z"
    }));
    await repo.create(createGraphEdge({
      edge_id: "wedge-sup-2",
      source_memory_id: srcB,
      target_memory_id: targetId,
      edge_type: "supports",
      created_at: "2026-04-01T00:00:01.000Z"
    }));
    // 1 × derives_from → +0.5
    await repo.create(createGraphEdge({
      edge_id: "wedge-derives-1",
      source_memory_id: srcC,
      target_memory_id: targetId,
      edge_type: "derives_from",
      created_at: "2026-04-01T00:00:02.000Z"
    }));
    // 2 × recalls → +0.6
    await repo.create(createGraphEdge({
      edge_id: "wedge-rec-1",
      source_memory_id: srcD,
      target_memory_id: targetId,
      edge_type: "recalls",
      created_at: "2026-04-01T00:00:03.000Z"
    }));
    await repo.create(createGraphEdge({
      edge_id: "wedge-rec-2",
      source_memory_id: srcE,
      target_memory_id: targetId,
      edge_type: "recalls",
      created_at: "2026-04-01T00:00:04.000Z"
    }));
    // 1 × supersedes → -0.5
    await repo.create(createGraphEdge({
      edge_id: "wedge-sup-by-1",
      source_memory_id: srcA,
      target_memory_id: targetId,
      edge_type: "supersedes",
      created_at: "2026-04-01T00:00:05.000Z"
    }));
    // 1 × contradicts → -0.4
    await repo.create(createGraphEdge({
      edge_id: "wedge-contra-1",
      source_memory_id: srcA,
      target_memory_id: targetId,
      edge_type: "contradicts",
      created_at: "2026-04-01T00:00:06.000Z"
    }));
    // outbound edge → not counted as inbound
    await repo.create(createGraphEdge({
      edge_id: "wedge-out-1",
      source_memory_id: targetId,
      target_memory_id: outsideTargetId,
      edge_type: "supports",
      created_at: "2026-04-01T00:00:07.000Z"
    }));

    // 2.0 + 0.5 + 0.6 - 0.5 - 0.4 = 2.2
    await expect(repo.countInboundEdgesWeighted(targetId, "workspace-1")).resolves.toBeCloseTo(2.2, 10);
    await expect(repo.countInboundRecalls(targetId, "workspace-1")).resolves.toBe(2);
    // outsideTargetId has one inbound supports edge (wedge-out-1) → 1.0
    await expect(repo.countInboundEdgesWeighted(outsideTargetId, "workspace-1")).resolves.toBeCloseTo(1.0, 10);
    await expect(repo.countInboundRecalls(outsideTargetId, "workspace-1")).resolves.toBe(0);
    // wrong workspace → 0
    await expect(repo.countInboundEdgesWeighted(targetId, "workspace-other")).resolves.toBe(0);
    await expect(repo.countInboundRecalls(targetId, "workspace-other")).resolves.toBe(0);
  });

  it("limits neighbor lists to 200 edges with deterministic ordering", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteMemoryGraphEdgeRepo(database);
    const sourceMemoryId = createMemoryId(100);
    const expectedEdgeIds = Array.from({ length: 200 }, (_, index) => `edge-${index.toString().padStart(3, "0")}`);

    await createMemory(memoryRepo, sourceMemoryId);

    for (let index = 0; index < 201; index += 1) {
      const targetMemoryId = createMemoryId(1000 + index);
      await createMemory(memoryRepo, targetMemoryId, "run-2");
      await repo.create(
        createGraphEdge({
          edge_id: `edge-${index.toString().padStart(3, "0")}`,
          source_memory_id: sourceMemoryId,
          target_memory_id: targetMemoryId
        })
      );
    }

    const edges = await repo.findByMemoryId(sourceMemoryId, "workspace-1");
    expect(edges).toHaveLength(200);
    expect(edges.map((edge) => edge.edge_id)).toEqual(expectedEdgeIds);
  });

  it("lists all workspace edges without the one-hop 200-edge cap", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteMemoryGraphEdgeRepo(database);
    const sourceMemoryAId = createMemoryId(200);
    const sourceMemoryBId = createMemoryId(201);
    const bridgeEdgeId = "edge-zz-bridge";
    const leafCount = 201;

    await createMemory(memoryRepo, sourceMemoryAId);
    await createMemory(memoryRepo, sourceMemoryBId);

    for (let index = 0; index < leafCount; index += 1) {
      const targetMemoryId = createMemoryId(3000 + index);
      await createMemory(memoryRepo, targetMemoryId, "run-2");
      await repo.create(
        createGraphEdge({
          edge_id: `edge-a-${index.toString().padStart(3, "0")}`,
          source_memory_id: sourceMemoryAId,
          target_memory_id: targetMemoryId
        })
      );
      await repo.create(
        createGraphEdge({
          edge_id: `edge-b-${index.toString().padStart(3, "0")}`,
          source_memory_id: sourceMemoryBId,
          target_memory_id: targetMemoryId
        })
      );
    }

    await repo.create(
      createGraphEdge({
        edge_id: bridgeEdgeId,
        source_memory_id: sourceMemoryAId,
        target_memory_id: sourceMemoryBId
      })
    );

    const edges = await repo.findByWorkspace("workspace-1");
    expect(edges).toHaveLength(leafCount * 2 + 1);
    expect(edges.at(-1)?.edge_id).toBe(bridgeEdgeId);
  });

  it("rejects edges whose parent memories do not exist", async () => {
    const { database } = await createRepo();
    const repo = new SqliteMemoryGraphEdgeRepo(database);

    expect(() =>
      repo.create(
        createGraphEdge({
          edge_id: "edge-missing-parent",
          source_memory_id: createMemoryId(900),
          target_memory_id: createMemoryId(901)
        })
      )
    ).toThrowError(
      expect.objectContaining({
        name: "StorageError",
        code: "QUERY_FAILED"
      }) as unknown as Error
    );
  });

  it("cascades edge deletion when a parent memory is removed", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteMemoryGraphEdgeRepo(database);
    const sourceMemoryId = createMemoryId(910);
    const targetMemoryId = createMemoryId(911);

    await createMemory(memoryRepo, sourceMemoryId);
    await createMemory(memoryRepo, targetMemoryId, "run-2");
    await repo.create(
      createGraphEdge({
        edge_id: "edge-cascade",
        source_memory_id: sourceMemoryId,
        target_memory_id: targetMemoryId
      })
    );

    database.connection.prepare("DELETE FROM memory_entries WHERE object_id = ?").run(targetMemoryId);

    await expect(repo.findById("edge-cascade")).resolves.toBeNull();
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly memoryRepo: SqliteMemoryEntryRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);

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

  return { database, memoryRepo };
}
