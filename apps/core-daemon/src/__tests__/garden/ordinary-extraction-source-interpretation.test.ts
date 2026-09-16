import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  SOURCE_INTERPRETATION_CONTRACT
} from "@do-soul/alaya-protocol";
import {
  DynamicsService,
  EventPublisher,
  EvidenceService,
  MemoryService,
  SignalService,
  createSourceAdmissionPort,
  createSignalEmissionWriter,
  fieldContractSha256
} from "@do-soul/alaya-core";
import {
  InMemoryHandoffGapHandler,
  OfficialApiGardenProvider
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
  createMaterializationRouter
} from "../../runtime/recall-materialization/recall-materialization-router.js";
import { createSourceGroundingDeferTransitions } from "../../runtime/source-grounding-defer/transitions.js";

import { createConversationGardenCompileQueue } from "../../garden/conversation-compile-queue-adapter.js";
import { GardenComputeCoordinator } from "../../../../../packages/core/src/conversation/garden-compute-coordinator.js";
import { createMessage, createRun, createWorkspace } from "../../../../../packages/core/src/__tests__/conversation/conversation-service.test-support.js";
import { enqueuePostTurnExtractTask } from "../../mcp-memory/garden-task/post-turn-extract-queue.js";
import { createDeliveryRecord } from "../mcp-memory/garden/post-turn-extract-task-record-fixture.js";

const CLOCK = "2026-09-14T12:00:00.000Z";
const ASSERTION = "Alice uses tools.";
const LONG_ASSERTION = `${"The archive retains neutral context. ".repeat(26)}${ASSERTION}`;

describe("ordinary extraction source interpretation adapters", () => {
  it.each(["post-turn", "interactive"] as const)("runs the production %s entry through parsing and SQLite publication with retries", async (mode) => {
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
      const sourceAdmission = createSourceAdmissionPort({
        stores: field.stores, sha256: fieldContractSha256
      });
      const router = createMaterializationRouter({
        wiring: {
          evidenceService,
          memoryService,
          synthesisService: { create: async () => { throw new Error("unexpected synthesis route"); } },
          claimService: { create: async () => { throw new Error("unexpected claim route"); } },
          fieldComposition: field,
          eventLogRepo,
          runtimeNotifier: notifier,
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
      const gardenTaskRepo = new SqliteGardenTaskRepo(database.connection, eventPublisher);
      const enqueue = () => enqueuePostTurnExtractTask({ deps: { gardenTaskRepo, sourceAdmission }, now: () => CLOCK },
        { delivery_id: "delivery-1", usage_state: "used", turn_index: 0,
          turn_digest: { last_messages: [{ role: "user", content_excerpt: LONG_ASSERTION }] } },
        { workspaceId: "workspace-1", runId: "run-1", agentTarget: "codex", sessionId: "session-1" },
        createDeliveryRecord({ delivered_at: CLOCK }));
      if (mode === "post-turn") { enqueue(); enqueue(); }
      const taskId = gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-1", 10)[0]?.id;
      let signalOrdinal = 0;
      const provider = new OfficialApiGardenProvider({
        apiKey: "sk-test",
        extractor: {
          extract: async ({ userPrompt }) => ({
            rawJson: JSON.stringify({
              interpretations: JSON.parse(userPrompt).source_assertions.map((assertion: { assertion_id: number; text: string }) => ({
                assertion_id: assertion.assertion_id,
                relations: assertion.text.includes(ASSERTION) ? [{
                  predicate: { text: "uses" },
                  arguments: [
                    { role: "agent", phrase: { text: "Alice" } },
                    { role: "object", phrase: { text: "tools" } }
                  ],
                  qualifiers: []
                }] : []
              }))
            })
          })
        },
        generateSignalId: () => `compile-signal-${++signalOrdinal}`,
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
      if (mode === "post-turn") {
        await process();
        expect(gardenTaskRepo.findById(taskId!)?.status).toBe("completed");
        enqueue(); await process();
      } else {
        const completed = vi.fn(async () => undefined);
        const warn = vi.fn();
        const coordinator = new GardenComputeCoordinator({
          gardenCompileQueue: createConversationGardenCompileQueue({
            gardenTaskRepo,
            now: () => CLOCK,
            sourceAdmission
          }),
          healthJournalRecorder: { record: async () => undefined },
          releaseGovernanceLeaseSafely: completed,
          warn
        });
        const input = { run: createRun(), workspace: createWorkspace(), modelRef: null,
          userMessage: createMessage("user-1", "user", LONG_ASSERTION),
          assistantMessage: createMessage("assistant-1", "assistant", "Acknowledged.") };
        coordinator.triggerCompile(input);
        await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
        coordinator.triggerCompile(input);
        await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
        expect(warn.mock.calls.filter(([message]) => String(message).includes("failed"))).toEqual([]);
        const compileTaskId = gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-1", 10)[0]?.id;
        await process();
        expect(gardenTaskRepo.findById(compileTaskId!)?.status).toBe("completed");
      }
      const sourceRows = database.connection.prepare("SELECT source_body FROM source_records WHERE source_id LIKE 'post-turn:%' OR source_id LIKE 'garden-compile:%'").all() as { source_body: string }[];
      expect(sourceRows).toHaveLength(1);
      expect(sourceRows[0]!.source_body).toContain(LONG_ASSERTION);
      const memories = database.connection.prepare("SELECT object_id FROM memory_entries").all() as { object_id: string }[];
      expect(memories).toHaveLength(1);
      received.memoryId = memories[0]!.object_id;
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
      expect(database.connection.prepare("SELECT count(*) AS n FROM claim_forms").get()).toMatchObject({ n: 0 });

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
