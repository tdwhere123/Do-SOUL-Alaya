import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunMode,
  RunState,
  SignalEventType,
  WorkspaceKind,
  WorkspaceState,
  type EventLogEntry,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import {
  digestRelationFormationEventSource,
  initDatabase,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteRelationAssertionRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { RelationAssertionService } from "../../../path-graph/relation-assertions/relation-assertion-service.js";
import type {
  RelationAssertionAdmissionRequest,
  RelationAssertionAtomicRepoPort
} from "../../../path-graph/relation-assertions/relation-assertion-service-types.js";
import { EventPublisher } from "../../../runtime/event-publisher.js";
import { stableStringify } from "../../../shared/stable-stringify.js";

const databases = new Set<StorageDatabase>();
const observedAt = "2026-07-17T01:02:03.000Z";
const evidenceIds = Object.freeze({
  first: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
  second: "95b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
  ordinary: "a5b3671a-d8d8-4848-9e5c-07d0a89f5ae9"
} satisfies Readonly<Record<string, string>>);

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("RelationAssertionService deferred projection", () => {
  it("persists independent admissions before rebuilding and activating one projection generation", async () => {
    const harness = await createHarness();
    const first = await prepareAdmission(harness, "first");
    const second = await prepareAdmission(harness, "second");
    const third = await prepareAdmission(harness, "ordinary");
    const service = harness.service;

    const firstResult = await service.admit(first);
    const secondResult = await service.admitDeferredProjection(second);
    const thirdResult = await service.admitDeferredProjection(third);

    expect(firstResult).toMatchObject({ status: "admitted", assertion: { assertion_id: "assertion-first" } });
    expect(secondResult).toMatchObject({ status: "admitted", assertion: { assertion_id: "assertion-second" } });
    expect(thirdResult).toMatchObject({ status: "admitted", assertion: { assertion_id: "assertion-ordinary" } });
    expect(await harness.eventLogRepo.queryByEntity("relation_assertion", "assertion-first"))
      .toHaveLength(1);
    expect(await harness.eventLogRepo.queryByEntity("relation_assertion", "assertion-second"))
      .toHaveLength(1);
    expect(harness.relationRepo.listAssertionsInCurrentTransaction()).toHaveLength(3);
    await expect(harness.relationRepo.findActiveProjectionByWorkspace("workspace-1"))
      .rejects.toThrow(/requires a refresh/u);
    expect(harness.projectionCalls).toEqual({ listAssertions: 1, listResolutions: 1, writes: 1 });

    await expect(service.refreshProjection()).resolves.toMatchObject({ activeProjectionCount: 3 });

    expect(harness.projectionCalls).toEqual({ listAssertions: 2, listResolutions: 2, writes: 2 });
    expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1"))
      .toHaveLength(3);

    const checkpointed = readProjectionSnapshot(harness.database);
    for (const request of [first, second, third]) {
      await expect(service.admit(request)).resolves.toMatchObject({ status: "already_admitted" });
    }
    expect(readProjectionSnapshot(harness.database)).toEqual(checkpointed);
    for (const suffix of ["first", "second", "ordinary"]) {
      expect(await harness.eventLogRepo.queryByEntity(
        "relation_assertion",
        `assertion-${suffix}`
      )).toHaveLength(1);
    }
  });

  it("keeps ordinary admission on the immediate projection path", async () => {
    const harness = await createHarness();
    const request = await prepareAdmission(harness, "ordinary");

    await expect(harness.service.admit(request)).resolves.toMatchObject({
      status: "admitted",
      activeProjectionCount: 1
    });

    expect(harness.projectionCalls).toEqual({ listAssertions: 1, listResolutions: 1, writes: 1 });
    expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1"))
      .toHaveLength(1);
  });
});

async function createHarness() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "deferred projection test",
    root_path: "/tmp/relation-assertion-deferred-projection-test",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "deferred projection test",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const relationRepo = new SqliteRelationAssertionRepo(database);
  const { repo, calls: projectionCalls } = trackedProjectionRepo(relationRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: vi.fn() },
    runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
  });
  return {
    database,
    eventLogRepo,
    evidenceRepo: new SqliteEvidenceCapsuleRepo(database),
    relationRepo,
    projectionCalls,
    service: new RelationAssertionService({
      repo,
      eventPublisher,
      eventHistory: eventLogRepo,
      now: () => "2026-07-17T01:02:04.000Z"
    })
  };
}

async function prepareAdmission(
  harness: Awaited<ReturnType<typeof createHarness>>,
  suffix: string
): Promise<RelationAssertionAdmissionRequest> {
  const sourceEvent = await harness.eventLogRepo.append({
    event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
    entity_type: "candidate_memory_signal",
    entity_id: `signal-${suffix}`,
    workspace_id: "workspace-1",
    run_id: "run-1",
    caused_by: "garden",
    payload_json: { source: "test", suffix }
  });
  const evidenceId = evidenceIds[suffix];
  if (evidenceId === undefined) throw new Error(`Missing evidence fixture for ${suffix}.`);
  await createAnchoredEvidence(harness, sourceEvent.event_id, evidenceId);
  return admissionRequest(sourceEvent, evidenceId, suffix);
}

async function createAnchoredEvidence(
  harness: Awaited<ReturnType<typeof createHarness>>,
  sourceEventId: string,
  evidenceId: string
): Promise<void> {
  await harness.evidenceRepo.create({
    object_id: evidenceId,
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

function admissionRequest(
  sourceEvent: Readonly<EventLogEntry>,
  evidenceId: string,
  suffix: string
): RelationAssertionAdmissionRequest {
  const parameters = { relation_kind: "supports" };
  const decision = { source_event_ids: [sourceEvent.event_id] };
  return {
    assertionId: `assertion-${suffix}`,
    workspaceId: "workspace-1",
    runId: "run-1",
    causedBy: "garden",
    evidenceReceipts: [{
      evidence_id: evidenceId,
      source_event_anchor: {
        event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
        event_id: sourceEvent.event_id,
        occurred_at: observedAt
      }
    }],
    formationReceipt: {
      operator_id: "test_relation_operator_v1",
      operator_sha256: "a".repeat(64),
      parameters,
      parameter_sha256: digest(parameters),
      source_observations: [{
        source_kind: "event_log_entry",
        source_id: sourceEvent.event_id,
        source_sha256: digestRelationFormationEventSource(sourceEvent)
      }],
      decision,
      decision_sha256: digest(decision)
    },
    anchors: {
      source_anchor: { kind: "object", object_id: `memory-${suffix}-source` },
      target_anchor: { kind: "object", object_id: `memory-${suffix}-target` }
    },
    relationKind: "supports",
    validity: { kind: "open", valid_from: observedAt },
    admittedAt: "2026-07-17T01:02:04.000Z"
  };
}

function trackedProjectionRepo(repo: SqliteRelationAssertionRepo): {
  readonly repo: RelationAssertionAtomicRepoPort;
  readonly calls: { listAssertions: number; listResolutions: number; writes: number };
} {
  const calls = { listAssertions: 0, listResolutions: 0, writes: 0 };
  const tracked = new Proxy(repo, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === "listAssertionsInCurrentTransaction") calls.listAssertions += 1;
        if (property === "listCurrentResolutionsInCurrentTransaction") calls.listResolutions += 1;
        if (property === "writeProjectionGenerationInCurrentTransaction") calls.writes += 1;
        return Reflect.apply(value, target, args);
      };
    }
  });
  return { repo: tracked as RelationAssertionAtomicRepoPort, calls };
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function readProjectionSnapshot(database: StorageDatabase) {
  const state = database.connection.prepare(`
    SELECT active_projection_generation, history_digest, projection_digest,
           projection_count, projection_refresh_required
    FROM temporal_schema_state
    WHERE state_id = 1
  `).get();
  const projections = database.connection.prepare(`
    SELECT path_id, assertion_id, projection_json
    FROM relation_path_projections
    WHERE generation = (
      SELECT active_projection_generation FROM temporal_schema_state WHERE state_id = 1
    )
    ORDER BY path_id ASC
  `).all();
  return { state, projections };
}
