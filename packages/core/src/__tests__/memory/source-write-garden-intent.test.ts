import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  GardenRole,
  MemoryDimension,
  ScopeClass,
  SignalEventType,
  SourceKind
} from "@do-soul/alaya-protocol";
import {
  SqliteGardenTaskRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EvidenceService } from "../../memory/evidence-service.js";
import { MemoryService } from "../../memory/memory-service.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import {
  SOURCE_ENRICHMENT_CONTRACT,
  admitSourceEnrichmentIntent,
  buildSourceEnrichmentTaskId
} from "../../memory/source-write-garden-intent.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallEmbeddingRealStorage
} from "../shared/real-sqlite.test-support.js";

const databases = new Set<StorageDatabase>();
const NOW = "2026-09-06T00:00:00.000Z";
const WS = REAL_SQLITE_TEST_WORKSPACE_ID;
const RUN = REAL_SQLITE_TEST_RUN_ID;
const IDS = Object.freeze({
  checklist: "aaaaaaaa-aaaa-4aaa-8aaa-000000000011",
  one: "aaaaaaaa-aaaa-4aaa-8aaa-000000000012",
  a: "aaaaaaaa-aaaa-4aaa-8aaa-000000000013",
  b: "aaaaaaaa-aaaa-4aaa-8aaa-000000000014",
  mutate: "aaaaaaaa-aaaa-4aaa-8aaa-000000000015",
  foreign: "aaaaaaaa-aaaa-4aaa-8aaa-000000000016",
  missingEvidence: "bbbbbbbb-bbbb-4bbb-8bbb-000000000099",
  evidence: "bbbbbbbb-bbbb-4bbb-8bbb-000000000011"
});

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("W00 durable write garden intent", () => {
  it("A1 acknowledges a write with no extraction transport and keeps source plus event durable", async () => {
    const harness = await openHarness();
    const created = await harness.writeMemory(IDS.checklist, "deployment checklist lives in docs/runbook.md");
    expect(created.object_id).toBe(IDS.checklist);
    expect(await harness.storage.memoryEntryRepo.findById(IDS.checklist)).not.toBeNull();
    expect(await harness.storage.eventLogRepo.queryByEntity("memory_entry", IDS.checklist)).toHaveLength(1);
    const pending = harness.garden.peekPending(GardenRole.LIBRARIAN, WS, 8);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    const hits = await harness.storage.memoryEntryRepo.searchByKeyword(WS, "deployment checklist", 5);
    expect(hits.map((row) => row.object_id)).toContain(IDS.checklist);
  });

  it("A2 duplicate race coalesces one work intent under the sqlite unique key", async () => {
    const harness = await openHarness();
    const created = await harness.writeMemory(IDS.one, "same text");
    const revision = (await harness.storage.eventLogRepo.queryByEntity("memory_entry", created.object_id))[0]!.revision;
    const first = admitSourceEnrichmentIntent(harness.garden, {
      workspaceId: WS,
      sourceObjectId: created.object_id,
      sourceRevision: revision,
      enrichmentContract: SOURCE_ENRICHMENT_CONTRACT,
      runId: RUN,
      createdAt: NOW
    });
    const second = admitSourceEnrichmentIntent(harness.garden, {
      workspaceId: WS,
      sourceObjectId: created.object_id,
      sourceRevision: revision,
      enrichmentContract: SOURCE_ENRICHMENT_CONTRACT,
      runId: RUN,
      createdAt: NOW
    });
    expect(first.coalesced).toBe(true);
    expect(second.coalesced).toBe(true);
    expect(first.task_id).toBe(second.task_id);
    expect(harness.garden.peekPending(GardenRole.LIBRARIAN, WS, 8)).toHaveLength(1);
    expect(() =>
      harness.garden.enqueue({
        id: first.task_id,
        workspace_id: WS,
        role: GardenRole.LIBRARIAN,
        kind: "bulk_enrich",
        payload: {
          task_id: first.task_id,
          task_kind: "bulk_enrich",
          required_tier: "tier_2",
          workspace_id: WS,
          run_id: RUN,
          target_object_refs: [created.object_id],
          priority: 20,
          created_at: NOW,
          source_object_id: "other-source",
          source_revision: revision,
          enrichment_contract: SOURCE_ENRICHMENT_CONTRACT
        },
        created_at: NOW
      })
    ).toThrow(/different payload/);
  });

  it("A3 distinct occurrences of identical text keep separate source bindings", async () => {
    const harness = await openHarness();
    await harness.writeMemory(IDS.a, "identical observation text");
    await harness.writeMemory(IDS.b, "identical observation text");
    expect(await harness.storage.memoryEntryRepo.findById(IDS.a)).not.toBeNull();
    expect(await harness.storage.memoryEntryRepo.findById(IDS.b)).not.toBeNull();
    expect(harness.garden.peekPending(GardenRole.LIBRARIAN, WS, 8)).toHaveLength(2);
  });

  it("A4 input mutation and foreign-workspace evidence still fail closed", async () => {
    const harness = await openHarness();
    const intentFields = { runId: RUN, sourceSignalId: "signal-1" };
    harness.queueMemoryId(IDS.mutate);
    const pending = harness.memory.create(
      memoryInput("mutation probe", { enqueueEnrichment: intentFields })
    );
    intentFields.runId = "attacker-run";
    const created = await pending;
    const task = harness.garden.peekPending(GardenRole.LIBRARIAN, WS, 8)[0];
    expect((task?.payload as { readonly run_id?: string }).run_id).toBe(RUN);
    await expect(
      harness.writeMemory(IDS.foreign, "foreign evidence", { evidence_refs: [IDS.missingEvidence] })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await harness.storage.memoryEntryRepo.findById(IDS.foreign)).toBeNull();
    expect(created.object_id).toBe(IDS.mutate);
  });

  it("does not also write enrich_pending when the Garden intent port is wired", async () => {
    const enrichPending: Array<{ readonly memoryId: string }> = [];
    const storage = await createRecallEmbeddingRealStorage((database) => databases.add(database));
    const notify = { notify: async () => {}, notifyEntry: async () => {} };
    const eventPublisher = new EventPublisher({
      eventLogRepo: storage.eventLogRepo,
      runHotStateService: { apply: () => {} },
      runtimeNotifier: notify
    });
    const garden = new SqliteGardenTaskRepo(storage.database.connection, eventPublisher);
    const memory = new MemoryService({
      now: () => NOW,
      generateObjectId: () => IDS.checklist,
      evidenceService: {
        findById: async (id) => storage.evidenceCapsuleRepo.findById(id),
        findByIds: async (workspaceId, objectIds) =>
          storage.evidenceCapsuleRepo.findByIds?.(workspaceId, objectIds) ?? []
      },
      eventLogRepo: storage.eventLogRepo,
      memoryEntryRepo: storage.memoryEntryRepo,
      gardenIntentPort: garden,
      enrichPendingWriter: {
        enqueue: (input) => {
          enrichPending.push({ memoryId: input.memoryId });
        }
      },
      runtimeNotifier: notify
    });
    await memory.create(memoryInput("deployment checklist lives in docs/runbook.md"));
    expect(garden.peekPending(GardenRole.LIBRARIAN, WS, 8)).toHaveLength(1);
    expect(enrichPending).toEqual([]);
  });

  it("evidence create enqueues recoverable intent on the same connection", async () => {
    const harness = await openHarness();
    harness.queueEvidenceId(IDS.evidence);
    const evidence = await harness.evidence.create(
      evidenceInput("checklist excerpt"),
      [],
      undefined,
      undefined,
      { runId: RUN, sourceSignalId: null }
    );
    expect(await harness.storage.evidenceCapsuleRepo.findById(evidence.object_id)).not.toBeNull();
    const expectedId = buildSourceEnrichmentTaskId(
      WS,
      evidence.object_id,
      (await harness.storage.eventLogRepo.queryByEntity("evidence_capsule", evidence.object_id))[0]!.revision,
      SOURCE_ENRICHMENT_CONTRACT
    );
    expect(harness.garden.findById(expectedId)?.status).toBe("pending");
  });
});

async function openHarness() {
  const storage = await createRecallEmbeddingRealStorage((database) => databases.add(database));
  const notify = { notify: async () => {}, notifyEntry: async () => {} };
  const eventPublisher = new EventPublisher({
    eventLogRepo: storage.eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier: notify
  });
  const garden = new SqliteGardenTaskRepo(storage.database.connection, eventPublisher);
  const memoryIds: string[] = [];
  const evidenceIds: string[] = [];
  const memory = new MemoryService({
    now: () => NOW,
    generateObjectId: () => {
      const id = memoryIds.shift();
      if (id === undefined) throw new Error("memory id queue empty");
      return id;
    },
    evidenceService: {
      findById: async (id) => storage.evidenceCapsuleRepo.findById(id),
      findByIds: async (workspaceId, objectIds) =>
        storage.evidenceCapsuleRepo.findByIds?.(workspaceId, objectIds) ?? []
    },
    eventLogRepo: storage.eventLogRepo,
    memoryEntryRepo: storage.memoryEntryRepo,
    gardenIntentPort: garden,
    runtimeNotifier: notify
  });
  const evidence = new EvidenceService({
    now: () => NOW,
    generateObjectId: () => {
      const id = evidenceIds.shift();
      if (id === undefined) throw new Error("evidence id queue empty");
      return id;
    },
    eventLogRepo: storage.eventLogRepo,
    evidenceCapsuleRepo: storage.evidenceCapsuleRepo,
    gardenIntentPort: garden,
    runtimeNotifier: notify
  });
  return {
    storage,
    garden,
    memory,
    evidence,
    queueMemoryId: (id: string) => {
      memoryIds.push(id);
    },
    queueEvidenceId: (id: string) => {
      evidenceIds.push(id);
    },
    writeMemory: async (
      id: string,
      content: string,
      overrides: Partial<{
        readonly evidence_refs: readonly string[];
        readonly enqueueEnrichment: { runId: string | null; sourceSignalId: string | null };
      }> = {}
    ) => {
      memoryIds.push(id);
      return memory.create(memoryInput(content, overrides));
    }
  };
}

function memoryInput(
  content: string,
  overrides: Partial<{
    readonly evidence_refs: readonly string[];
    readonly enqueueEnrichment: { runId: string | null; sourceSignalId: string | null };
  }> = {}
) {
  return {
    created_by: "user_action" as const,
    dimension: MemoryDimension.PROCEDURE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content,
    domain_tags: [],
    evidence_refs: overrides.evidence_refs ?? [],
    workspace_id: WS,
    run_id: RUN,
    surface_id: null,
    enqueueEnrichment: overrides.enqueueEnrichment ?? { runId: RUN, sourceSignalId: null }
  };
}

function evidenceInput(gist: string) {
  return {
    created_by: "user_action" as const,
    evidence_kind: "conversation_excerpt" as const,
    semantic_anchor: { topic: "checklist", keywords: ["checklist"], summary: gist },
    event_anchor: {
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      event_id: "cccccccc-cccc-4ccc-8ccc-000000000001",
      occurred_at: NOW
    },
    physical_anchor: null,
    evidence_health_state: "verified" as const,
    gist,
    excerpt: gist,
    source_hash: null,
    run_id: RUN,
    workspace_id: WS,
    surface_id: null
  };
}
