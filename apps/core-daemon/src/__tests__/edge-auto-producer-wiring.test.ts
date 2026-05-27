import { describe, expect, it } from "vitest";
import {
  CandidateMemorySignalSchema,
  MemoryDimension,
  MemoryGraphEdgeType,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type EventLogEntry,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  EdgeAutoProducerService,
  EdgeProposalService,
  EventPublisher,
  EvidenceService,
  MemoryService
} from "@do-soul/alaya-core";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  type GraphEdgeCreationPort
} from "@do-soul/alaya-soul";
import {
  SqliteEdgeProposalRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteMemoryGraphEdgeRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";

const OLD_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NEW_MEMORY_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";

describe("edge auto producer daemon wiring", () => {
  it("emits llm_supports trigger when an LLM port is wired and clears the 0.85 floor", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      const memoryGraphEdgeRepo = new SqliteMemoryGraphEdgeRepo(database);
      const edgeProposalRepo = new SqliteEdgeProposalRepo(database);
      const runtimeNotifier = {
        notify: async () => undefined,
        notifyEntry: async (_entry: EventLogEntry) => undefined
      };
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: async () => undefined },
        runtimeNotifier
      });

      await seedWorkspaceRun(workspaceRepo, runRepo);
      await memoryRepo.create(
        createMemoryEntry({
          object_id: OLD_MEMORY_ID,
          content: "Repository shell commands must use the RTK wrapper.",
          domain_tags: ["rtk", "workflow"],
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z"
        })
      );

      let edgeId = 0;
      const edgeProposalService = new EdgeProposalService({
        memoryRepo,
        proposalRepo: edgeProposalRepo,
        graphPort: memoryGraphEdgeRepo,
        eventPublisher,
        generateId: () => `edge-${++edgeId}`,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const graphEdgePort: GraphEdgeCreationPort = {
        createEdge: async (params) => {
          await edgeProposalService.proposeEdge(params);
        }
      };
      const edgeAutoProducerService = new EdgeAutoProducerService({
        memoryRepo,
        graphEdgePort,
        llmPort: {
          classifyPair: async () => ({
            edgeType: "supports",
            confidence: 0.92,
            rationale: "test pair classifier verdict"
          })
        }
      });
      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: evidenceRepo,
        eventLogRepo,
        runtimeNotifier,
        generateObjectId: () => EVIDENCE_ID,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const memoryService = new MemoryService({
        memoryEntryRepo: memoryRepo,
        evidenceService,
        eventLogRepo,
        runtimeNotifier,
        generateObjectId: () => NEW_MEMORY_ID,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const router = new MaterializationRouter({
        evidenceService,
        memoryService,
        synthesisService: {
          create: async () => ({ object_kind: "synthesis_capsule", object_id: "synthesis-1" })
        },
        claimService: {
          create: async () => ({ object_kind: "claim_form", object_id: "claim-1" })
        },
        graphEdgePort,
        edgeAutoProducerPort: edgeAutoProducerService,
        handoffGapHandler: new InMemoryHandoffGapHandler()
      });

      const result = await router.materializeSignal(createFactSignal());

      expect(result.success).toBe(true);
      // confidence 0.92 >= AUTO_ACCEPT_FLOOR_BY_TRIGGER[LLM_SUPPORTS]=0.85,
      // so the proposal auto-accepts and the durable edge is written. The
      // proposal row stays under the auto_accepted status (visible to KPI
      // via findById, hidden from listPending which filters status=pending).
      const proposal = edgeProposalRepo.findById("edge_prop_edge-1");
      expect(proposal).not.toBeNull();
      expect(proposal!).toMatchObject({
        source_memory_id: NEW_MEMORY_ID,
        target_memory_id: OLD_MEMORY_ID,
        edge_type: MemoryGraphEdgeType.SUPPORTS,
        trigger_source: "llm_supports",
        status: "auto_accepted"
      });
      await expect(
        memoryGraphEdgeRepo.findBySourceAndTarget(
          NEW_MEMORY_ID,
          OLD_MEMORY_ID,
          MemoryGraphEdgeType.SUPPORTS,
          "workspace-1"
        )
      ).resolves.toMatchObject({
        source_memory_id: NEW_MEMORY_ID,
        target_memory_id: OLD_MEMORY_ID,
        edge_type: MemoryGraphEdgeType.SUPPORTS
      });
    } finally {
      database.close();
    }
  });

  it("materialization creates pending edge proposals, not durable graph edges, until review accept", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      const memoryGraphEdgeRepo = new SqliteMemoryGraphEdgeRepo(database);
      const edgeProposalRepo = new SqliteEdgeProposalRepo(database);
      const runtimeNotifier = {
        notify: async () => undefined,
        notifyEntry: async (_entry: EventLogEntry) => undefined
      };
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: async () => undefined },
        runtimeNotifier
      });

      await seedWorkspaceRun(workspaceRepo, runRepo);
      await memoryRepo.create(
        createMemoryEntry({
          object_id: OLD_MEMORY_ID,
          content: "Repository shell commands must use the RTK wrapper.",
          domain_tags: ["rtk", "workflow"],
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z"
        })
      );

      let edgeId = 0;
      const edgeProposalService = new EdgeProposalService({
        memoryRepo,
        proposalRepo: edgeProposalRepo,
        graphPort: memoryGraphEdgeRepo,
        eventPublisher,
        generateId: () => `edge-${++edgeId}`,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const graphEdgePort: GraphEdgeCreationPort = {
        createEdge: async (params) => {
          await edgeProposalService.proposeEdge(params);
        }
      };
      const edgeAutoProducerService = new EdgeAutoProducerService({
        memoryRepo,
        graphEdgePort
      });
      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: evidenceRepo,
        eventLogRepo,
        runtimeNotifier,
        generateObjectId: () => EVIDENCE_ID,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const memoryService = new MemoryService({
        memoryEntryRepo: memoryRepo,
        evidenceService,
        eventLogRepo,
        runtimeNotifier,
        generateObjectId: () => NEW_MEMORY_ID,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const router = new MaterializationRouter({
        evidenceService,
        memoryService,
        synthesisService: {
          create: async () => ({ object_kind: "synthesis_capsule", object_id: "synthesis-1" })
        },
        claimService: {
          create: async () => ({ object_kind: "claim_form", object_id: "claim-1" })
        },
        graphEdgePort,
        edgeAutoProducerPort: edgeAutoProducerService,
        handoffGapHandler: new InMemoryHandoffGapHandler()
      });

      const result = await router.materializeSignal(createFactSignal());

      expect(result.success).toBe(true);
      const pending = edgeProposalRepo.listPending("workspace-1");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        source_memory_id: NEW_MEMORY_ID,
        target_memory_id: OLD_MEMORY_ID,
        edge_type: MemoryGraphEdgeType.SUPPORTS,
        status: "pending"
      });
      await expect(
        memoryGraphEdgeRepo.findBySourceAndTarget(
          NEW_MEMORY_ID,
          OLD_MEMORY_ID,
          MemoryGraphEdgeType.SUPPORTS,
          "workspace-1"
        )
      ).resolves.toBeNull();

      await edgeProposalService.batchReview({
        workspaceId: "workspace-1",
        verdict: "accept",
        filter: { proposal_ids: [pending[0].proposal_id] },
        reason: "integration accept",
        reviewerIdentity: "test-reviewer"
      });

      await expect(
        memoryGraphEdgeRepo.findBySourceAndTarget(
          NEW_MEMORY_ID,
          OLD_MEMORY_ID,
          MemoryGraphEdgeType.SUPPORTS,
          "workspace-1"
        )
      ).resolves.toMatchObject({
        source_memory_id: NEW_MEMORY_ID,
        target_memory_id: OLD_MEMORY_ID,
        edge_type: MemoryGraphEdgeType.SUPPORTS
      });
    } finally {
      database.close();
    }
  });
});

async function seedWorkspaceRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace-1",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run-1",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function createFactSignal(): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "triaged",
    object_kind: "fact",
    scope_hint: ScopeClass.PROJECT,
    domain_tags: ["rtk", "workflow"],
    confidence: 0.8,
    evidence_refs: [],
    raw_payload: {
      excerpt: "RTK wrapper is required for shell commands in this repository.",
      distilled_fact: "RTK wrapper is required for shell commands in this repository."
    },
    created_at: "2026-05-25T00:00:00.000Z"
  });
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: OLD_MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z",
    created_by: "test",
    dimension: MemoryDimension.FACT,
    source_kind: "compiler",
    formation_kind: "extracted",
    scope_class: ScopeClass.PROJECT,
    content: "Repository shell commands must use the RTK wrapper.",
    domain_tags: ["rtk", "workflow"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
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
