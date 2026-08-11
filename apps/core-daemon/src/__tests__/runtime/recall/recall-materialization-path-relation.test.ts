import { afterEach, describe, expect, it, vi } from "vitest";
import { EventPublisher, RelationAssertionService } from "@do-soul/alaya-core";
import {
  RunMode,
  RunState,
  SignalEventType,
  WorkspaceKind,
  WorkspaceState,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import {
  SqliteCoUsageCounterRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteProposalRepo,
  SqliteRelationAssertionRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";
import { createRuntimeNotifier } from "../../../runtime/daemon/support/runtime-notifier.js";
import { createPathRelationRuntime } from "../../../runtime/recall-materialization/recall-materialization-path-relation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Garden temporal relation runtime", () => {
  it.each([
    ["fresh default", undefined],
    ["selected temporal projection", true]
  ] as const)("exposes only temporal assertion admission for %s", async (_mode, temporalProjectionSelected) => {
    const database = initDatabase({ filename: ":memory:" });
    let pathRelationEvictionTimer: NodeJS.Timeout | null = null;
    try {
      const eventLogRepo = new SqliteEventLogRepo(database);
      const runtimeNotifier = createRuntimeNotifier();
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: async () => undefined },
        runtimeNotifier
      });
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const warn = vi.fn();
      const runtime = createPathRelationRuntime({
        coUsageCounterRepo: new SqliteCoUsageCounterRepo(database),
        eventLogRepo,
        eventPublisher,
        memoryEntryRepo: new SqliteMemoryEntryRepo(database),
        pathFailureHealthInboxPort: { recordPathRelationFailure: async () => undefined },
        pathRelationRepo,
        proposalRepo: new SqliteProposalRepo(database),
        relationAssertionRepo: new SqliteRelationAssertionRepo(database),
        runtimeNotifier,
        ...(temporalProjectionSelected === undefined ? {} : { temporalProjectionSelected }),
        warn
      });
      pathRelationEvictionTimer = runtime.pathRelationEvictionTimer;

      expect(runtime.temporalRelationAssertionPort.admit).toEqual(expect.any(Function));
      expect(runtime).not.toHaveProperty("pathCandidatePort");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      if (pathRelationEvictionTimer !== null) clearInterval(pathRelationEvictionTimer);
      database.close();
    }
  });

  it.each([
    ["default", undefined, "admit", false],
    ["explicit checkpoint", "explicit_checkpoint", "admitDeferredProjection", true]
  ] as const)("routes %s signal-ref admission through the selected projection path", async (
    _label,
    relationProjectionAdmissionMode,
    expectedMethod,
    projectionDirty
  ) => {
    const admit = vi.spyOn(RelationAssertionService.prototype, "admit");
    const admitDeferred = vi.spyOn(RelationAssertionService.prototype, "admitDeferredProjection");
    const refresh = vi.spyOn(RelationAssertionService.prototype, "refreshProjection");
    const harness = await createAdmissionHarness(relationProjectionAdmissionMode);
    try {
      await harness.runtime.temporalRelationAssertionPort.admit({
        workspaceId: "workspace-1",
        runId: "run-1",
        sourceSignalId: "signal-1",
        evidenceIds: ["85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"],
        anchors: {
          source_anchor: { kind: "object", object_id: "memory-1" },
          target_anchor: { kind: "object", object_id: "memory-2" }
        },
        relationKind: "supports",
        validity: { kind: "open", valid_from: "2026-07-17T01:02:03.000Z" },
        sourceEventAnchor: {
          event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
          event_id: harness.sourceEventId,
          occurred_at: "2026-07-17T01:02:03.000Z"
        }
      });

      expect(admit).toHaveBeenCalledTimes(expectedMethod === "admit" ? 1 : 0);
      expect(admitDeferred).toHaveBeenCalledTimes(expectedMethod === "admitDeferredProjection" ? 1 : 0);
      if (projectionDirty) {
        await expect(harness.relationRepo.findActiveProjectionByWorkspace("workspace-1"))
          .rejects.toThrow(/requires a refresh/u);
      } else {
        expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1"))
          .toHaveLength(1);
      }
      await expect(harness.runtime.relationProjectionCheckpoint.refresh()).resolves.toBe(
        relationProjectionAdmissionMode === "explicit_checkpoint"
      );
      expect(refresh).toHaveBeenCalledTimes(
        relationProjectionAdmissionMode === "explicit_checkpoint" ? 1 : 0
      );
      expect(await harness.relationRepo.findActiveProjectionByWorkspace("workspace-1"))
        .toHaveLength(1);
    } finally {
      clearInterval(harness.runtime.pathRelationEvictionTimer);
      harness.database.close();
    }
  });
});

async function createAdmissionHarness(
  relationProjectionAdmissionMode: "explicit_checkpoint" | undefined
) {
  const database = initDatabase({ filename: ":memory:" });
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "relation assertion wiring test",
    root_path: "/tmp/relation-assertion-wiring-test",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "relation assertion wiring test",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const sourceEvent = await eventLogRepo.append({
    event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
    entity_type: "candidate_memory_signal",
    entity_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    caused_by: "garden",
    payload_json: { source: "test" }
  });
  await new SqliteEvidenceCapsuleRepo(database).create(evidenceCapsule(sourceEvent.event_id));
  const runtimeNotifier = createRuntimeNotifier();
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: async () => undefined },
    runtimeNotifier
  });
  const relationRepo = new SqliteRelationAssertionRepo(database);
  const runtimeInput = {
    coUsageCounterRepo: new SqliteCoUsageCounterRepo(database),
    eventLogRepo,
    eventPublisher,
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    pathFailureHealthInboxPort: { recordPathRelationFailure: async () => undefined },
    pathRelationRepo: new SqlitePathRelationRepo(database),
    proposalRepo: new SqliteProposalRepo(database),
    relationAssertionRepo: relationRepo,
    runtimeNotifier,
    temporalProjectionSelected: true,
    warn: vi.fn(),
    ...(relationProjectionAdmissionMode === undefined ? {} : { relationProjectionAdmissionMode })
  } as Parameters<typeof createPathRelationRuntime>[0];
  return {
    database,
    relationRepo,
    sourceEventId: sourceEvent.event_id,
    runtime: createPathRelationRuntime(runtimeInput)
  };
}

function evidenceCapsule(sourceEventId: string): EvidenceCapsule {
  const timestamp = "2026-07-17T01:02:03.000Z";
  return {
    object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: timestamp,
    updated_at: timestamp,
    created_by: "garden",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: { topic: "relation", keywords: ["relation"], summary: "source evidence" },
    event_anchor: {
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      event_id: sourceEventId,
      occurred_at: timestamp
    },
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "source evidence",
    excerpt: "source evidence excerpt",
    source_hash: null,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}
