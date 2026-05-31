import { describe, expect, it } from "vitest";
import {
  CandidateMemorySignalSchema,
  MemoryDimension,
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
  EventPublisher,
  EvidenceService,
  MemoryService,
  PathRelationProposalService,
  type PathCandidateSink
} from "@do-soul/alaya-core";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter
} from "@do-soul/alaya-soul";
import {
  SqliteCoUsageCounterRepo,
  SqliteEnrichPendingRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";

const OLD_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NEW_MEMORY_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";

// invariant: the edge auto-producer folds into the governed path candidate
// intake. A supports verdict becomes a weak attention_only path_relations row
// that only earns recall eligibility through plasticity reinforcement. Post
// S3c decouple this runs in the BULK_ENRICH worker, not inline: the router
// enqueues an enrich_pending marker and the worker (here driven directly, as
// the daemon dispatch branch does) runs produceForNewMemory off-path. This
// wiring test pins the full decoupled chain: materialize enqueues, drain mints
// the path_relations row.
describe("edge auto producer daemon wiring", () => {
  it("enqueues then folds a supports verdict into a weak SUPPORTS path candidate, not a durable edge", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const coUsageCounterRepo = new SqliteCoUsageCounterRepo(database);
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
          content: "Repository shell commands must use the RTK wrapper.",
          domain_tags: ["rtk", "workflow"],
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z"
        })
      );

      const pathRelationProposalService = new PathRelationProposalService({
        repo: {
          create: (relation) => pathRelationRepo.create(relation),
          findByAnchorMemoryId: async (memoryId, workspaceId) =>
            await pathRelationRepo.findByAnchors(workspaceId, [
              { kind: "object", object_id: memoryId }
            ])
        },
        counterStore: coUsageCounterRepo,
        eventPublisher,
        generateId: () => "path-supports-1"
      });
      const pathCandidatePort: PathCandidateSink = {
        submitCandidate: async (input) => await pathRelationProposalService.submitCandidate(input)
      };
      const edgeAutoProducerService = new EdgeAutoProducerService({
        memoryRepo,
        pathCandidatePort,
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
        pathCandidateSinkPort: {
          // Mirrors the daemon wiring seam: forward core's PathMintOutcome
          // untouched so the rejected/failed distinction survives the boundary.
          submitCandidate: async (input) => await pathCandidatePort.submitCandidate(input)
        },
        enrichPendingPort: { enqueue: enqueueEnrichPending },
        handoffGapHandler: new InMemoryHandoffGapHandler()
      });

      const result = await router.materializeSignal(createFactSignal());

      expect(result.success).toBe(true);

      // The write-path enqueued a durable enrich_pending marker and ran NO
      // edge production inline — the path row does not exist yet.
      expect(enrichPendingRepo.countPending("workspace-1")).toBe(1);
      expect(
        (await pathRelationRepo.findByAnchors("workspace-1", [
          { kind: "object", object_id: NEW_MEMORY_ID }
        ])).find((relation) => relation.constitution.relation_kind === "supports")
      ).toBeUndefined();

      // The BULK_ENRICH worker drains the marker and runs produceForNewMemory
      // off-path (driven directly here as the daemon dispatch branch does).
      const claimed = enrichPendingRepo.claimBatch("workspace-1", 50, "2026-05-25T00:01:00.000Z");
      expect(claimed.map((entry) => entry.memoryId)).toEqual([NEW_MEMORY_ID]);
      for (const entry of claimed) {
        const memory = await memoryRepo.findById(entry.memoryId);
        expect(memory).not.toBeNull();
        await edgeAutoProducerService.produceForNewMemory({
          newMemoryId: memory!.object_id,
          workspaceId: memory!.workspace_id,
          runId: memory!.run_id,
          sourceSignalId: entry.sourceSignalId ?? memory!.object_id
        });
        enrichPendingRepo.markProcessed(entry.workspaceId, entry.memoryId, "2026-05-25T00:01:01.000Z");
      }
      expect(enrichPendingRepo.countPending("workspace-1")).toBe(0);

      // A weak supports path_relations row exists, born attention_only.
      const relations = await pathRelationRepo.findByAnchors("workspace-1", [
        { kind: "object", object_id: NEW_MEMORY_ID }
      ]);
      const supports = relations.find(
        (relation) => relation.constitution.relation_kind === "supports"
      );
      expect(supports).toBeDefined();
      expect(supports!.legitimacy.governance_class).toBe("attention_only");
      expect(supports!.effect_vector.recall_bias).toBeGreaterThan(0);
      expect(supports!.plasticity_state.strength).toBeCloseTo(0.5, 5);
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
