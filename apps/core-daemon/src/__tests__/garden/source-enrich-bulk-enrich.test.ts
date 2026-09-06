import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FormationKind,
  GardenRole,
  GardenTaskKind,
  MemoryDimension,
  ScopeClass,
  SourceKind
} from "@do-soul/alaya-protocol";
import { EventPublisher, MemoryService } from "@do-soul/alaya-core";
import {
  initializeSemanticArtifactCandidateSchema,
  initDatabase,
  SqliteEventLogRepo,
  SqliteGardenTaskRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createSourceEnrichmentRuntime } from "../../garden/bulk-enrich/source-enrichment-runtime.js";
import { runBulkEnrichTask } from "../../garden/bulk-enrich/bulk-enrich-runtime-runner.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("per-source bulk_enrich routing", () => {
  it("does not claim enrich_pending when the task carries source enrichment identity", async () => {
    const claimBatch = vi.fn(() => []);
    const reportCompletion = vi.fn(async () => undefined);
    await runBulkEnrichTask({
      now: () => "2026-05-31T12:00:00.000Z",
      task: {
        task_id: "source_enrich_fixture",
        task_kind: GardenTaskKind.BULK_ENRICH,
        required_tier: "tier_2",
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_refs: ["memory-1"],
        priority: 20,
        created_at: "2026-05-31T12:00:00.000Z",
        source_object_id: "memory-1",
        source_revision: 0,
        enrichment_contract: "source_enrichment.v1"
      },
      availability: {
        kind: "ready",
        ports: {
          enrichPendingRepo: {
            claimBatch,
            markProcessed: vi.fn(),
            recordFailedAttempt: vi.fn(),
            delete: vi.fn(),
            countPending: vi.fn(() => 1)
          },
          memoryLookup: { findById: vi.fn() },
          edgeProducer: { produceForNewMemory: vi.fn() },
          conflictDetection: { detectAndLinkConflicts: vi.fn() },
          signalLookup: { getById: vi.fn() },
          signalRefReplay: { replaySignalRefs: vi.fn() }
        }
      },
      reporter: {
        emitEnrichAbandoned: vi.fn(),
        reportCompletion,
        warn: vi.fn()
      }
    });
    expect(claimBatch).not.toHaveBeenCalled();
    expect(reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "source_enrich_fixture" }),
      "2026-05-31T12:00:00.000Z",
      false,
      ["source_enrich_unwired"],
      expect.any(Error)
    );
  });

  it("runs a scheduler-claimed per-source task through adoptClaim without draining enrich_pending", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    initializeSemanticArtifactCandidateSchema(database.connection);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const notify = { notify: async () => undefined, notifyEntry: async () => undefined };
    const eventPublisher = new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: () => undefined },
      runtimeNotifier: notify
    });
    const garden = new SqliteGardenTaskRepo(database.connection, eventPublisher);
    const memory = new MemoryService({
      now: () => "2026-05-31T12:00:00.000Z",
      generateObjectId: () => "aaaaaaaa-aaaa-4aaa-8aaa-000000000011",
      evidenceService: { findById: async () => null },
      eventLogRepo,
      memoryEntryRepo: new SqliteMemoryEntryRepo(database),
      gardenIntentPort: garden,
      runtimeNotifier: notify
    });
    await memory.create({
      created_by: "user_action",
      dimension: MemoryDimension.PROCEDURE,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content: "Alice owns Orion",
      domain_tags: [],
      evidence_refs: [],
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      enqueueEnrichment: { runId: "run-1", sourceSignalId: null }
    });
    const pending = garden.peekPending(GardenRole.LIBRARIAN, "workspace-1", 8)[0];
    expect(pending).toBeDefined();
    expect(await garden.claimAtomic(pending!.id, "librarian-1", "2026-05-31T12:00:01.000Z", "workspace-1"))
      .toBe("claimed");
    const execute = vi.fn(async (request: string) => {
      const unit = JSON.parse(request) as { text: string };
      return JSON.stringify({
        signals: [{ object_kind: "decision", confidence: 0.8, matched_text: unit.text, distilled_fact: unit.text }]
      });
    });
    const runtime = createSourceEnrichmentRuntime({
      connection: database.connection,
      gardenTaskRepo: garden,
      eventPublisher,
      now: () => "2026-05-31T12:00:02.000Z",
      transport: { execute, reconcile: async () => ({ kind: "unknown" }) }
    });
    const claimBatch = vi.fn(() => []);
    const reportCompletion = vi.fn(async () => undefined);
    const task = {
      task_id: pending!.id,
      task_kind: GardenTaskKind.BULK_ENRICH,
      required_tier: "tier_2" as const,
      workspace_id: "workspace-1",
      run_id: "run-1",
      target_object_refs: ["aaaaaaaa-aaaa-4aaa-8aaa-000000000011"],
      priority: 20,
      created_at: "2026-05-31T12:00:00.000Z",
      source_object_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000011",
      source_revision: 1,
      enrichment_contract: "source_enrichment.v1"
    };
    await runBulkEnrichTask({
      now: () => "2026-05-31T12:00:02.000Z",
      task,
      availability: {
        kind: "ready",
        ports: {
          enrichPendingRepo: {
            claimBatch,
            markProcessed: vi.fn(),
            recordFailedAttempt: vi.fn(),
            delete: vi.fn(),
            countPending: vi.fn(() => 1)
          },
          memoryLookup: { findById: vi.fn() },
          edgeProducer: { produceForNewMemory: vi.fn() },
          conflictDetection: { detectAndLinkConflicts: vi.fn() },
          signalLookup: { getById: vi.fn() },
          signalRefReplay: { replaySignalRefs: vi.fn() }
        }
      },
      reporter: { emitEnrichAbandoned: vi.fn(), reportCompletion, warn: vi.fn() },
      sourceEnrichment: runtime
    });
    expect(runtime).toBeDefined();
    expect(claimBatch).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: pending!.id }),
      "2026-05-31T12:00:02.000Z",
      true,
      ["source_enrich:completed"],
      undefined
    );
    execute.mockClear();
    reportCompletion.mockClear();
    await runBulkEnrichTask({
      now: () => "2026-05-31T12:00:03.000Z",
      task,
      availability: {
        kind: "ready",
        ports: {
          enrichPendingRepo: {
            claimBatch,
            markProcessed: vi.fn(),
            recordFailedAttempt: vi.fn(),
            delete: vi.fn(),
            countPending: vi.fn(() => 1)
          },
          memoryLookup: { findById: vi.fn() },
          edgeProducer: { produceForNewMemory: vi.fn() },
          conflictDetection: { detectAndLinkConflicts: vi.fn() },
          signalLookup: { getById: vi.fn() },
          signalRefReplay: { replaySignalRefs: vi.fn() }
        }
      },
      reporter: { emitEnrichAbandoned: vi.fn(), reportCompletion, warn: vi.fn() },
      sourceEnrichment: runtime
    });
    expect(execute).not.toHaveBeenCalled();
    expect(claimBatch).not.toHaveBeenCalled();
  });
});
