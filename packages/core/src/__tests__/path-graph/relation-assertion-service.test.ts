import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunMode,
  RunState,
  SignalEventType,
  WorkspaceKind,
  WorkspaceState,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteRelationAssertionRepo,
  SqliteTemporalPathProjectionReader,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { RelationAssertionService } from "../../path-graph/relation-assertions/relation-assertion-service.js";
import type { RelationAssertionAtomicRepoPort } from "../../path-graph/relation-assertions/relation-assertion-service-types.js";
import { EventPublisher } from "../../runtime/event-publisher.js";

const databases = new Set<StorageDatabase>();
const observedAt = "2026-07-17T01:02:03.000Z";

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("RelationAssertionService", () => {
  it("admission is EventLog-first, idempotent, and activates only a typed projection", async () => {
    const harness = await createHarness();
    const sourceEvent = appendSourceSignalEvent(harness);
    await createAnchoredEvidence(harness, sourceEvent.event_id);

    const first = await harness.service.admit(admissionRequest(sourceEvent.event_id));
    const replay = await harness.service.admit({
      ...admissionRequest(sourceEvent.event_id),
      admittedAt: "2026-07-17T01:03:03.000Z"
    });

    expect(first.status).toBe("admitted");
    expect(first.activeProjectionCount).toBe(1);
    expect(replay.status).toBe("already_admitted");
    expect((await harness.eventLogRepo.queryByEntity("relation_assertion", first.assertion.assertion_id)))
      .toHaveLength(1);
    expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1")).toMatchObject([
      { path_id: first.assertion.assertion_id, workspace_id: "workspace-1" }
    ]);
  });

  it("rolls the EventLog admission back when the projection apply phase fails", async () => {
    const harness = await createHarness({ failProjectionActivation: true });
    const sourceEvent = appendSourceSignalEvent(harness);
    await createAnchoredEvidence(harness, sourceEvent.event_id);
    const assertionId = admissionRequest(sourceEvent.event_id).assertionId!;

    await expect(harness.service.admit(admissionRequest(sourceEvent.event_id)))
      .rejects.toThrow("projection activation failed");

    expect(await harness.eventLogRepo.queryByEntity("relation_assertion", assertionId)).toEqual([]);
    expect(harness.relationRepo.getByIdInCurrentTransaction(assertionId)).toBeNull();
    expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1")).toEqual([]);
  });

  it("rejects a replay whose assertion id has a different source-event identity", async () => {
    const harness = await createHarness();
    const sourceEvent = appendSourceSignalEvent(harness);
    await createAnchoredEvidence(harness, sourceEvent.event_id);
    await harness.service.admit(admissionRequest(sourceEvent.event_id));

    const conflictingSourceEvent = appendSourceSignalEvent(harness);
    await expect(harness.service.admit(admissionRequest(conflictingSourceEvent.event_id)))
      .rejects.toThrow(/replay conflicts with immutable assertion/);
  });

  it("keeps a resolved assertion inactive when its admission is replayed", async () => {
    const harness = await createHarness({ now: () => "2026-07-18T01:00:00.000Z" });
    const sourceEvent = appendSourceSignalEvent(harness);
    await createAnchoredEvidence(harness, sourceEvent.event_id);
    const admitted = await harness.service.admit(admissionRequest(sourceEvent.event_id));
    await harness.service.resolve({
      assertionId: admitted.assertion.assertion_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      causedBy: "garden",
      resolutionKind: "retracted",
      reason: "source contradicted",
      resolvedAt: "2026-07-18T00:00:00.000Z"
    });

    await expect(harness.service.admit(admissionRequest(sourceEvent.event_id))).resolves.toMatchObject({
      status: "already_admitted",
      activeProjectionCount: 0
    });
    await expect(harness.relationRepo.findActiveProjectionByWorkspace("workspace-1")).resolves.toEqual([]);
  });

  it("resolves atomically, supports deterministic replay, and rejects EventLog drift", async () => {
    const harness = await createHarness();
    const sourceEvent = appendSourceSignalEvent(harness);
    await createAnchoredEvidence(harness, sourceEvent.event_id);
    const admitted = await harness.service.admit(admissionRequest(sourceEvent.event_id));
    const resolved = await harness.service.resolve({
      assertionId: admitted.assertion.assertion_id,
      workspaceId: "workspace-1",
      runId: "run-1",
      causedBy: "garden",
      resolutionKind: "retracted",
      reason: "source contradicted",
      resolvedAt: "2026-07-18T00:00:00.000Z"
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.activeProjectionCount).toBe(0);
    expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1")).toEqual([]);

    await expect(harness.service.verifyAndRebuild("2026-07-17T12:00:00.000Z"))
      .resolves.toMatchObject({ activeProjectionCount: 1 });
    expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1")).toEqual([]);
    expect(await harness.relationRepo.findProjectionByWorkspaceAtAsOf(
      "workspace-1",
      "2026-07-17T12:00:00.000Z"
    )).toHaveLength(1);
    const projectionReader = new SqliteTemporalPathProjectionReader(harness.relationRepo);
    await expect(projectionReader.findByAnchors(
      "workspace-1",
      [{ kind: "object", object_id: "memory-1" }],
      { asOf: "2026-07-17T12:00:00.000Z" }
    )).resolves.toHaveLength(1);
    await expect(projectionReader.findByAnchors(
      "workspace-1",
      [{ kind: "object", object_id: "memory-1" }],
      { asOf: "2026-07-16T12:00:00.000Z" }
    )).rejects.toThrow(/No verified temporal projection/);

    await expect(harness.service.verifyAndRebuild()).resolves.toMatchObject({
      activeProjectionCount: 1
    });
    expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1")).toHaveLength(1);

    const resolutionEvent = (await harness.eventLogRepo.queryByEntity(
      "relation_assertion",
      admitted.assertion.assertion_id
    )).find((entry) => entry.event_type === "relation.assertion_resolved");
    expect(resolutionEvent).toBeDefined();
    harness.database.connection.prepare(
      "UPDATE event_log SET payload_json = ? WHERE event_id = ?"
    ).run(JSON.stringify({ tampered: true }), resolutionEvent?.event_id);

    await expect(harness.service.verifyAndRebuild()).rejects.toThrow(/resolution EventLog payload is not canonical/);
  });
});

async function createHarness(options: {
  readonly failProjectionActivation?: boolean;
  readonly now?: () => string;
} = {}) {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "relation assertion test",
    root_path: "/tmp/relation-assertion-test",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "relation assertion test",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const relationRepo = new SqliteRelationAssertionRepo(database);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: vi.fn() },
    runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
  });
  const repo = options.failProjectionActivation === true
    ? failingProjectionRepo(relationRepo)
    : relationRepo;
  return {
    database,
    eventLogRepo,
    evidenceRepo: new SqliteEvidenceCapsuleRepo(database),
    relationRepo,
    service: new RelationAssertionService({
      repo,
      eventPublisher,
      eventHistory: eventLogRepo,
      now: options.now ?? (() => "2026-07-17T01:02:04.000Z")
    })
  };
}

function appendSourceSignalEvent(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.eventLogRepo.append({
    event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
    entity_type: "candidate_memory_signal",
    entity_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    caused_by: "garden",
    payload_json: { source: "test" }
  });
}

async function createAnchoredEvidence(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sourceEventId: string
): Promise<void> {
  await harness.evidenceRepo.create({
    object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: observedAt,
    updated_at: observedAt,
    created_by: "garden",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: { topic: "temporal relation", keywords: ["temporal"], summary: "source evidence" },
    event_anchor: {
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      event_id: sourceEventId,
      occurred_at: observedAt
    },
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "source evidence",
    excerpt: "source evidence excerpt",
    source_hash: null,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  } satisfies EvidenceCapsule);
}

function admissionRequest(sourceEventId: string) {
  return {
    assertionId: "assertion-1",
    workspaceId: "workspace-1",
    runId: "run-1",
    causedBy: "garden",
    evidenceIds: ["85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"],
    anchors: {
      source_anchor: { kind: "object" as const, object_id: "memory-1" },
      target_anchor: { kind: "object" as const, object_id: "memory-2" }
    },
    relationKind: "supports",
    validity: { kind: "open" as const, valid_from: observedAt },
    sourceEventAnchor: {
      eventType: SignalEventType.SOUL_SIGNAL_EMITTED,
      eventId: sourceEventId,
      occurredAt: observedAt
    },
    admittedAt: "2026-07-17T01:02:04.000Z"
  };
}

function failingProjectionRepo(repo: SqliteRelationAssertionRepo): RelationAssertionAtomicRepoPort {
  return new Proxy(repo, {
    get(target, property) {
      if (property === "writeProjectionGenerationInCurrentTransaction") {
        return () => {
          throw new Error("projection activation failed");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as RelationAssertionAtomicRepoPort;
}
