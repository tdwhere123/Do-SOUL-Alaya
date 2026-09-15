import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BoundSourceInterpretationSchema,
  CandidateMemorySignalSchema,
  SOURCE_INTERPRETATION_CONTRACT,
  locateSourceInterpretation
} from "@do-soul/alaya-protocol";
import {
  DynamicsService,
  EventPublisher,
  EvidenceService,
  MemoryService,
  SignalService,
  createAuditedSourceAdmission,
  createSignalEmissionWriter,
  deriveAddressableSpanViews,
  fieldContractSha256
} from "@do-soul/alaya-core";
import { InMemoryHandoffGapHandler, MaterializationRouter } from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteSourceGroundingDeferQueueRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";
import {
  createMaterializationRouter
} from "../../runtime/recall-materialization/recall-materialization-router.js";
import { createSourceGroundingDeferTransitions } from "../../runtime/source-grounding-defer/transitions.js";

const CLOCK = "2026-09-14T12:00:00.000Z";
const ASSERTION = "Alice uses tools.";
const SOURCE = `User: ${ASSERTION}`;

describe("source observation publication wiring", () => {
  it.each(["normal", "lookup replacement", "memory transaction withdrawal"] as const)("publishes only the current source across %s and reopen", async (interleaving) => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-source-observation-daemon-"));
    const filename = join(directory, "memory.sqlite");
    let database = initDatabase({ filename });
    try {
      await new SqliteWorkspaceRepo(database).create({
        workspace_id: "workspace-1", name: "workspace", root_path: directory,
        workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active"
      });
      await new SqliteRunRepo(database).create({
        run_id: "run-1", workspace_id: "workspace-1", title: "run", goal: null,
        run_mode: "chat", engine_binding_id: null, engine_class: null, run_state: "idle",
        current_surface_id: null
      });
      const eventLogRepo = new SqliteEventLogRepo(database);
      const field = createDaemonFieldComposition({ database, eventLogRepo });
      const notifier = { notifyEntry: vi.fn(async () => undefined), notify: async () => undefined };
      const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: evidenceRepo, eventLogRepo, runtimeNotifier: notifier,
        fieldStores: field.stores, now: () => CLOCK
      });
      const memoryService = new MemoryService({
        memoryEntryRepo: memoryRepo, eventLogRepo, evidenceService, runtimeNotifier: notifier,
        now: () => CLOCK,
        dynamicsService: new DynamicsService({
          memoryRepo, karmaEventRepo: new SqliteKarmaEventRepo(database),
          eventLogRepo, runtimeNotifier: notifier
        })
      });
      const sourceAdmission = createAuditedSourceAdmission({
        stores: field.stores, eventLogRepo, sha256: fieldContractSha256
      });
      const admitted = await sourceAdmission.admit({
        workspace_id: "workspace-1", source_id: "artifact-1", source_version: "1",
        content_bytes: SOURCE, evidence_object_id: null, recorded_at: CLOCK,
        event_time: null, valid_from: null, valid_to: null, speaker: "user",
        scope_class: "project", spans: deriveAddressableSpanViews(SOURCE)
      }, { workspaceId: "workspace-1" });
      const router = createMaterializationRouter({
        wiring: {
          evidenceService,
          memoryService,
          synthesisService: { create: async () => { throw new Error("unexpected synthesis route"); } },
          claimService: {
            create: async () => { throw new Error("unexpected claim route"); }
          },
          fieldComposition: field,
          eventLogRepo,
          enqueueEnrichPending: () => undefined
        },
        pathRelationProposalPort: {
          assertPathRelationProposalAvailable: async () => { throw new Error("unexpected path proposal"); },
          createPathRelationProposal: async () => { throw new Error("unexpected path proposal"); }
        },
        temporalRelationAssertionPort: {
          admit: async () => { throw new Error("unexpected temporal assertion"); }
        },
        conflictDetectionService: null,
        reconciliationService: null,
        handoffGapHandler: new InMemoryHandoffGapHandler()
      });
      const signalRepo = new SqliteSignalRepo(database);
      const queueRepo = new SqliteSourceGroundingDeferQueueRepo(database);
      const eventPublisher = new EventPublisher({
        eventLogRepo, runtimeNotifier: notifier,
        runHotStateService: { apply: async () => undefined }
      });
      const signalService = new SignalService({
        eventLogRepo, signalRepo, runtimeNotifier: notifier,
        emissionWriter: createSignalEmissionWriter({ eventPublisher, signalRepo }),
        sourceGroundingDeferQueue: queueRepo,
        sourceGroundingDeferTransitions: createSourceGroundingDeferTransitions({
          eventLogRepo, signalRepo, queueRepo
        }),
        postTriageMaterializer: {
          materialize: async (signal, context) => await router.materializeSignal(signal, context)
        }
      });
      const located = locateSourceInterpretation({
        source: SOURCE, artifactKey: "artifact-1", sha256: fieldContractSha256,
        assertion: {
          assertion_id: 1, text: ASSERTION,
          source_span: [SOURCE.indexOf(ASSERTION), SOURCE.indexOf(ASSERTION) + ASSERTION.length]
        },
        response: { kind: "received", value: { interpretations: [{ assertion_id: 1, relations: [{
          predicate: { text: "uses" }, arguments: [
            { role: "agent", phrase: { text: "Alice" } },
            { role: "object", phrase: { text: "tools" } }
          ], qualifiers: []
        }] }] } }
      });
      const signal = CandidateMemorySignalSchema.parse({
        signal_id: "observation-1", workspace_id: "workspace-1", run_id: "run-1", surface_id: null,
        source: "garden_compile", signal_kind: "potential_semantic_observation",
        interpretation_contract: SOURCE_INTERPRETATION_CONTRACT, object_kind: null, confidence: null,
        scope_hint: "project", domain_tags: [], evidence_refs: [],
        source_memory_refs: [], supersedes_refs: [], exception_to_refs: [],
        contradicts_refs: [], incompatible_with_refs: [],
        raw_payload: { source_interpretation: located, policy: "admin" },
        source_observation: {
          observed_at: CLOCK, authority: "trusted_host_event", source_event_id: "event-1"
        },
        created_at: CLOCK
      });
      if (interleaving === "lookup replacement") {
        const lookup = memoryService.findByIdScoped.bind(memoryService);
        vi.spyOn(memoryService, "findByIdScoped").mockImplementationOnce(async (...args) => {
          await sourceAdmission.admit({ workspace_id: "workspace-1", source_id: "artifact-1", source_version: "2",
            content_bytes: SOURCE, evidence_object_id: null, recorded_at: "2026-09-15T12:00:00.000Z",
            event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
            spans: deriveAddressableSpanViews(SOURCE) }, { workspaceId: "workspace-1" });
          return lookup(...args);
        });
      }
      if (interleaving === "memory transaction withdrawal") {
        const create = memoryRepo.createWithinTransaction.bind(memoryRepo);
        vi.spyOn(memoryRepo, "createWithinTransaction").mockImplementation((entry, hooks) =>
          create(entry, { ...hooks, beforeCreate: () => {
            database.connection.prepare("UPDATE source_records SET source_body=NULL WHERE record_id=?")
              .run(admitted.record.identity);
            hooks.beforeCreate?.();
          } }));
      }
      const received = await signalService.receiveSignal(signal);
      if (interleaving !== "normal") {
        expect(received.materialization?.success).toBe(false);
        expect(database.connection.prepare("SELECT COUNT(*) AS n FROM memory_entries").get()).toEqual({ n: 0 });
        expect(database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get())
          .toEqual({ n: interleaving === "lookup replacement" ? 0 : 1 });
        expect(database.connection.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_type='soul.memory.created'").get())
          .toEqual({ n: 0 });
        return;
      }
      expect(received.triage_result).toBe("accepted");
      expect(received.materialization?.success).toBe(true);
      expect(received.materialization?.target_kind).toBe("evidence_only");
      const memoryId = received.materialization?.created_objects.find((object) => object.object_kind === "memory_entry")?.object_id;
      const evidenceId = received.materialization?.created_objects.find((object) => object.object_kind === "evidence_capsule")?.object_id;
      expect(memoryId).toBeDefined();
      expect(evidenceId).toBeDefined();
      const liveMemory = await memoryService.findById(memoryId!);
      expect(liveMemory).toMatchObject({
        dimension: "observation", confidence: null, content: ASSERTION
      });
      expect(liveMemory?.evidence_refs).toEqual([evidenceId]);
      const withdrawn = await signalService.receiveSignal({
        ...signal, signal_id: "stale-observation",
        raw_payload: { source_interpretation: located }
      });
      database.connection.prepare(
        "UPDATE source_records SET source_body = NULL WHERE workspace_id = ? AND record_id = ?"
      ).run("workspace-1", admitted.record.identity);
      const afterWithdraw = await router.materializeSignal({
        ...signal, signal_id: "withdrawn-observation"
      });
      expect(afterWithdraw.success).toBe(false);
      expect(afterWithdraw.created_objects).toEqual([]);
      expect(withdrawn.materialization?.success).toBe(true);

      database.close();
      database = initDatabase({ filename });
      const reopenedMemory = await new SqliteMemoryEntryRepo(database).findById(memoryId!);
      const reopenedEvidence = await new SqliteEvidenceCapsuleRepo(database).findById(evidenceId!);
      expect(reopenedMemory).toMatchObject({
        object_id: memoryId, dimension: "observation", confidence: null, content: ASSERTION
      });
      const rebound = BoundSourceInterpretationSchema.parse(JSON.parse(reopenedEvidence!.gist));
      expect(rebound.assertion_binding.context_id).toBe(located.assertion_binding.context_id);
      expect(rebound.source_target.root_id).toBe(admitted.record.identity);
      expect(rebound.source_target.evidence_object_id).toBe(evidenceId);
      expect(reopenedEvidence?.excerpt).toBe(ASSERTION);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("still materializes an explicit claim through the existing claim entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-source-observation-claim-"));
    const filename = join(directory, "memory.sqlite");
    const database = initDatabase({ filename });
    try {
      await new SqliteWorkspaceRepo(database).create({
        workspace_id: "workspace-1", name: "workspace", root_path: directory,
        workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active"
      });
      await new SqliteRunRepo(database).create({
        run_id: "run-1", workspace_id: "workspace-1", title: "run", goal: null,
        run_mode: "chat", engine_binding_id: null, engine_class: null, run_state: "idle",
        current_surface_id: null
      });
      const eventLogRepo = new SqliteEventLogRepo(database);
      const notifier = { notifyEntry: async () => undefined, notify: async () => undefined };
      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), eventLogRepo,
        runtimeNotifier: notifier, now: () => CLOCK
      });
      const memoryService = new MemoryService({
        memoryEntryRepo: new SqliteMemoryEntryRepo(database), eventLogRepo, evidenceService,
        runtimeNotifier: notifier, now: () => CLOCK,
        dynamicsService: new DynamicsService({
          memoryRepo: new SqliteMemoryEntryRepo(database),
          karmaEventRepo: new SqliteKarmaEventRepo(database),
          eventLogRepo, runtimeNotifier: notifier
        })
      });
      const claimCalls: unknown[] = [];
      const router = new MaterializationRouter({
        evidenceService, memoryService,
        synthesisService: { create: async () => { throw new Error("unexpected synthesis route"); } },
        claimService: {
          create: async (input) => {
            claimCalls.push(input);
            return { object_kind: "claim_form", object_id: "claim-1" };
          }
        },
        handoffGapHandler: new InMemoryHandoffGapHandler()
      });
      const claimed = await router.materializeSignal(CandidateMemorySignalSchema.parse({
        signal_id: "claim-1", workspace_id: "workspace-1", run_id: "run-1", surface_id: null,
        source: "model_tool", signal_kind: "potential_claim", object_kind: "decision",
        confidence: 0.9, scope_hint: null, domain_tags: ["governance"], evidence_refs: ["msg-1"],
        source_memory_refs: [], supersedes_refs: [], exception_to_refs: [],
        contradicts_refs: [], incompatible_with_refs: [],
        raw_payload: { excerpt: "Ship the decision." },
        created_at: CLOCK
      }));
      expect(claimed.success).toBe(true);
      expect(claimCalls).toHaveLength(1);
      expect(claimed.created_objects.some((object) => object.object_kind === "claim_form")).toBe(true);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a withdrawn newer sqlite revision instead of resurrecting the older body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-source-observation-withdrawn-"));
    const filename = join(directory, "memory.sqlite");
    const database = initDatabase({ filename });
    try {
      await new SqliteWorkspaceRepo(database).create({
        workspace_id: "workspace-1", name: "workspace", root_path: directory,
        workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active"
      });
      const eventLogRepo = new SqliteEventLogRepo(database);
      const field = createDaemonFieldComposition({ database, eventLogRepo });
      const notifier = { notifyEntry: async () => undefined, notify: async () => undefined };
      const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
      const memoryRepo = new SqliteMemoryEntryRepo(database);
      const evidenceService = new EvidenceService({
        evidenceCapsuleRepo: evidenceRepo, eventLogRepo, runtimeNotifier: notifier,
        fieldStores: field.stores, now: () => CLOCK
      });
      const memoryService = new MemoryService({
        memoryEntryRepo: memoryRepo, eventLogRepo, evidenceService, runtimeNotifier: notifier,
        now: () => CLOCK,
        dynamicsService: new DynamicsService({
          memoryRepo, karmaEventRepo: new SqliteKarmaEventRepo(database),
          eventLogRepo, runtimeNotifier: notifier
        })
      });
      const sourceAdmission = createAuditedSourceAdmission({
        stores: field.stores, eventLogRepo, sha256: fieldContractSha256
      });
      await sourceAdmission.admit({
        workspace_id: "workspace-1", source_id: "artifact-1", source_version: "1",
        content_bytes: SOURCE, evidence_object_id: null, recorded_at: CLOCK,
        event_time: null, valid_from: null, valid_to: null, speaker: "user",
        scope_class: "project", spans: deriveAddressableSpanViews(SOURCE)
      }, { workspaceId: "workspace-1" });
      const v2 = await sourceAdmission.admit({
        workspace_id: "workspace-1", source_id: "artifact-1", source_version: "2",
        content_bytes: "User: Alice uses apps.", evidence_object_id: null,
        recorded_at: "2026-09-15T00:00:00.000Z",
        event_time: null, valid_from: null, valid_to: null, speaker: "user",
        scope_class: "project", spans: deriveAddressableSpanViews("User: Alice uses apps.")
      }, { workspaceId: "workspace-1" });
      database.connection.prepare(
        "UPDATE source_records SET source_body = NULL WHERE workspace_id = ? AND record_id = ?"
      ).run("workspace-1", v2.record.identity);
      const router = createMaterializationRouter({
        wiring: {
          evidenceService, memoryService,
          synthesisService: { create: async () => { throw new Error("unexpected synthesis route"); } },
          claimService: { create: async () => { throw new Error("unexpected claim route"); } },
          fieldComposition: field, eventLogRepo,
          enqueueEnrichPending: () => undefined
        },
        pathRelationProposalPort: {
          assertPathRelationProposalAvailable: async () => { throw new Error("unexpected path proposal"); },
          createPathRelationProposal: async () => { throw new Error("unexpected path proposal"); }
        },
        temporalRelationAssertionPort: {
          admit: async () => { throw new Error("unexpected temporal assertion"); }
        },
        conflictDetectionService: null, reconciliationService: null,
        handoffGapHandler: new InMemoryHandoffGapHandler()
      });
      const located = locateSourceInterpretation({
        source: SOURCE, artifactKey: "artifact-1", sha256: fieldContractSha256,
        assertion: {
          assertion_id: 1, text: ASSERTION,
          source_span: [SOURCE.indexOf(ASSERTION), SOURCE.indexOf(ASSERTION) + ASSERTION.length]
        },
        response: { kind: "received", value: { interpretations: [{ assertion_id: 1, relations: [] }] } }
      });
      const signal = CandidateMemorySignalSchema.parse({
        signal_id: "withdrawn-head", workspace_id: "workspace-1", run_id: "run-1", surface_id: null,
        source: "garden_compile", signal_kind: "potential_semantic_observation",
        interpretation_contract: SOURCE_INTERPRETATION_CONTRACT, object_kind: null, confidence: null,
        scope_hint: "project", domain_tags: [], evidence_refs: [],
        source_memory_refs: [], supersedes_refs: [], exception_to_refs: [],
        contradicts_refs: [], incompatible_with_refs: [],
        raw_payload: { source_interpretation: located },
        source_observation: {
          observed_at: CLOCK, authority: "trusted_host_event", source_event_id: "event-1"
        },
        created_at: CLOCK
      });
      const result = await router.materializeSignal(signal);
      expect(result.success).toBe(false);
      expect(result.created_objects).toEqual([]);
      expect(
        (database.connection.prepare(
          "SELECT COUNT(*) AS n FROM memory_entries WHERE dimension = 'observation'"
        ).get() as { n: number }).n
      ).toBe(0);
      expect(
        (database.connection.prepare(
          "SELECT COUNT(*) AS n FROM evidence_capsules WHERE gist LIKE '%source-interpretation-v1%'"
        ).get() as { n: number }).n
      ).toBe(0);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
