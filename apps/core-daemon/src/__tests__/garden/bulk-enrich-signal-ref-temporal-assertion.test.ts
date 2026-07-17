import { describe, expect, it, vi } from "vitest";
import {
  CandidateMemorySignalSchema,
  FormationKind,
  GardenTaskKind,
  GardenTier,
  MemoryDimension,
  ScopeClass,
  SignalEventType,
  SourceKind,
  WorkspaceKind,
  WorkspaceState,
  RunMode,
  RunState,
  type CandidateMemorySignal,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { EventPublisher, EvidenceService, SignalService } from "@do-soul/alaya-core";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  type MaterializationRouterDeps
} from "@do-soul/alaya-soul";
import {
  SqliteCoUsageCounterRepo,
  SqliteEnrichPendingRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteProposalRepo,
  SqliteRelationAssertionRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";
import { runBulkEnrichTask } from "../../garden/bulk-enrich-runtime-runner.js";
import { createGardenSignalRefReplayPort } from "../../runtime/garden-signal-ref-replay.js";
import { createPathRelationRuntime } from "../../runtime/recall-materialization-path-relation.js";
import { createRuntimeNotifier } from "../../runtime/runtime-notifier.js";

const WORKSPACE_ID = "workspace-1";
const RUN_ID = "run-1";
const SIGNAL_ID = "signal-replay-1";
const SOURCE_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_MEMORY_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";
const EMPTY_EVIDENCE_MEMORY_ID = "44444444-4444-4444-8444-444444444444";
const AMBIGUOUS_EVIDENCE_MEMORY_ID = "55555555-5555-4555-8555-555555555555";
const SECOND_EVIDENCE_ID = "66666666-6666-4666-8666-666666666666";
const OBSERVED_AT = "2026-07-16T12:34:56.000Z";

// anti-patterns-lint-allow: exercises the durable bulk-enrich handoff through real SQLite assertion storage.
describe("BULK_ENRICH signal-ref temporal assertion admission", () => {
  it("admits only a uniquely anchored memory evidence capsule, leaves zero/multiple matches pending, and replays idempotently", async () => {
    const database = initDatabase({ filename: ":memory:" });
    let pathRelationEvictionTimer: NodeJS.Timeout | null = null;
    try {
      const workspaceRepo = new SqliteWorkspaceRepo(database);
      const runRepo = new SqliteRunRepo(database);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const signalRepo = new SqliteSignalRepo(database);
      const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);
      const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
      const enrichPendingRepo = new SqliteEnrichPendingRepo(database);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const relationAssertionRepo = new SqliteRelationAssertionRepo(database);
      const runtimeNotifier = createRuntimeNotifier();
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: async () => undefined },
        runtimeNotifier
      });

      await seedWorkspaceAndRun(workspaceRepo, runRepo);
      const signal = createSignal();
      await new SignalService({ eventLogRepo, signalRepo, runtimeNotifier }).receiveSignal(signal);
      const persistedSignal = await signalRepo.getById(SIGNAL_ID);
      expect(persistedSignal).not.toBeNull();
      const emitted = (await eventLogRepo.queryByEntity("candidate_memory_signal", SIGNAL_ID)).find(
        (entry) => entry.event_type === SignalEventType.SOUL_SIGNAL_EMITTED
      );
      expect(emitted).toBeDefined();

      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo,
        eventLogRepo,
        runtimeNotifier,
        generateObjectId: () => EVIDENCE_ID,
        now: () => "2026-07-16T12:35:00.000Z"
      });
      await evidenceService.create({
        created_by: "garden_compile",
        evidence_kind: "inferred",
        semantic_anchor: {
          topic: "signal-ref-replay",
          keywords: ["recall"],
          summary: "Persisted source evidence for the replayed signal."
        },
        event_anchor: {
          event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
          event_id: emitted!.event_id,
          occurred_at: OBSERVED_AT
        },
        physical_anchor: null,
        evidence_health_state: "questionable",
        gist: "Persisted source evidence for the replayed signal.",
        excerpt: "Persisted source evidence for the replayed signal.",
        source_hash: null,
        run_id: RUN_ID,
        workspace_id: WORKSPACE_ID,
        surface_id: null
      });
      await new EvidenceService({
        evidenceCapsuleRepo,
        eventLogRepo,
        runtimeNotifier,
        generateObjectId: () => SECOND_EVIDENCE_ID,
        now: () => "2026-07-16T12:35:00.000Z"
      }).create({
        created_by: "garden_compile",
        evidence_kind: "inferred",
        semantic_anchor: {
          topic: "signal-ref-replay",
          keywords: ["recall"],
          summary: "Second persisted source evidence for ambiguity coverage."
        },
        event_anchor: {
          event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
          event_id: emitted!.event_id,
          occurred_at: OBSERVED_AT
        },
        physical_anchor: null,
        evidence_health_state: "questionable",
        gist: "Second persisted source evidence for ambiguity coverage.",
        excerpt: "Second persisted source evidence for ambiguity coverage.",
        source_hash: null,
        run_id: RUN_ID,
        workspace_id: WORKSPACE_ID,
        surface_id: null
      });
      await memoryEntryRepo.create(createMemory(SOURCE_MEMORY_ID, [EVIDENCE_ID]));
      await memoryEntryRepo.create(createMemory(TARGET_MEMORY_ID, []));
      await memoryEntryRepo.create(createMemory(EMPTY_EVIDENCE_MEMORY_ID, []));
      await memoryEntryRepo.create(
        createMemory(AMBIGUOUS_EVIDENCE_MEMORY_ID, [EVIDENCE_ID, SECOND_EVIDENCE_ID])
      );
      enqueueReplay(enrichPendingRepo, SOURCE_MEMORY_ID);
      enqueueReplay(enrichPendingRepo, EMPTY_EVIDENCE_MEMORY_ID);
      enqueueReplay(enrichPendingRepo, AMBIGUOUS_EVIDENCE_MEMORY_ID);

      const temporalRuntime = createPathRelationRuntime({
        coUsageCounterRepo: new SqliteCoUsageCounterRepo(database),
        eventLogRepo,
        eventPublisher,
        memoryEntryRepo,
        pathFailureHealthInboxPort: { recordPathRelationFailure: async () => undefined },
        pathRelationRepo,
        proposalRepo: new SqliteProposalRepo(database),
        relationAssertionRepo,
        runtimeNotifier,
        warn: vi.fn()
      });
      pathRelationEvictionTimer = temporalRuntime.pathRelationEvictionTimer;
      const materializationRouter = createReplayRouter(
        evidenceService,
        temporalRuntime.temporalRelationAssertionPort
      );
      const signalRefReplay = createGardenSignalRefReplayPort({
        eventLogRepo,
        evidenceCapsuleLookup: evidenceCapsuleRepo,
        materializationRouter
      });
      const completions: unknown[] = [];

      await runBulkEnrichTask({
        task: {
          task_id: "bulk-enrich-signal-ref",
          task_kind: GardenTaskKind.BULK_ENRICH,
          required_tier: GardenTier.TIER_2,
          workspace_id: WORKSPACE_ID,
          run_id: RUN_ID,
          target_object_refs: [SOURCE_MEMORY_ID],
          priority: 10,
          created_at: "2026-07-16T12:35:02.000Z"
        },
        availability: {
          kind: "ready",
          ports: {
            enrichPendingRepo,
            memoryLookup: {
              findById: async (memoryId) => {
                const memory = await memoryEntryRepo.findById(memoryId);
                return memory === null ? null : toBulkEnrichMemory(memory);
              }
            },
            edgeProducer: undefined,
            conflictDetection: undefined,
            signalLookup: { getById: async (signalId) => await signalRepo.getById(signalId) },
            signalRefReplay
          }
        },
        reporter: {
          emitEnrichAbandoned: async () => undefined,
          reportCompletion: async (_task, _completedAt, success, auditEntries) => {
            completions.push({ success, audit_entries: auditEntries });
          },
          warn: vi.fn()
        }
      });

      expect(enrichPendingRepo.countPending(WORKSPACE_ID)).toBe(2);
      expect(completions).toEqual([
        expect.objectContaining({
          success: true,
          audit_entries: expect.arrayContaining(["bulk_enrich:processed_1", "bulk_enrich:failed_2"])
        })
      ]);
      const assertions = relationAssertionRepo.listAssertionsInCurrentTransaction();
      expect(assertions).toHaveLength(1);
      expect(assertions[0]).toMatchObject({
        workspace_id: WORKSPACE_ID,
        evidence_ids: [EVIDENCE_ID],
        relation_kind: "derives_from",
        anchors: {
          source_anchor: { kind: "object", object_id: SOURCE_MEMORY_ID },
          target_anchor: { kind: "object", object_id: TARGET_MEMORY_ID }
        }
      });
      await expect(relationAssertionRepo.findActiveProjectionByWorkspace(WORKSPACE_ID)).resolves.toEqual([
        expect.objectContaining({
          constitution: expect.objectContaining({ relation_kind: "derives_from" })
        })
      ]);
      await expect(pathRelationRepo.findByAnchors(WORKSPACE_ID, [
        { kind: "object", object_id: SOURCE_MEMORY_ID }
      ])).resolves.toEqual([]);

      await signalRefReplay.replaySignalRefs({
        newMemoryId: SOURCE_MEMORY_ID,
        memoryEvidenceIds: [EVIDENCE_ID],
        signal: persistedSignal!
      });
      expect(relationAssertionRepo.listAssertionsInCurrentTransaction()).toHaveLength(1);
      await expect(relationAssertionRepo.findActiveProjectionByWorkspace(WORKSPACE_ID)).resolves.toHaveLength(1);
    } finally {
      if (pathRelationEvictionTimer !== null) clearInterval(pathRelationEvictionTimer);
      database.close();
    }
  });
});

async function seedWorkspaceAndRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: WORKSPACE_ID,
    name: "workspace-1",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID,
    title: "run-1",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

function enqueueReplay(enrichPendingRepo: SqliteEnrichPendingRepo, memoryId: string): void {
  enrichPendingRepo.enqueue({
    workspaceId: WORKSPACE_ID,
    memoryId,
    runId: RUN_ID,
    sourceSignalId: SIGNAL_ID,
    enqueuedAt: "2026-07-16T12:35:01.000Z"
  });
}

function createSignal(): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: SIGNAL_ID,
    workspace_id: WORKSPACE_ID,
    run_id: RUN_ID,
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "emitted",
    object_kind: "fact",
    scope_hint: ScopeClass.PROJECT,
    domain_tags: ["recall"],
    confidence: 0.9,
    // Deliberately not the durable capsule id: replay must use the memory link.
    evidence_refs: ["external-source-reference"],
    source_memory_refs: [TARGET_MEMORY_ID],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { distilled_fact: "The source memory derives from the target memory." },
    source_observation: {
      observed_at: OBSERVED_AT,
      authority: "trusted_host_event",
      source_event_id: "host-observation-1"
    },
    created_at: "2026-07-16T12:35:00.000Z"
  });
}

function createReplayRouter(
  evidenceService: EvidenceService,
  temporalRelationAssertionPort: NonNullable<MaterializationRouterDeps["temporalRelationAssertionPort"]>
): MaterializationRouter {
  return new MaterializationRouter({
    evidenceService,
    memoryService: { create: async () => ({ object_kind: "memory_entry", object_id: SOURCE_MEMORY_ID }) },
    synthesisService: { create: async () => ({ object_kind: "synthesis_capsule", object_id: "synthesis-1" }) },
    claimService: { create: async () => ({ object_kind: "claim_form", object_id: "claim-1" }) },
    handoffGapHandler: new InMemoryHandoffGapHandler(),
    temporalRelationAssertionPort
  });
}

function createMemory(objectId: string, evidenceRefs: readonly string[]): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-07-16T12:35:01.000Z",
    updated_at: "2026-07-16T12:35:01.000Z",
    created_by: "garden_compile",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.COMPILER,
    formation_kind: FormationKind.EXTRACTED,
    scope_class: ScopeClass.PROJECT,
    content: `Memory ${objectId}`,
    domain_tags: ["recall"],
    evidence_refs: evidenceRefs,
    workspace_id: WORKSPACE_ID,
    run_id: RUN_ID,
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
    superseded_by: null
  };
}

function toBulkEnrichMemory(memory: MemoryEntry) {
  return {
    object_id: memory.object_id,
    dimension: memory.dimension,
    scope_class: memory.scope_class,
    content: memory.content,
    domain_tags: memory.domain_tags,
    evidence_refs: memory.evidence_refs,
    workspace_id: memory.workspace_id,
    run_id: memory.run_id ?? ""
  };
}
