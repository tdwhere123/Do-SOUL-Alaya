import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EdgeProposalService,
  EventPublisher,
  MemoryService,
  PathRelationProposalService,
  type RuntimeNotifier
} from "@do-soul/alaya-core";

import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  RuntimeGovernanceEventType,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type RecallCandidate
} from "@do-soul/alaya-protocol";

import {
  initDatabase,
  SqliteCoUsageCounterRepo,
  SqliteEdgeProposalRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

import { createMcpMemoryToolHandler } from "../../mcp-memory/tool-handler.js";

import { createTrustStateRecorder } from "../../trust/state.js";

const databases = new Set<StorageDatabase>();

const MEM_A = "11111111-aaaa-4aaa-8aaa-000000000001";

const MEM_B = "11111111-aaaa-4aaa-8aaa-000000000002";

const MEM_C = "11111111-aaaa-4aaa-8aaa-000000000003";

async function createHarness(
  memoryIds: readonly string[],
  options: {
    readonly realEdgeProposals?: boolean;
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
    readonly recallCandidateIds?: readonly string[];
    readonly pathRelationProposalService?: {
      onCoUsage(usedObjectIds: readonly string[], workspaceId: string): Promise<void>;
      onCoRecall(
        recalledObjectIds: readonly string[],
        workspaceId: string,
        allowedPairKeys?: ReadonlySet<string>
      ): Promise<void>;
    };
    readonly coRecallCoherenceGate?: {
      coherentPairKeys(
        workspaceId: string,
        deliveredObjectIds: readonly string[]
      ): Promise<ReadonlySet<string>>;
    };
  } = {}
) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const edgeProposalRepo = new SqliteEdgeProposalRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const pathRelationRepo = new SqlitePathRelationRepo(database);
  const coUsageCounterRepo = new SqliteCoUsageCounterRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const trustStateRepo = new SqliteTrustStateRepo(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const notifyEntry = vi.fn();
  const runtimeNotifier: RuntimeNotifier = {
    notify: () => {},
    notifyEntry
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });
  const trustStateRecorder = createTrustStateRecorder({
    eventPublisher,
    repo: trustStateRepo,
    ready: true,
    clock: () => "2026-05-07T00:00:00.000Z"
  });
  const memoryService = new MemoryService({
    memoryEntryRepo,
    evidenceService: { findById: async () => ({ object_id: "evidence-1" }) },
    eventLogRepo,
    runtimeNotifier,
    now: () => "2026-05-07T00:00:00.000Z"
  });

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/workspace-1",
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

  for (const id of memoryIds) {
    await memoryEntryRepo.create(createMemoryEntry(id));
  }
  await trustStateRecorder.recordDelivery({
    delivery_id: "delivery-cross-link",
    agent_target: "codex",
    workspace_id: "workspace-1",
    run_id: "run-1",
    delivered_object_ids: memoryIds,
    delivered_at: "2026-05-07T00:00:00.000Z"
  });

  let edgeCounter = 0;
  // invariant: accept mints a governed PathRelation via the real path service
  // (not memory_graph_edges). The path service dedups + governance-clamps.
  const pathRelationProposalService = new PathRelationProposalService({
    repo: {
      create: (relation) => pathRelationRepo.create(relation),
      findByAnchorMemoryId: async (memoryId, workspaceId) =>
        await pathRelationRepo.findByAnchors(workspaceId, [{ kind: "object", object_id: memoryId }])
    },
    counterStore: coUsageCounterRepo,
    eventPublisher,
    generateId: () => `00000000-0000-4000-9000-${(++edgeCounter).toString().padStart(12, "0")}`
  });
  const edgeProposalService = new EdgeProposalService({
    memoryRepo: memoryEntryRepo,
    proposalRepo: edgeProposalRepo,
    pathCandidatePort: {
      submitCandidate: async (input) => await pathRelationProposalService.submitCandidate(input)
    },
    eventPublisher,
    now: () => "2026-05-07T00:00:01.000Z",
    generateId: () => `00000000-0000-4000-8000-${(++edgeCounter).toString().padStart(12, "0")}`
  });

  const graphEdgePort = {
    createEdge: vi.fn(async (params: Parameters<typeof edgeProposalService.proposeEdge>[0]) => {
      if (options.realEdgeProposals === true) {
        await edgeProposalService.proposeEdge(params);
      }
    })
  };

  const handler = createMcpMemoryToolHandler({
    recallService: {
      recall: vi.fn(async () => ({
        candidates: (options.recallCandidateIds ?? []).map((objectId) => createRecallCandidate(objectId)),
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      }))
    },
    memoryService: {
      findById: memoryService.findById.bind(memoryService),
      findByIdScoped: memoryService.findByIdScoped.bind(memoryService),
      update: memoryService.update.bind(memoryService),
      validateUpdate: memoryService.validateUpdate.bind(memoryService)
    },
    signalService: {
      receiveSignal: vi.fn(async (signal) => ({ signal }))
    },
    graphExploreService: {
      exploreOneHop: vi.fn(async () => [])
    },
    edgeProposalService,
    graphEdgePort,
    ...(options.pathRelationProposalService === undefined
      ? {}
      : { pathRelationProposalService: options.pathRelationProposalService }),
    ...(options.coRecallCoherenceGate === undefined
      ? {}
      : { coRecallCoherenceGate: options.coRecallCoherenceGate }),
    sessionOverrideService: {
      apply: vi.fn(async () => ({ runtime_id: "override-1" }))
    },
    trustStateRecorder,
    eventPublisher,
    asyncSideEffectAudit: { eventLogRepo, runtimeNotifier },
    memoryEntryRepo,
    now: () => "2026-05-07T00:00:01.000Z",
    generateId: () => "00000000-0000-4000-8000-000000000001",
    ...(options.warn === undefined ? {} : { warn: options.warn })
  });

  return {
    edgeProposalRepo,
    eventLogRepo,
    graphEdgePort,
    runtimeNotifier,
    pathRelationRepo,
    handler,
    memoryEntryRepo
  };
}

type ReportHarness = Pick<Awaited<ReturnType<typeof createHarness>>, "handler">;

async function reportUsed(
  harness: ReportHarness,
  usedObjectIds: readonly string[]
) {
  return await reportUsage(harness, "used", usedObjectIds);
}

async function reportUsage(
  harness: ReportHarness,
  usageState: "used" | "skipped" | "not_applicable",
  usedObjectIds: readonly string[]
) {
  return await harness.handler.call({
    toolName: "soul.report_context_usage",
    arguments: {
      delivery_id: "delivery-cross-link",
      usage_state: usageState,
      used_object_ids: usedObjectIds,
      reason: "cross-link test"
    },
    context: {
      workspaceId: "workspace-1",
      runId: "run-1",
      agentTarget: "cli",
      sessionId: "recall-cross-link-session"
    }
  });
}

function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-07T00:00:00.000Z",
    updated_at: "2026-05-07T00:00:00.000Z",
    created_by: "recall-cross-link-test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: `seed memory ${objectId}`,
    domain_tags: ["recall"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.5,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}

function createRecallCandidate(objectId: string): RecallCandidate {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    activation_score: 0.5,
    relevance_score: 0.8,
    content_preview: `seed memory ${objectId}`,
    token_estimate: 8,
    manifestation: "excerpt",
    dimension: MemoryDimension.PREFERENCE,
    scope_class: ScopeClass.PROJECT,
    origin_plane: "workspace_local"
  };
}

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("recall cross-link: report_context_usage(used) proposes RECALLS edges", () => {

  it("keeps RECALLS proposals pending until explicit accept mints a governed path relation", async () => {
    const harness = await createHarness([MEM_A, MEM_B, MEM_C], { realEdgeProposals: true });

    await reportUsed(harness, [MEM_A, MEM_B]);

    // Proposals are pending; no path minted yet.
    expect(await harness.pathRelationRepo.findByWorkspace("workspace-1")).toEqual([]);
    expect(harness.edgeProposalRepo.listPending("workspace-1").map((proposal) => ({
      source: proposal.source_memory_id,
      target: proposal.target_memory_id,
      edgeType: proposal.edge_type,
      triggerSource: proposal.trigger_source
    }))).toEqual(
      expect.arrayContaining([
        { source: MEM_A, target: MEM_B, edgeType: "recalls", triggerSource: "recall_cross_link" },
        { source: MEM_B, target: MEM_A, edgeType: "recalls", triggerSource: "recall_cross_link" }
      ])
    );

    const reviewResult = await harness.handler.call({
      toolName: "soul.batch_review_edge_proposals",
      arguments: {
        verdict: "accept",
        filter: { edge_type: "recalls" },
        reason: "accept recall cross-links",
        reviewer_identity: "user:reviewer"
      },
      context: {
        workspaceId: "workspace-1",
        runId: "run-1",
        agentTarget: "cli",
        sessionId: "recall-cross-link-session"
      }
    });
    expect(reviewResult).toMatchObject({ ok: true });

    // invariant (accept->path, DB-level): accept mints governed path relations.
    // A->B and B->A dedup to one undirected path.
    const paths = await harness.pathRelationRepo.findByWorkspace("workspace-1");
    expect(paths.length).toBeGreaterThanOrEqual(1);
    for (const path of paths) {
      expect(path.constitution.relation_kind).toBe("recalls");
      expect(path.legitimacy.governance_class).toBe("recall_allowed");
      expect(path.effect_vector.recall_bias).toBeGreaterThan(0);
    }
    const pathEndpoints = paths.map((path) => {
      const source = path.anchors.source_anchor;
      const target = path.anchors.target_anchor;
      return {
        source: source.kind === "object" ? source.object_id : null,
        target: target.kind === "object" ? target.object_id : null
      };
    });
    expect(pathEndpoints).toEqual(
      expect.arrayContaining([{ source: MEM_A, target: MEM_B }])
    );
    expect(harness.edgeProposalRepo.listPending("workspace-1")).toEqual([]);
  });

  it("never fails the report when the graph edge port throws", async () => {
    const harness = await createHarness([MEM_A, MEM_B]);
    harness.graphEdgePort.createEdge.mockRejectedValueOnce(new Error("edge db down"));

    // Must still resolve OK — graph proposals are supplementary, not load-bearing.
    const result = await reportUsed(harness, [MEM_A, MEM_B]);

    expect(result).toMatchObject({ ok: true });
  });
});
