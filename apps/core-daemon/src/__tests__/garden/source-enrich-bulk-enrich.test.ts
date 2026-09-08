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
const NOW = "2026-05-31T12:00:00.000Z";
const WS = "workspace-1";

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function signalResponse(request: string): string {
  const unit = JSON.parse(request) as { text: string };
  return JSON.stringify({
    signals: [{ object_kind: "decision", confidence: 0.8, matched_text: unit.text, distilled_fact: unit.text }]
  });
}

function count(database: StorageDatabase, table: string): number {
  return (database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function sourceHarness() {
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
  let nextId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011";
  const memory = new MemoryService({
    now: () => NOW,
    generateObjectId: () => nextId,
    evidenceService: { findById: async () => null },
    eventLogRepo,
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    gardenIntentPort: garden,
    runtimeNotifier: notify
  });
  async function write(id: string, content: string) {
    nextId = id;
    await memory.create({
      created_by: "user_action",
      dimension: MemoryDimension.PROCEDURE,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content,
      domain_tags: [],
      evidence_refs: [],
      workspace_id: WS,
      run_id: "run-1",
      surface_id: null,
      enqueueEnrichment: { runId: "run-1", sourceSignalId: null }
    });
    const pending = garden.peekPending(GardenRole.LIBRARIAN, WS, 8)
      .find((row) => (row.payload as { source_object_id?: string }).source_object_id === id);
    if (pending === undefined) throw new Error(`missing source enrichment intent for ${id}`);
    expect(await garden.claimAtomic(pending.id, "librarian-1", "2026-05-31T12:00:01.000Z", WS)).toBe("claimed");
    return pending.id;
  }
  return { database, garden, memory, eventPublisher, write };
}

function descriptor(taskId: string, objectId: string) {
  return {
    task_id: taskId,
    task_kind: GardenTaskKind.BULK_ENRICH,
    required_tier: "tier_2" as const,
    workspace_id: WS,
    run_id: "run-1",
    target_object_refs: [objectId],
    priority: 20,
    created_at: NOW,
    source_object_id: objectId,
    source_revision: 1,
    enrichment_contract: "source_enrichment.v1"
  };
}

async function runTask(
  task: ReturnType<typeof descriptor>,
  sourceEnrichment: ReturnType<typeof createSourceEnrichmentRuntime>
) {
  const claimBatch = vi.fn(() => []);
  const reportCompletion = vi.fn(async () => undefined);
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
          countPending: vi.fn(() => 1),
          reclaimStale: vi.fn(() => 0)
        },
        memoryLookup: { findById: vi.fn() },
        edgeProducer: { produceForNewMemory: vi.fn() },
        conflictDetection: { detectAndLinkConflicts: vi.fn() },
        signalLookup: { getById: vi.fn() },
        signalRefReplay: { replaySignalRefs: vi.fn() }
      }
    },
    reporter: { emitEnrichAbandoned: vi.fn(), reportCompletion, warn: vi.fn() },
    sourceEnrichment
  });
  return { claimBatch, reportCompletion };
}

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
            countPending: vi.fn(() => 1),
          reclaimStale: vi.fn(() => 0)
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
      [
        "source_enrich_unwired",
        "source_enrich_capability:unconfigured",
        "source_enrich_spend:unsupported",
        "source_enrich_completion_tokens:unsupported",
        "source_enrich_family:none"
      ],
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
            countPending: vi.fn(() => 1),
          reclaimStale: vi.fn(() => 0)
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
      [
        "source_enrich:completed",
        "source_enrich_capability:configured",
        "source_enrich_spend:unsupported",
        "source_enrich_completion_tokens:unsupported",
        "source_enrich_family:official_api_signals"
      ],
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
            countPending: vi.fn(() => 1),
          reclaimStale: vi.fn(() => 0)
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

  it("reports an unconfigured provider port as unavailable without dispatching", async () => {
    const h = await sourceHarness();
    const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011";
    const taskId = await h.write(objectId, "Alice owns Orion");
    const runtime = createSourceEnrichmentRuntime({
      connection: h.database.connection,
      gardenTaskRepo: h.garden,
      eventPublisher: h.eventPublisher,
      now: () => "2026-05-31T12:00:02.000Z"
    });
    expect(runtime?.capability).toEqual({
      configured: false,
      observationFamily: "none",
      requestBytes: "reserved",
      completionTokens: "unsupported",
      spend: "unsupported"
    });
    const { claimBatch, reportCompletion } = await runTask(descriptor(taskId, objectId), runtime);
    expect(claimBatch).not.toHaveBeenCalled();
    expect(reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: taskId }),
      "2026-05-31T12:00:02.000Z",
      false,
      [
        "source_enrich:transport_unconfigured",
        "source_enrich_capability:unconfigured",
        "source_enrich_spend:unsupported",
        "source_enrich_completion_tokens:unsupported",
        "source_enrich_family:none"
      ],
      expect.any(Error)
    );
    expect(count(h.database, "garden_semantic_artifacts")).toBe(0);
  });

  it("runs a fake provider through the extract composition port and keeps spend unsupported", async () => {
    const h = await sourceHarness();
    const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011";
    const taskId = await h.write(objectId, "Alice owns Orion");
    const extract = vi.fn(async ({ userPrompt }: { userPrompt: string; systemPrompt: string }) => ({
      rawJson: signalResponse(userPrompt)
    }));
    const runtime = createSourceEnrichmentRuntime({
      connection: h.database.connection,
      gardenTaskRepo: h.garden,
      eventPublisher: h.eventPublisher,
      now: () => "2026-05-31T12:00:02.000Z",
      provider: { extract }
    });
    expect(runtime?.capability).toMatchObject({
      configured: true,
      observationFamily: "official_api_signals",
      spend: "unsupported",
      completionTokens: "unsupported"
    });
    const { claimBatch, reportCompletion } = await runTask(descriptor(taskId, objectId), runtime);
    expect(claimBatch).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]?.[0]?.systemPrompt.length).toBeGreaterThan(0);
    expect(reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: taskId }),
      "2026-05-31T12:00:02.000Z",
      true,
      [
        "source_enrich:completed",
        "source_enrich_capability:configured",
        "source_enrich_spend:unsupported",
        "source_enrich_completion_tokens:unsupported",
        "source_enrich_family:official_api_signals"
      ],
      undefined
    );
  });

  it("rejects an oversized composed completion and reuses a cached artifact without a provider", async () => {
    const h = await sourceHarness();
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011";
    const oversizedId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000012";
    const reuseId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000013";
    const oversizedTask = await h.write(oversizedId, "Bob owns Vega");
    const huge = JSON.stringify({
      signals: [{ object_kind: "decision", confidence: 0.8, matched_text: "x".repeat(8_000), distilled_fact: "x" }]
    });
    const oversizedRuntime = createSourceEnrichmentRuntime({
      connection: h.database.connection,
      gardenTaskRepo: h.garden,
      eventPublisher: h.eventPublisher,
      now: () => "2026-05-31T12:00:02.000Z",
      maxCompletionUtf8Bytes: 256,
      provider: { extract: async () => ({ rawJson: huge }) }
    });
    const oversized = await runTask(descriptor(oversizedTask, oversizedId), oversizedRuntime);
    expect(oversized.reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: oversizedTask }),
      "2026-05-31T12:00:02.000Z",
      false,
      expect.arrayContaining(["source_enrich:completion_limit_exceeded", "source_enrich_spend:unsupported"]),
      expect.any(Error)
    );
    expect(count(h.database, "garden_semantic_artifacts")).toBe(0);

    const extract = vi.fn(async ({ userPrompt }: { userPrompt: string }) => ({
      rawJson: signalResponse(userPrompt)
    }));
    const firstTask = await h.write(firstId, "Alice owns Orion");
    const configured = createSourceEnrichmentRuntime({
      connection: h.database.connection,
      gardenTaskRepo: h.garden,
      eventPublisher: h.eventPublisher,
      now: () => "2026-05-31T12:00:02.000Z",
      provider: { extract }
    });
    await runTask(descriptor(firstTask, firstId), configured);
    expect(extract).toHaveBeenCalledTimes(1);
    const reuseTask = await h.write(reuseId, "Alice owns Orion");
    const unconfigured = createSourceEnrichmentRuntime({
      connection: h.database.connection,
      gardenTaskRepo: h.garden,
      eventPublisher: h.eventPublisher,
      now: () => "2026-05-31T12:00:02.000Z"
    });
    const reused = await runTask(descriptor(reuseTask, reuseId), unconfigured);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(reused.reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: reuseTask }),
      "2026-05-31T12:00:02.000Z",
      true,
      expect.arrayContaining(["source_enrich:completed", "source_enrich_capability:unconfigured"]),
      undefined
    );
  });

  it("does not publish a stale source completion from the composed provider port", async () => {
    const h = await sourceHarness();
    const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011";
    const taskId = await h.write(objectId, "Alice owns Orion");
    const runtime = createSourceEnrichmentRuntime({
      connection: h.database.connection,
      gardenTaskRepo: h.garden,
      eventPublisher: h.eventPublisher,
      now: () => "2026-05-31T12:00:02.000Z",
      provider: {
        extract: async ({ userPrompt }) => {
          await h.memory.updateScoped(objectId, WS, { content: "Bob owns Orion" }, "source revision", {
            runId: "run-1",
            sourceSignalId: null
          });
          return { rawJson: signalResponse(userPrompt) };
        }
      }
    });
    const { claimBatch, reportCompletion } = await runTask(descriptor(taskId, objectId), runtime);
    expect(claimBatch).not.toHaveBeenCalled();
    expect(reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: taskId }),
      "2026-05-31T12:00:02.000Z",
      false,
      expect.arrayContaining(["source_enrich:superseded_source", "source_enrich_spend:unsupported"]),
      expect.any(Error)
    );
    expect(count(h.database, "garden_semantic_projections")).toBe(0);
    expect(count(h.database, "garden_semantic_bindings")).toBe(0);
  });

  it("retains uncertain completion when the composed provider ignores cancellation", async () => {
    const h = await sourceHarness();
    const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000011";
    const taskId = await h.write(objectId, "Alice owns Orion");
    let signal: AbortSignal | undefined;
    const extract = vi.fn(async (input: { abortSignal?: AbortSignal }) => {
      signal = input.abortSignal;
      return new Promise<{ rawJson: string }>(() => undefined);
    });
    const runtime = createSourceEnrichmentRuntime({
      connection: h.database.connection,
      gardenTaskRepo: h.garden,
      eventPublisher: h.eventPublisher,
      now: () => "2026-05-31T12:00:02.000Z",
      transportTimeoutMs: 100,
      provider: { extract }
    });
    const { claimBatch, reportCompletion } = await runTask(descriptor(taskId, objectId), runtime);
    expect(claimBatch).not.toHaveBeenCalled();
    expect(reportCompletion).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
    expect(count(h.database, "garden_semantic_artifacts")).toBe(0);
    expect(h.garden.findById(taskId)?.status).not.toBe("completed");
  });
});
