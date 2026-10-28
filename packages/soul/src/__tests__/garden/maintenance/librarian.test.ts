import { describe, expect, it, vi, type Mock } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  GardenEventType,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import * as gardenExports from "../../../garden/index.js";
import { Auditor } from "../../../garden/maintenance/auditor.js";
import { GardenScheduler } from "../../../garden/scheduling/scheduler.js";
import { Janitor } from "../../../garden/maintenance/janitor.js";
import {
  LIBRARIAN_CONSTANTS,
  Librarian,
  type NeighborGroup
} from "../../../garden/maintenance/librarian.js";
import type { PathPlasticityComputePort } from "../../../garden/materialization/path-plasticity-task.js";
import * as soulExports from "../../../index.js";

describe("Librarian", () => {
  it("exposes the librarian role and tier", () => {
    const librarian = createLibrarian().librarian;

    expect(librarian.role).toBe("librarian");
    expect(librarian.tier).toBe("tier_2");
  });

  it.each([
    [GardenTaskKind.MERGE_PROPOSAL, "merge"],
    [GardenTaskKind.TEMPLATE_CANDIDATE, "template"],
    [GardenTaskKind.PATH_COMPRESSION, "compression"]
  ])("refuses historical %s work and records a failed completion", async (taskKind, label) => {
    const { librarian, synthesisPort, scheduler } = createLibrarian();
    const result = await librarian.run(createTask({ task_kind: taskKind }));
    expect(result).toMatchObject({ success: false, objects_affected: [], error_message: `Librarian ${label} proposals are retired` });
    expect(synthesisPort.createSynthesisReviewCandidate).not.toHaveBeenCalled();
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("records subject neighbor diagnostics without creating proposals or candidates", async () => {
    const { librarian, healthJournal, synthesisPort, scheduler } = createLibrarian({
      neighborGroups: [
        {
          subject: "workspace.memory.theme",
          object_ids: ["memory-1", "memory-2"],
          overlap_basis: "governance_subject"
        }
      ]
    });

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.SUBJECT_NEIGHBOR_DETECT }));

    expect(healthJournal.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        workspace_id: "workspace-1",
        detail_json: expect.objectContaining({ group_count: 1 })
      })
    );
    expect(synthesisPort.createSynthesisReviewCandidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["memory-1", "memory-2"],
      audit_entries: ["subject_neighbor_detect: detected 1 overlapping subject groups"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("does not record health diagnostics when subject neighbor detection finds no groups", async () => {
    const { librarian, healthJournal } = createLibrarian();

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.SUBJECT_NEIGHBOR_DETECT }));

    expect(healthJournal.record).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual([]);
  });

  it("throttles synthesis review by subject before creating candidates", async () => {
    const { librarian, synthesisPort, scheduler } = createLibrarian({
      synthesisClusters: [
        { subject: "subject-a", evidence_ids: ["evidence-1", "evidence-2"] },
        { subject: "subject-b", evidence_ids: ["evidence-3"] }
      ],
      pendingSubjects: ["subject-a"]
    });

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.SYNTHESIS_REVIEW }));

    expect(synthesisPort.findSynthesisCandidateClusters).toHaveBeenCalledWith("workspace-1");
    expect(synthesisPort.hasPendingSynthesisForSubject).toHaveBeenNthCalledWith(
      1,
      "workspace-1",
      "subject-a"
    );
    expect(synthesisPort.hasPendingSynthesisForSubject).toHaveBeenNthCalledWith(
      2,
      "workspace-1",
      "subject-b"
    );
    expect(synthesisPort.createSynthesisReviewCandidate).toHaveBeenCalledTimes(1);
    expect(synthesisPort.createSynthesisReviewCandidate).toHaveBeenCalledWith(
      "workspace-1",
      "subject-b",
      ["evidence-3"]
    );
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["synthesis:subject-b"],
      audit_entries: ["synthesis_review: created 1 synthesis review candidates"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("creates later eligible synthesis candidates even when the first batch is pending", async () => {
    const synthesisClusters = Array.from({ length: 23 }, (_, index) => ({
      subject: `subject-${index}`, evidence_ids: [`evidence-${index}`]
    }));
    const { librarian, synthesisPort } = createLibrarian({
      synthesisClusters, pendingSubjects: synthesisClusters.slice(0, 11).map(cluster => cluster.subject)
    });
    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.SYNTHESIS_REVIEW }));
    expect(result.success).toBe(true);
    expect(synthesisPort.createSynthesisReviewCandidate).toHaveBeenCalledTimes(LIBRARIAN_CONSTANTS.BATCH_SIZE);
    expect(synthesisPort.createSynthesisReviewCandidate).toHaveBeenNthCalledWith(1,
      "workspace-1", "subject-11", ["evidence-11"]);
  });

  it("continues past a candidate concurrently created by another worker", async () => {
    const { librarian, synthesisPort } = createLibrarian({ synthesisClusters: [
      { subject: "raced", evidence_ids: ["evidence-a", "evidence-b"] },
      { subject: "next", evidence_ids: ["evidence-c", "evidence-d"] }
    ] });
    synthesisPort.createSynthesisReviewCandidate.mockResolvedValueOnce({ candidate_id: "existing", created: false });
    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.SYNTHESIS_REVIEW }));
    expect(result.objects_affected).toEqual(["synthesis:next"]);
  });

  it("executes path plasticity as a Librarian task and clears the pending workspace marker", async () => {
    const computeAndApplyPlasticity = vi.fn(async () => ({
      reinforced: 1,
      weakened: 0,
      retired: 0,
      affectedPathIds: ["path-1"]
    }));
    const markProcessed = vi.fn(async () => undefined);
    const clearPendingWorkspace = vi.fn(async () => undefined);
    const { librarian, scheduler } = createLibrarian({
      pathPlasticityPort: { computeAndApplyPlasticity, markProcessed },
      clearPendingWorkspace
    });

    const result = await librarian.run(
      createTask({
        task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        target_object_refs: ["10", "40"]
      })
    );

    expect(result).toMatchObject({
      success: true,
      role: GardenRole.LIBRARIAN,
      tier: GardenTier.TIER_2,
      objects_affected: ["path-1"]
    });
    expect(computeAndApplyPlasticity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sinceRevision: 10,
        untilRevision: 40
      })
    );
    expect(markProcessed).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      processedThroughRevision: 40,
      processedAuditEventId: null
    });
    expect(clearPendingWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("reports completion with success = true across all supported task kinds", async () => {
    const { librarian, scheduler } = createLibrarian();
    const taskKinds = [
      GardenTaskKind.SUBJECT_NEIGHBOR_DETECT,
      GardenTaskKind.SYNTHESIS_REVIEW,
      GardenTaskKind.PATH_PLASTICITY_UPDATE
    ] as const;

    for (const taskKind of taskKinds) {
      const result = await librarian.run(createTask({ task_kind: taskKind }));
      expect(result.success).toBe(true);
    }

    expect(scheduler.reportCompletion).toHaveBeenCalledTimes(taskKinds.length);
    for (const call of scheduler.reportCompletion.mock.calls) {
      expect(call[0]).toMatchObject({ success: true, role: GardenRole.LIBRARIAN, tier: GardenTier.TIER_2 });
    }
  });

  it("reports failure when a port throws", async () => {
    const { librarian, scheduler } = createLibrarian({
      findSynthesisClusters: vi.fn(async () => {
        throw new Error("synthesis index unavailable");
      })
    });

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.SYNTHESIS_REVIEW }));

    expect(result).toMatchObject({
      success: false,
      error_message: "synthesis index unavailable",
      objects_affected: [],
      audit_entries: []
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("reports failure for unsupported task kinds", async () => {
    const { librarian, scheduler } = createLibrarian();

    const result = await librarian.run(
      createTask({
        task_kind: GardenTaskKind.TTL_CLEANUP,
        required_tier: GardenTier.TIER_0
      })
    );

    expect(result).toMatchObject({
      task_kind: GardenTaskKind.TTL_CLEANUP,
      success: false,
      error_message: "Librarian does not handle task kind: ttl_cleanup"
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("integrates with GardenScheduler and emits dispatch/completion audit events", async () => {
    const eventLog = {
      append: vi.fn(async () => undefined)
    };
    const scheduler = new GardenScheduler(eventLog, {
      now: () => "2026-03-27T00:00:00.000Z"
    });
    const librarian = createLibrarian({
      schedulerOverride: scheduler as unknown as {
        reportCompletion: Mock<(result: Awaited<ReturnType<Librarian["run"]>>) => Promise<void>>;
      }
    }).librarian;
    scheduler.enqueue(createTask({ task_id: "task-librarian", task_kind: GardenTaskKind.SYNTHESIS_REVIEW }));

    const dispatched = await scheduler.dispatchNext(GardenRole.LIBRARIAN);
    const result = await librarian.run(dispatched as GardenTaskDescriptor);

    expect(result.success).toBe(true);
    expect(eventLog.append).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
        entity_id: "task-librarian"
      })
    );
    expect(eventLog.append).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
        entity_id: "task-librarian"
      })
    );
  });

  it("re-exports Janitor, Auditor, and Librarian through both barrels", () => {
    expect(gardenExports.Janitor).toBe(Janitor);
    expect(gardenExports.Auditor).toBe(Auditor);
    expect(gardenExports.Librarian).toBe(Librarian);
    expect(soulExports.Janitor).toBe(Janitor);
    expect(soulExports.Auditor).toBe(Auditor);
    expect(soulExports.Librarian).toBe(Librarian);
  });
});

function createLibrarian(options: {
  readonly neighborGroups?: readonly NeighborGroup[];
  readonly synthesisClusters?: readonly {
    subject: string;
    evidence_ids: readonly string[];
  }[];
  readonly pendingSubjects?: readonly string[];
  readonly findSynthesisClusters?: (workspaceId: string) => Promise<readonly { subject: string; evidence_ids: readonly string[] }[]>;
  readonly pathPlasticityPort?: PathPlasticityComputePort;
  readonly clearPendingWorkspace?: (workspaceId: string) => Promise<void>;
  readonly schedulerOverride?: {
    reportCompletion: Mock<(result: Awaited<ReturnType<Librarian["run"]>>) => Promise<void>>;
  };
} = {}) {
  const neighborPort = {
    findSubjectNeighbors: vi.fn(async () => options.neighborGroups ?? [])
  };
  const synthesisPort = {
    findSynthesisCandidateClusters: options.findSynthesisClusters ?? vi.fn(async () => options.synthesisClusters ?? []),
    hasPendingSynthesisForSubject: vi.fn(async (_workspaceId: string, subject: string) =>
      (options.pendingSubjects ?? []).includes(subject)
    ),
    createSynthesisReviewCandidate: vi.fn(async (_workspaceId: string, subject: string) => ({
      candidate_id: `synthesis:${subject}`, created: true
    }))
  };
  const scheduler = options.schedulerOverride ?? {
    reportCompletion: vi.fn<(result: Awaited<ReturnType<Librarian["run"]>>) => Promise<void>>(
      async () => undefined
    )
  };
  const healthJournal = {
    record: vi.fn(async () => undefined)
  };

  return {
    librarian: new Librarian({
      neighborPort,
      synthesisPort,
      ...(options.pathPlasticityPort === undefined ? {} : { pathPlasticityPort: options.pathPlasticityPort }),
      ...(options.clearPendingWorkspace === undefined
        ? {}
        : { pathPlasticityPendingPort: { clearPendingWorkspace: options.clearPendingWorkspace } }),
      scheduler,
      healthJournal,
      now: () => "2026-03-27T00:00:00.000Z"
    }),
    neighborPort,
    synthesisPort,
    scheduler,
    healthJournal
  };
}

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.SYNTHESIS_REVIEW,
    required_tier: GardenTier.TIER_2,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}
