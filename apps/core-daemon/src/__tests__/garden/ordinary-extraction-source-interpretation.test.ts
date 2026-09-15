import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  SOURCE_INTERPRETATION_CONTRACT
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
import {
  InMemoryHandoffGapHandler,
  OfficialApiGardenProvider,
  buildOfficialApiSourceCorpus
} from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteSourceGroundingDeferQueueRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { createPostTurnExtractTaskProcessor } from "../../garden/host-worker/host-worker-task-processors.js";
import { createPostTurnSignalReceiver } from "../../garden/post-turn-extract/signal-receiver.js";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";
import {
  createMaterializationRouter,
  type SignalMaterializationRuntimeInput
} from "../../runtime/recall-materialization/recall-materialization-router.js";
import { createSourceGroundingDeferTransitions } from "../../runtime/source-grounding-defer/transitions.js";

const CLOCK = "2026-09-14T12:00:00.000Z";
const ASSERTION = "Alice uses tools.";
const TASK_ID = "post-turn-task-1";

describe("ordinary extraction source interpretation adapters", () => {
  it("injects a provider-free response through the post-turn worker and SQLite publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-ordinary-extraction-"));
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
      const source = buildOfficialApiSourceCorpus(ASSERTION, [
        { role: "user", content: ASSERTION }
      ]);
      const admitted = await sourceAdmission.admit({
        workspace_id: "workspace-1", source_id: `post-turn:${TASK_ID}`, source_version: "1",
        content_bytes: source, evidence_object_id: null, recorded_at: CLOCK,
        event_time: null, valid_from: null, valid_to: null, speaker: "user",
        scope_class: "project", spans: deriveAddressableSpanViews(source)
      }, { workspaceId: "workspace-1" });
      const router = createMaterializationRouter({
        wiring: {
          evidenceService,
          memoryService,
          synthesisService: { create: async () => { throw new Error("unexpected synthesis route"); } },
          claimService: { create: async () => { throw new Error("unexpected claim route"); } },
          fieldComposition: field,
          eventLogRepo,
          enqueueEnrichPending: () => undefined
        },
        pathRelationProposalPort: {
          submitCandidate: async () => { throw new Error("unexpected path proposal"); }
        },
        temporalRelationAssertionPort: {
          admit: async () => { throw new Error("unexpected temporal assertion"); }
        },
        conflictDetectionService: null,
        reconciliationService: null,
        handoffGapHandler: new InMemoryHandoffGapHandler()
      } as SignalMaterializationRuntimeInput);
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
      const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
      gardenTaskRepo.enqueue({
        id: TASK_ID,
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: {
          run_id: "run-1",
          workspace_id: "workspace-1",
          created_at: CLOCK,
          turn_index: 0,
          admitted_source_root_id: admitted.record.identity,
          source_observation: {
            observed_at: CLOCK,
            authority: "verified_delivery_observation",
            source_event_id: "event-delivery"
          },
          turn_digest: {
            last_messages: [{ role: "user", content_excerpt: ASSERTION }]
          }
        },
        created_at: CLOCK
      });
      const provider = new OfficialApiGardenProvider({
        apiKey: "sk-test",
        extractor: {
          extract: async () => ({
            rawJson: JSON.stringify({
              interpretations: [{
                assertion_id: 1,
                relations: [{
                  predicate: { text: "uses" },
                  arguments: [
                    { role: "agent", phrase: { text: "Alice" } },
                    { role: "object", phrase: { text: "tools" } }
                  ],
                  qualifiers: []
                }]
              }]
            })
          })
        },
        generateSignalId: () => "unused-compile-id",
        now: () => CLOCK
      });
      const received: { memoryId?: string } = {};
      const innerReceiver = createPostTurnSignalReceiver(
        signalService,
        eventLogRepo,
        evidenceRepo
      );
      const process = createPostTurnExtractTaskProcessor({
        now: () => CLOCK,
        gardenTaskRepo,
        configService: {
          getRuntimeGardenComputeConfig: async () => ({
            provider_kind: "official_api",
            model_id: "test-model",
            provider_url: null,
            secret_ref: "env:TEST",
            enabled: true
          })
        },
        eventPublisher,
        officialApiGardenProvider: provider,
        signalReceiver: {
          receiveSignal: async (signal) => {
            const result = await innerReceiver.receiveSignal(signal);
            received.memoryId = result.materialization?.created_objects.find(
              (object) => object.object_kind === "memory_entry"
            )?.object_id;
            return result;
          },
          hasCreatedEvidence: (result) => innerReceiver.hasCreatedEvidence(result)
        },
        warn: () => undefined
      });
      await process();
      expect(gardenTaskRepo.findById(TASK_ID)?.status).toBe("completed");
      const signals = await signalService.listByRun("run-1");
      const observation = signals.find((signal) => signal.interpretation_contract === SOURCE_INTERPRETATION_CONTRACT);
      expect(observation).toMatchObject({
        source: "garden_compile",
        object_kind: null,
        confidence: null,
        interpretation_contract: SOURCE_INTERPRETATION_CONTRACT
      });
      expect(received.memoryId).toBeDefined();
      const published = await memoryService.findById(received.memoryId!);
      expect(published).toMatchObject({
        dimension: "observation",
        confidence: null,
        content: expect.stringContaining("Alice uses tools.")
      });
      expect(published?.claim_id ?? null).toBeNull();

      database.close();
      database = initDatabase({ filename });
      const reopened = await new SqliteMemoryEntryRepo(database).findById(published!.object_id);
      expect(reopened).toMatchObject({
        object_id: published!.object_id,
        dimension: "observation",
        confidence: null
      });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
