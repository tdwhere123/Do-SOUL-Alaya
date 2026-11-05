import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CandidateMemorySignalSchema,
  DYNAMICS_CONSTANTS,
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
import { runBulkEnrichTask, runClaimableBulkEnrichWorkspacePass } from "../../garden/bulk-enrich/bulk-enrich-runtime-runner.js";
import { openRuntimeDatabase } from "../../runtime/startup/runtime-database.js";
import { closeDaemonSqliteWriteQueue } from "../../runtime/startup/database.js";
import { createGardenSignalRefReplayPort } from "../../runtime/garden-wiring/garden-signal-ref-replay.js";
import { createPathRelationRuntime } from "../../runtime/recall-materialization/recall-materialization-path-relation.js";
import { createRuntimeNotifier } from "../../runtime/daemon/support/runtime-notifier.js";

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
const FIXED_ISO = "2026-07-16T12:35:00.000Z";

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
      await new SignalService({ eventLogRepo, signalRepo, runtimeNotifier,
        postTriageMaterializer: { materialize: async candidate => ({ signal_id: candidate.signal_id,
          target_kind: "evidence_only", routing_reason: "completed fixture", created_objects: [], success: true }) }
      }).receiveSignal(signal);
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
        now: () => FIXED_ISO
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
        now: () => FIXED_ISO
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
        softAssociationPathRepo: {
          create: (relation: unknown) => relation,
          findByBackingObjectId: async () => null,
          findActiveByWorkspace: async () => []
        },
        coUsageCounterRepo: new SqliteCoUsageCounterRepo(database),
        eventLogRepo,
        eventPublisher,
        memoryEntryRepo,
        pathFailureHealthInboxPort: { recordPathRelationFailure: async () => undefined },
        pathRelationRepo,
        proposalRepo: new SqliteProposalRepo(database),
        relationAssertionRepo,
        evidenceCapsuleRepo,
        runtimeNotifier,
        warn: vi.fn()
      } as unknown as Parameters<typeof createPathRelationRuntime>[0]);
      pathRelationEvictionTimer = temporalRuntime.pathRelationEvictionTimer;
      const materializationRouter = createReplayRouter(
        evidenceService,
        temporalRuntime.temporalRelationAssertionPort
      );
      const signalRefReplay = createGardenSignalRefReplayPort({
        eventLogRepo,
        signalLookup: signalRepo,
        evidenceCapsuleLookup: evidenceCapsuleRepo,
        materializationRouter
      });
      const completions: unknown[] = [];

      await runBulkEnrichTask({
        now: () => FIXED_ISO,
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
          reportCompletion: async (_task, completedAt, success, auditEntries) => {
            completions.push({ success, completed_at: completedAt, audit_entries: auditEntries });
          },
          warn: vi.fn()
        }
      });

      expect(enrichPendingRepo.countPending(WORKSPACE_ID)).toBe(2);
      expect(completions).toEqual([
        expect.objectContaining({
          success: true,
          completed_at: FIXED_ISO,
          audit_entries: expect.arrayContaining(["bulk_enrich:processed_1", "bulk_enrich:failed_2"])
        })
      ]);
      expect(relationAssertionRepo.listAssertionsInCurrentTransaction()).toHaveLength(0);
      expect(await new SqliteProposalRepo(database).countPending(WORKSPACE_ID)).toBeGreaterThan(0);
      const proposalsBeforeReplay = database.connection.prepare("SELECT * FROM proposals ORDER BY proposal_id").all();
      const auditBeforeReplay = database.connection.prepare("SELECT * FROM event_log ORDER BY rowid").all();
      await expect(pathRelationRepo.findByAnchors(WORKSPACE_ID, [
        { kind: "object", object_id: SOURCE_MEMORY_ID }
      ])).resolves.toEqual([]);

      const replay = () => signalRefReplay.replaySignalRefs({
        newMemoryId: SOURCE_MEMORY_ID,
        memoryEvidenceIds: [EVIDENCE_ID],
        signal: persistedSignal!
      });
      await Promise.all([replay(), replay()]);
      expect(relationAssertionRepo.listAssertionsInCurrentTransaction()).toHaveLength(0);
      expect(database.connection.prepare("SELECT * FROM proposals ORDER BY proposal_id").all()).toEqual(proposalsBeforeReplay);
      expect(database.connection.prepare("SELECT * FROM event_log ORDER BY rowid").all()).toEqual(auditBeforeReplay);
      database.connection.prepare("UPDATE proposals SET resolution_state = 'rejected' WHERE workspace_id = ?").run(WORKSPACE_ID);
      const terminalProposals = database.connection.prepare("SELECT * FROM proposals ORDER BY proposal_id").all();
      await replay();
      expect(database.connection.prepare("SELECT * FROM proposals ORDER BY proposal_id").all()).toEqual(terminalProposals);
      expect(database.connection.prepare("SELECT * FROM event_log ORDER BY rowid").all()).toEqual(auditBeforeReplay);
    } finally {
      if (pathRelationEvictionTimer !== null) clearInterval(pathRelationEvictionTimer);
      database.close();
    }
  });

  it("withholds unknown and active signal refs while scheduled and manual drains advance independent work", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-bulk-signal-disposition-"));
    const filename = join(directory, "alaya.db");
    const seed = initDatabase({ filename });
    await seedWorkspaceAndRun(new SqliteWorkspaceRepo(seed), new SqliteRunRepo(seed));
    const seedSignals = new SqliteSignalRepo(seed), seedEvents = new SqliteEventLogRepo(seed);
    const unknownSignal = CandidateMemorySignalSchema.parse({ ...createSignal(), signal_id: "unknown-signal" });
    await new SignalService({ eventLogRepo: seedEvents, signalRepo: seedSignals,
      runtimeNotifier: createRuntimeNotifier() }).receiveSignal(unknownSignal);
    await seedSignals.updateState(unknownSignal.signal_id, "compiled");
    const seedMemories = new SqliteMemoryEntryRepo(seed), seedPending = new SqliteEnrichPendingRepo(seed);
    await seedMemories.create(createMemory(TARGET_MEMORY_ID, []));
    const heldIds = Array.from({ length: DYNAMICS_CONSTANTS.enrich.claim_batch_size + 2 }, (_, i) =>
      `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);
    for (const id of heldIds) {
      await seedMemories.create(createMemory(id, []));
      seedPending.enqueue({ workspaceId: WORKSPACE_ID, memoryId: id, runId: RUN_ID,
        sourceSignalId: unknownSignal.signal_id, enqueuedAt: FIXED_ISO });
    }
    seed.close();
    const owner = await openRuntimeDatabase(filename, createRuntimeNotifier(), () => undefined);
    const database = owner.database;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let timer: NodeJS.Timeout | null = null;
    try {
      const signalRepo = new SqliteSignalRepo(database), eventLogRepo = new SqliteEventLogRepo(database);
      const memoryEntryRepo = new SqliteMemoryEntryRepo(database), evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);
      const enrichPendingRepo = new SqliteEnrichPendingRepo(database), pathRelationRepo = new SqlitePathRelationRepo(database);
      const runtimeNotifier = createRuntimeNotifier();
      const eventPublisher = new EventPublisher({ eventLogRepo, runHotStateService: { apply: async () => undefined }, runtimeNotifier });
      expect((await signalRepo.getById(unknownSignal.signal_id))?.signal_state).toBe("materialization_unknown");
      const unknownAudit = await eventLogRepo.queryByEntity("candidate_memory_signal", unknownSignal.signal_id);
      expect(unknownAudit.at(-1)?.payload_json).toMatchObject({ normalized_fields: { materialization_recovery: {
        automatic_replay: false, requires_inspection: true } } });

      const activeSignal = CandidateMemorySignalSchema.parse({ ...createSignal(), signal_id: "active-signal" });
      const validSignal = CandidateMemorySignalSchema.parse({ ...createSignal(), signal_id: "valid-signal" });
      const activeMemory = "99999999-9999-4999-8999-999999999999";
      const validMemory = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const activeEvidence = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const validEvidence = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const activeService = new SignalService({ eventLogRepo, signalRepo, runtimeNotifier,
        postTriageMaterializer: { materialize: async candidate => { entered(); await gate;
          return { signal_id: candidate.signal_id, target_kind: "evidence_only", routing_reason: "completed",
            created_objects: [], success: true }; } } });
      const activeResult = activeService.receiveSignal(activeSignal);
      await started;
      const validService = new SignalService({ eventLogRepo, signalRepo, runtimeNotifier,
        postTriageMaterializer: { materialize: async candidate => ({ signal_id: candidate.signal_id,
          target_kind: "evidence_only", routing_reason: "completed", created_objects: [], success: true }) } });
      expect((await validService.receiveSignal(validSignal)).signal.signal_state).toBe("materialized");
      for (const [candidate, memoryId, evidenceId] of [[activeSignal, activeMemory, activeEvidence],
        [validSignal, validMemory, validEvidence]] as const) {
        const emitted = (await eventLogRepo.queryByEntity("candidate_memory_signal", candidate.signal_id))
          .find(entry => entry.event_type === SignalEventType.SOUL_SIGNAL_EMITTED)!;
        await new EvidenceService({ evidenceCapsuleRepo, eventLogRepo, runtimeNotifier,
          generateObjectId: () => evidenceId, now: () => FIXED_ISO }).create({
          created_by: "garden_compile", evidence_kind: "inferred",
          semantic_anchor: { topic: "signal-ref-replay", keywords: ["recall"], summary: "Grounded signal reference." },
          event_anchor: { event_type: SignalEventType.SOUL_SIGNAL_EMITTED, event_id: emitted.event_id, occurred_at: OBSERVED_AT },
          physical_anchor: null, evidence_health_state: "questionable", gist: "Grounded signal reference.",
          excerpt: "Grounded signal reference.", source_hash: null, run_id: RUN_ID, workspace_id: WORKSPACE_ID, surface_id: null });
        await memoryEntryRepo.create(createMemory(memoryId, [evidenceId]));
        enrichPendingRepo.enqueue({ workspaceId: WORKSPACE_ID, memoryId, runId: RUN_ID,
          sourceSignalId: candidate.signal_id, enqueuedAt: FIXED_ISO });
      }
      const temporal = createPathRelationRuntime({ softAssociationPathRepo: {
        create: (relation: unknown) => relation, findByBackingObjectId: async () => null, findActiveByWorkspace: async () => [] },
        coUsageCounterRepo: new SqliteCoUsageCounterRepo(database), eventLogRepo, eventPublisher, memoryEntryRepo,
        pathFailureHealthInboxPort: { recordPathRelationFailure: async () => undefined }, pathRelationRepo,
        proposalRepo: new SqliteProposalRepo(database), relationAssertionRepo: new SqliteRelationAssertionRepo(database),
        evidenceCapsuleRepo, runtimeNotifier, warn: vi.fn() } as unknown as Parameters<typeof createPathRelationRuntime>[0]);
      timer = temporal.pathRelationEvictionTimer;
      const evidenceService = new EvidenceService({ evidenceCapsuleRepo, eventLogRepo, runtimeNotifier });
      const replay = createGardenSignalRefReplayPort({ eventLogRepo, signalLookup: signalRepo, evidenceCapsuleLookup: evidenceCapsuleRepo,
        materializationRouter: createReplayRouter(evidenceService, temporal.temporalRelationAssertionPort) });
      database.connection.exec("CREATE TABLE independent_enrich_probe(memory_id TEXT PRIMARY KEY)");
      const independentCalls: string[] = [];
      const availability = { kind: "ready" as const, ports: { enrichPendingRepo,
        memoryLookup: { findById: async (id: string) => { const memory = await memoryEntryRepo.findById(id);
          return memory === null ? null : toBulkEnrichMemory(memory); } },
        edgeProducer: { produceForNewMemory: async (input: { newMemoryId: string }) => {
          independentCalls.push(input.newMemoryId);
          database.connection.prepare("INSERT INTO independent_enrich_probe VALUES (?)").run(input.newMemoryId);
        } }, conflictDetection: undefined, signalLookup: signalRepo, signalRefReplay: replay } };
      const reports: string[][] = [];
      const reporter = { emitEnrichAbandoned: async () => { throw new Error("held work must not be abandoned"); },
        reportCompletion: async (_task: unknown, _at: string, _success: boolean, entries: readonly string[]) => {
          reports.push([...entries]); }, warn: vi.fn() };
      await runBulkEnrichTask({ now: () => FIXED_ISO, availability, reporter, task: {
        task_id: "scheduled-bulk", task_kind: GardenTaskKind.BULK_ENRICH, required_tier: GardenTier.TIER_2,
        workspace_id: WORKSPACE_ID, run_id: RUN_ID, target_object_refs: [], priority: 10, created_at: FIXED_ISO } });
      expect(reports[0]).toContain(`bulk_enrich:withheld_${DYNAMICS_CONSTANTS.enrich.claim_batch_size}`);
      await runClaimableBulkEnrichWorkspacePass({ now: () => FIXED_ISO, availability, reporter,
        workspaceId: WORKSPACE_ID, maxBatches: 4 });
      const waiting = database.connection.prepare(`SELECT memory_id,attempt_count,claimed_at,processed_at,independent_processed_at
        FROM enrich_pending WHERE signal_ref_waiting=1 ORDER BY memory_id`).all() as Array<{
          memory_id: string; attempt_count: number; claimed_at: string | null; processed_at: string | null; independent_processed_at: string | null }>;
      expect(waiting).toHaveLength(heldIds.length + 1);
      expect(waiting.every(row => row.attempt_count === 0 && row.claimed_at === null && row.processed_at === null &&
        row.independent_processed_at !== null)).toBe(true);
      expect((database.connection.prepare("SELECT processed_at FROM enrich_pending WHERE memory_id=?").get(validMemory) as { processed_at: string }).processed_at).toBe(FIXED_ISO);
      const before = database.connection.prepare("SELECT * FROM proposals ORDER BY proposal_id").all();
      expect(JSON.stringify(before)).toContain(validMemory);
      expect(JSON.stringify(before)).not.toContain(activeMemory);
      for (const id of heldIds) expect(JSON.stringify(before)).not.toContain(id);
      const independentBefore = independentCalls.length;
      await runClaimableBulkEnrichWorkspacePass({ now: () => FIXED_ISO, availability, reporter,
        workspaceId: WORKSPACE_ID, maxBatches: 4 });
      expect(independentCalls).toHaveLength(independentBefore);
      release();
      expect((await activeResult).signal.signal_state).toBe("materialized");
      await runClaimableBulkEnrichWorkspacePass({ now: () => FIXED_ISO, availability, reporter,
        workspaceId: WORKSPACE_ID, maxBatches: 4 });
      const after = database.connection.prepare("SELECT * FROM proposals ORDER BY proposal_id").all();
      expect(JSON.stringify(after)).toContain(activeMemory);
      expect(after.length).toBeGreaterThan(before.length);
      expect(independentCalls).toHaveLength(independentBefore);
      expect(enrichPendingRepo.countPending(WORKSPACE_ID)).toBe(heldIds.length);
      await activeService.close(); await validService.close();
    } finally {
      release();
      if (timer !== null) clearInterval(timer);
      await closeDaemonSqliteWriteQueue(); database.close(); await owner.temporalRuntimeLease.release();
      rmSync(directory, { recursive: true, force: true });
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
