import { describe, expect, it, vi } from "vitest";
import {
  CandidateMemorySignalSchema,
  DYNAMICS_CONSTANTS,
  MemoryDimension,
  RuntimeGardenComputeConfigSchema,
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
  EventPublisher,
  EvidenceService,
  MemoryService,
  PreWriteRecallService,
  ReconciliationService,
  createRuleOnlyReconciliationDecisionPort
} from "@do-soul/alaya-core";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter
} from "@do-soul/alaya-soul";
import {
  SqliteEnrichPendingRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteReconciliationLeaseRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";
import { createEdgeAndReconciliationRuntime } from "../../runtime/recall-materialization-edge-reconciliation.js";

const OLD_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NEW_MEMORY_ID = "22222222-2222-4222-8222-222222222222";
const CONFLICT_MEMORY_ID = "33333333-3333-4333-8333-333333333333";
const EVIDENCE_ID = "44444444-4444-4444-8444-444444444444";

// invariant: Garden heuristics can nominate relations but cannot establish
// evidence plus a trusted source EventLog anchor. The background drain must
// reject those nominations rather than write the legacy projection.
describe("edge auto producer daemon wiring", () => {
  it.each([
    ["fresh default", undefined],
    ["preselected temporal projection", true]
  ] as const)("keeps BULK_ENRICH candidates out of legacy path_relations for %s", async (_mode, temporalProjectionSelected) => {
    const database = initDatabase({ filename: ":memory:" });
    const previousEdgeClassifyHostWorker = process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER;
    const previousIngestReconciliation = process.env.ALAYA_INGEST_RECONCILIATION_ENABLED;
    process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER = "false";
    process.env.ALAYA_INGEST_RECONCILIATION_ENABLED = "false";
    try {
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const enrichPendingRepo = new SqliteEnrichPendingRepo(database);
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
          content: "Production deployment requires signed artifact promotion.",
          domain_tags: ["rtk", "workflow"],
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z"
        })
      );
      await memoryRepo.create(
        createMemoryEntry({
          object_id: CONFLICT_MEMORY_ID,
          content: "Repository shell commands must use the RTK wrapper.",
          domain_tags: ["rtk", "workflow"],
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z"
        })
      );
      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: evidenceRepo,
        eventLogRepo,
        runtimeNotifier,
        generateObjectId: () => EVIDENCE_ID,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      // invariant: mirrors the daemon composition root — the atomic create +
      // enrich_pending marker (enrichPendingWriter) + the router's
      // enrichmentEnqueued-reporting adapter, so the marker commits inside the
      // memory-row transaction and the router skips its loud fallback.
      const enqueueEnrichPending = (params: {
        readonly workspaceId: string;
        readonly memoryId: string;
        readonly runId: string | null;
        readonly sourceSignalId: string | null;
      }): void =>
        enrichPendingRepo.enqueue({
          workspaceId: params.workspaceId,
          memoryId: params.memoryId,
          runId: params.runId,
          sourceSignalId: params.sourceSignalId,
          enqueuedAt: "2026-05-25T00:00:01.000Z"
        });
      const memoryService = new MemoryService({
        memoryEntryRepo: memoryRepo,
        evidenceService,
        eventLogRepo,
        runtimeNotifier,
        enrichPendingWriter: { enqueue: enqueueEnrichPending },
        generateObjectId: () => NEW_MEMORY_ID,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const warn = vi.fn();
      const edgeRuntime = await createEdgeAndReconciliationRuntime({
        eventLogRepo,
        memoryEntryRepo: memoryRepo,
        memoryService,
        pathRelationRepo,
        rawConfigService: {
          getRuntimeGardenComputeConfig: async () =>
            RuntimeGardenComputeConfigSchema.parse({
              config_version: 1,
              provider_kind: "local_heuristics",
              model_id: null,
              provider_url: null,
              secret_ref: null,
              enabled: false
            })
        },
        reconciliationLeaseRepo: new SqliteReconciliationLeaseRepo(database),
        runLookup: runRepo,
        ...(temporalProjectionSelected === undefined ? {} : { temporalProjectionSelected }),
        warn
      });
      const router = new MaterializationRouter({
        evidenceService,
        memoryService: {
          create: async (input) => {
            const created = await memoryService.create(input);
            return {
              object_kind: created.object_kind,
              object_id: created.object_id,
              enrichmentEnqueued: input.enqueueEnrichment !== undefined
            };
          }
        },
        synthesisService: {
          create: async () => ({ object_kind: "synthesis_capsule", object_id: "synthesis-1" })
        },
        claimService: {
          create: async () => ({ object_kind: "claim_form", object_id: "claim-1" })
        },
        enrichPendingPort: { enqueue: enqueueEnrichPending },
        handoffGapHandler: new InMemoryHandoffGapHandler()
      });

      const result = await router.materializeSignal(createFactSignal({
        excerpt: "Production deployment requires signed artifact promotion.",
        distilled_fact: "Production deployment requires signed artifact promotion."
      }));

      expect(result.success).toBe(true);

      // The write-path enqueued a durable enrich_pending marker and ran no
      // edge production inline.
      expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
      expect(
        (await pathRelationRepo.findByAnchors("workspace-1", [
          { kind: "object", object_id: NEW_MEMORY_ID }
        ])).find((relation) => relation.constitution.relation_kind === "supports")
      ).toBeUndefined();

      // The BULK_ENRICH worker drains the marker and reaches both background
      // producers. Each nomination is permanently rejected at the daemon
      // boundary because neither producer can admit a temporal assertion.
      const claimed = enrichPendingRepo.claimBatch(
        "workspace-1",
        50,
        "2026-05-25T00:01:00.000Z",
        DYNAMICS_CONSTANTS.enrich.max_attempts
      );
      expect(claimed.map((entry) => entry.memoryId)).toEqual([NEW_MEMORY_ID]);
      for (const entry of claimed) {
        const memory = await memoryRepo.findById(entry.memoryId);
        expect(memory).not.toBeNull();
        await edgeRuntime.edgeAutoProducerService.produceForNewMemory({
          newMemoryId: memory!.object_id,
          workspaceId: memory!.workspace_id,
          runId: memory!.run_id,
          sourceSignalId: entry.sourceSignalId ?? memory!.object_id
        });
        const conflictDetectionService = edgeRuntime.conflictDetectionService;
        expect(conflictDetectionService).not.toBeNull();
        await conflictDetectionService!.detectAndLinkConflicts({
          newMemoryId: memory!.object_id,
          newMemoryDimension: memory!.dimension,
          newMemoryScopeClass: memory!.scope_class,
          newMemoryContent: memory!.content,
          newMemoryDomainTags: memory!.domain_tags,
          workspaceId: memory!.workspace_id,
          runId: memory!.run_id!,
          strictNoDrop: true
        });
        enrichPendingRepo.markProcessed(entry.workspaceId, entry.memoryId, "2026-05-25T00:01:01.000Z");
      }
      expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);

      const relations = await pathRelationRepo.findByAnchors("workspace-1", [
        { kind: "object", object_id: NEW_MEMORY_ID }
      ]);
      expect(relations).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "garden legacy path candidate rejected without temporal assertion evidence",
        { workspace_id: "workspace-1", relation_kind: "supports" }
      );
      expect(warn).toHaveBeenCalledWith(
        "garden legacy path candidate rejected without temporal assertion evidence",
        { workspace_id: "workspace-1", relation_kind: "contradicts" }
      );
    } finally {
      if (previousEdgeClassifyHostWorker === undefined) {
        delete process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER;
      } else {
        process.env.ALAYA_EDGE_CLASSIFY_HOST_WORKER = previousEdgeClassifyHostWorker;
      }
      if (previousIngestReconciliation === undefined) {
        delete process.env.ALAYA_INGEST_RECONCILIATION_ENABLED;
      } else {
        process.env.ALAYA_INGEST_RECONCILIATION_ENABLED = previousIngestReconciliation;
      }
      database.close();
    }
  });

  it("wires rule-only reconciliation through the real materialization path so exact duplicates NOOP", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      const enrichPendingRepo = new SqliteEnrichPendingRepo(database);
      const reconciliationLeaseRepo = new SqliteReconciliationLeaseRepo(database);
      const runtimeNotifier = {
        notify: async () => undefined,
        notifyEntry: async (_entry: EventLogEntry) => undefined
      };

      await seedWorkspaceRun(workspaceRepo, runRepo);
      const duplicateContent = "RTK wrapper is required for shell commands in this repository.";
      await memoryRepo.create(
        createMemoryEntry({
          object_id: OLD_MEMORY_ID,
          content: duplicateContent,
          domain_tags: ["rtk", "workflow"],
          evidence_refs: [],
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z"
        })
      );

      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: evidenceRepo,
        eventLogRepo,
        runtimeNotifier,
        generateObjectId: () => EVIDENCE_ID,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const enqueueEnrichPending = (params: {
        readonly workspaceId: string;
        readonly memoryId: string;
        readonly runId: string | null;
        readonly sourceSignalId: string | null;
      }): void =>
        enrichPendingRepo.enqueue({
          workspaceId: params.workspaceId,
          memoryId: params.memoryId,
          runId: params.runId,
          sourceSignalId: params.sourceSignalId,
          enqueuedAt: "2026-05-25T00:00:01.000Z"
        });
      const memoryService = new MemoryService({
        memoryEntryRepo: memoryRepo,
        evidenceService,
        eventLogRepo,
        runtimeNotifier,
        enrichPendingWriter: { enqueue: enqueueEnrichPending },
        generateObjectId: () => NEW_MEMORY_ID,
        now: () => "2026-05-25T00:00:00.000Z"
      });
      const preWriteRecall = new PreWriteRecallService({
        lexicalSearch: {
          searchByKeyword: async (workspaceId, queryText, limit) =>
            await memoryRepo.searchByKeyword(workspaceId, queryText, limit)
        },
        memoryRepo: {
          findByIds: async (workspaceId, objectIds) =>
            await memoryRepo.findByIds(workspaceId, objectIds),
          findByWorkspaceId: async (workspaceId, tier, page) =>
            await memoryRepo.findByWorkspaceId(workspaceId, tier, page)
        },
        limit: 8
      });
      const reconciliationService = new ReconciliationService({
        preWriteRecall,
        memoryRepo: {
          findByIds: async (workspaceId, objectIds) =>
            await memoryRepo.findByIds(workspaceId, objectIds)
        },
        memoryUpdate: {
          update: async (objectId, fields, reason) =>
            await memoryService.update(objectId, fields, reason)
        },
        eventLog: {
	          append: (event) => eventLogRepo.append(event)
	        },
	        runLookup: {
	          getById: async (runId) =>
	            runId === "run-1" ? { workspace_id: "workspace-1" } : null
	        },
	        llmDecision: createRuleOnlyReconciliationDecisionPort(),
        lease: reconciliationLeaseRepo,
        now: () => new Date("2026-05-25T00:00:02.000Z")
      });
      const router = new MaterializationRouter({
        evidenceService,
        memoryService: {
          create: async (input) => {
            const created = await memoryService.create(input);
            return {
              object_kind: created.object_kind,
              object_id: created.object_id,
              enrichmentEnqueued: input.enqueueEnrichment !== undefined
            };
          }
        },
        synthesisService: {
          create: async () => ({ object_kind: "synthesis_capsule", object_id: "synthesis-1" })
        },
        claimService: {
          create: async () => ({ object_kind: "claim_form", object_id: "claim-1" })
        },
        enrichPendingPort: { enqueue: enqueueEnrichPending },
        reconciliationPort: reconciliationService,
        handoffGapHandler: new InMemoryHandoffGapHandler()
      });

      const result = await router.materializeSignal(createFactSignal());

      expect(result.success).toBe(true);
      expect(result.created_objects).toEqual([
        { object_kind: "memory_entry", object_id: OLD_MEMORY_ID }
      ]);
      await expect(memoryRepo.findByWorkspaceId("workspace-1")).resolves.toHaveLength(1);
      await expect(evidenceRepo.findByWorkspaceId("workspace-1")).resolves.toHaveLength(0);
      expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);
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

function createFactSignal(
  rawPayload: Readonly<{ readonly excerpt: string; readonly distilled_fact: string }> = {
    excerpt: "RTK wrapper is required for shell commands in this repository.",
    distilled_fact: "RTK wrapper is required for shell commands in this repository."
  }
): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "model_tool",
    signal_kind: "potential_claim",
    signal_state: "triaged",
    object_kind: "fact",
    scope_hint: ScopeClass.PROJECT,
    domain_tags: ["rtk", "workflow"],
    confidence: 0.8,
    evidence_refs: [],
    raw_payload: rawPayload,
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
