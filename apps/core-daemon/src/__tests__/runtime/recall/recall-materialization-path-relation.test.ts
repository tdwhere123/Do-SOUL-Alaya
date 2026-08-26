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
import { createGardenRuntimeWiring } from "../../../runtime/garden-wiring/garden-runtime-wiring.js";
import { createPathRelationRuntime } from "../../../runtime/recall-materialization/recall-materialization-path-relation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Garden temporal relation runtime", () => {
  it("does not accept RelationAssertionAdmissionPort on Garden wiring", () => {
    type GardenWiringInput = Parameters<typeof createGardenRuntimeWiring>[0];
    type Leak = Extract<keyof GardenWiringInput, "relationAssertionAdmissionPort">;
    const closed: [Leak] extends [never] ? true : false = true;
    expect(closed).toBe(true);
  });

  it("exposes a nomination port for Garden temporal relations", async () => {
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
      const runtime = createPathRelationRuntime({
        softAssociationPathRepo: {
          create: (relation: unknown) => relation,
          findByBackingObjectId: async () => null,
          findActiveByWorkspace: async () => []
        },
        coUsageCounterRepo: new SqliteCoUsageCounterRepo(database),
        eventLogRepo,
        eventPublisher,
        memoryEntryRepo: new SqliteMemoryEntryRepo(database),
        pathFailureHealthInboxPort: { recordPathRelationFailure: async () => undefined },
        pathRelationRepo: new SqlitePathRelationRepo(database),
        proposalRepo: new SqliteProposalRepo(database),
        relationAssertionRepo: new SqliteRelationAssertionRepo(database),
        evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
        runtimeNotifier,
        warn: vi.fn()
      } as unknown as Parameters<typeof createPathRelationRuntime>[0]);
      pathRelationEvictionTimer = runtime.pathRelationEvictionTimer;

      expect(runtime.temporalRelationAssertionPort.admit).toEqual(expect.any(Function));
      expect(runtime.pathRelationProposalPort.createPathRelationProposal).toEqual(expect.any(Function));
      expect(runtime).not.toHaveProperty("pathCandidatePort");
    } finally {
      if (pathRelationEvictionTimer !== null) clearInterval(pathRelationEvictionTimer);
      database.close();
    }
  });

  it("creates a proposal instead of admitting a RelationAssertion", async () => {
    const admit = vi.spyOn(RelationAssertionService.prototype, "admit");
    const harness = await createNominationHarness();
    try {
      const created = await harness.runtime.temporalRelationAssertionPort.admit({
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

      expect(admit).not.toHaveBeenCalled();
      expect(created.object_kind).toBe("proposal");
      expect(await harness.proposalRepo.countPending("workspace-1")).toBe(1);
      expect(harness.relationRepo.listAssertionsInCurrentTransaction()).toHaveLength(0);
    } finally {
      clearInterval(harness.runtime.pathRelationEvictionTimer);
      harness.database.close();
    }
  });

  it("uses evidence capsule source time for proposal validity when it differs from the event-log anchor", async () => {
    const harness = await createNominationHarness({
      evidenceOccurredAt: "2026-01-01T00:00:00.000Z"
    });
    const createProposal = vi.spyOn(harness.runtime.pathRelationProposalPort, "createPathRelationProposal");
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

      expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.stringContaining('"valid_from":"2026-01-01T00:00:00.000Z"'),
        proposedPathRelation: expect.objectContaining({
          constitution: expect.objectContaining({
            why_this_relation_exists: expect.arrayContaining([
              expect.stringContaining('"valid_from":"2026-01-01T00:00:00.000Z"')
            ])
          })
        })
      }));
    } finally {
      clearInterval(harness.runtime.pathRelationEvictionTimer);
      harness.database.close();
    }
  });
});

async function createNominationHarness(
  options: { readonly evidenceOccurredAt?: string } = {}
) {
  const database = initDatabase({ filename: ":memory:" });
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: "workspace-1",
    name: "relation nomination wiring test",
    root_path: "/tmp/relation-nomination-wiring-test",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "relation nomination wiring test",
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
  const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
  await evidenceRepo.create(evidenceCapsule(
    sourceEvent.event_id,
    options.evidenceOccurredAt ?? "2026-07-17T01:02:03.000Z"
  ));
  const runtimeNotifier = createRuntimeNotifier();
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: async () => undefined },
    runtimeNotifier
  });
  const relationRepo = new SqliteRelationAssertionRepo(database);
  const proposalRepo = new SqliteProposalRepo(database);
  const runtimeInput = {
    softAssociationPathRepo: {
      create: (relation: unknown) => relation,
      findByBackingObjectId: async () => null,
      findActiveByWorkspace: async () => []
    },
    coUsageCounterRepo: new SqliteCoUsageCounterRepo(database),
    eventLogRepo,
    eventPublisher,
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    pathFailureHealthInboxPort: { recordPathRelationFailure: async () => undefined },
    pathRelationRepo: new SqlitePathRelationRepo(database),
    proposalRepo,
    relationAssertionRepo: relationRepo,
    evidenceCapsuleRepo: evidenceRepo,
    runtimeNotifier,
    warn: vi.fn()
  } as unknown as Parameters<typeof createPathRelationRuntime>[0];
  return {
    database,
    relationRepo,
    proposalRepo,
    sourceEventId: sourceEvent.event_id,
    runtime: createPathRelationRuntime(runtimeInput)
  };
}

function evidenceCapsule(sourceEventId: string, occurredAt: string): EvidenceCapsule {
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
      occurred_at: occurredAt
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
