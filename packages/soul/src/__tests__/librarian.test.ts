import { describe, expect, it, vi, type Mock } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  GardenEventType,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import * as gardenExports from "../garden/index.js";
import { Auditor } from "../garden/auditor.js";
import { GardenScheduler } from "../garden/scheduler.js";
import { Janitor } from "../garden/janitor.js";
import {
  LIBRARIAN_CONSTANTS,
  Librarian,
  type CompressionCandidate,
  type MergeCandidate,
  type NeighborGroup
} from "../garden/librarian.js";
import type { PathPlasticityComputePort } from "../garden/path-plasticity-task.js";
import * as soulExports from "../index.js";

describe("Librarian", () => {
  it("exposes the librarian role and tier", () => {
    const librarian = createLibrarian().librarian;

    expect(librarian.role).toBe("librarian");
    expect(librarian.tier).toBe("tier_2");
  });

  it("creates merge proposals only for high-similarity candidates without pending proposals", async () => {
    const { librarian, mergePort, scheduler } = createLibrarian({
      mergeCandidates: [
        {
          primary_id: "memory-1",
          duplicate_ids: ["memory-2"],
          object_kind: "memory_entry",
          similarity_score: LIBRARIAN_CONSTANTS.MERGE_THRESHOLD
        },
        {
          primary_id: "memory-3",
          duplicate_ids: ["memory-4"],
          object_kind: "memory_entry",
          similarity_score: 0.84
        },
        {
          primary_id: "memory-5",
          duplicate_ids: ["memory-6"],
          object_kind: "claim_form",
          similarity_score: 0.99
        }
      ],
      pendingMergeIds: ["memory-5"]
    });

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.MERGE_PROPOSAL }));

    expect(mergePort.findMergeCandidates).toHaveBeenCalledWith("workspace-1");
    expect(mergePort.hasPendingMergeProposal).toHaveBeenCalledTimes(2);
    expect(mergePort.hasPendingMergeProposal).toHaveBeenNthCalledWith(1, "memory-1");
    expect(mergePort.hasPendingMergeProposal).toHaveBeenNthCalledWith(2, "memory-5");
    expect(mergePort.createMergeProposal).toHaveBeenCalledTimes(1);
    expect(mergePort.createMergeProposal).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ primary_id: "memory-1" })
    );
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["proposal:memory-1"],
      audit_entries: ["merge_proposal: created 1 merge proposals"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("limits merge proposal creation to the first batch of eligible candidates", async () => {
    const mergeCandidates: MergeCandidate[] = Array.from(
      { length: LIBRARIAN_CONSTANTS.BATCH_SIZE + 3 },
      (_, index) => ({
        primary_id: `memory-${index + 1}`,
        duplicate_ids: [`duplicate-${index + 1}`],
        object_kind: "memory_entry",
        similarity_score: 0.95
      })
    );
    const { librarian, mergePort } = createLibrarian({ mergeCandidates });

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.MERGE_PROPOSAL }));

    expect(mergePort.createMergeProposal).toHaveBeenCalledTimes(LIBRARIAN_CONSTANTS.BATCH_SIZE);
    expect(result.objects_affected).toHaveLength(LIBRARIAN_CONSTANTS.BATCH_SIZE);
  });

  it("records subject neighbor diagnostics without creating proposals or candidates", async () => {
    const { librarian, healthJournal, mergePort, compressionPort, synthesisPort, scheduler } = createLibrarian({
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
    expect(mergePort.createMergeProposal).not.toHaveBeenCalled();
    expect(mergePort.createTemplateCandidate).not.toHaveBeenCalled();
    expect(compressionPort.createCompressionCandidate).not.toHaveBeenCalled();
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

  it("creates compression candidates for the first batch of compressible paths", async () => {
    const compressiblePaths: CompressionCandidate[] = Array.from(
      { length: LIBRARIAN_CONSTANTS.BATCH_SIZE + 2 },
      (_, index) => ({
        chain_start: `memory-${index + 1}`,
        chain_end: `evidence-${index + 1}`,
        intermediate_ids: [`bridge-${index + 1}`]
      })
    );
    const { librarian, compressionPort, scheduler } = createLibrarian({ compressiblePaths });

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.PATH_COMPRESSION }));

    expect(compressionPort.findCompressiblePaths).toHaveBeenCalledWith("workspace-1");
    expect(compressionPort.createCompressionCandidate).toHaveBeenCalledTimes(LIBRARIAN_CONSTANTS.BATCH_SIZE);
    expect(result).toMatchObject({
      success: true,
      audit_entries: ["path_compression: created 10 compression candidates"]
    });
    expect(result.objects_affected).toHaveLength(LIBRARIAN_CONSTANTS.BATCH_SIZE);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("uses the configured template cluster size and skips pending template proposals", async () => {
    const { librarian, mergePort, scheduler } = createLibrarian({
      templateClusters: [
        {
          representative_id: "memory-1",
          member_ids: ["memory-1", "memory-2", "memory-3"],
          pattern_description: "shared pattern"
        },
        {
          representative_id: "memory-4",
          member_ids: ["memory-4", "memory-5", "memory-6"],
          pattern_description: "already pending"
        }
      ],
      pendingTemplateIds: ["memory-4"]
    });

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.TEMPLATE_CANDIDATE }));

    expect(mergePort.findTemplateClusters).toHaveBeenCalledWith(
      "workspace-1",
      LIBRARIAN_CONSTANTS.TEMPLATE_MIN_CLUSTER_SIZE
    );
    expect(mergePort.hasPendingTemplateProposal).toHaveBeenNthCalledWith(1, "memory-1");
    expect(mergePort.hasPendingTemplateProposal).toHaveBeenNthCalledWith(2, "memory-4");
    expect(mergePort.createTemplateCandidate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["template:memory-1"],
      audit_entries: ["template_candidate: created 1 template candidates"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
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
        target_object_refs: ["2026-03-26T00:00:00.000Z", "2026-03-27T00:00:00.000Z"]
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
        sinceIso: "2026-03-26T00:00:00.000Z",
        untilIso: "2026-03-27T00:00:00.000Z"
      })
    );
    expect(markProcessed).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      processedThroughIso: "2026-03-27T00:00:00.000Z",
      processedAuditEventId: null
    });
    expect(clearPendingWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("reports completion with success = true across all supported task kinds", async () => {
    const { librarian, scheduler } = createLibrarian();
    const taskKinds = [
      GardenTaskKind.MERGE_PROPOSAL,
      GardenTaskKind.SUBJECT_NEIGHBOR_DETECT,
      GardenTaskKind.PATH_COMPRESSION,
      GardenTaskKind.TEMPLATE_CANDIDATE,
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
      findMergeCandidates: vi.fn(async () => {
        throw new Error("merge index unavailable");
      })
    });

    const result = await librarian.run(createTask({ task_kind: GardenTaskKind.MERGE_PROPOSAL }));

    expect(result).toMatchObject({
      success: false,
      error_message: "merge index unavailable",
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
      mergeCandidates: [
        {
          primary_id: "memory-1",
          duplicate_ids: ["memory-2"],
          object_kind: "memory_entry",
          similarity_score: 0.95
        }
      ],
      schedulerOverride: scheduler as unknown as {
        reportCompletion: Mock<(result: Awaited<ReturnType<Librarian["run"]>>) => Promise<void>>;
      }
    }).librarian;
    scheduler.enqueue(createTask({ task_id: "task-librarian", task_kind: GardenTaskKind.MERGE_PROPOSAL }));

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
  readonly mergeCandidates?: readonly MergeCandidate[];
  readonly pendingMergeIds?: readonly string[];
  readonly templateClusters?: readonly {
    representative_id: string;
    member_ids: readonly string[];
    pattern_description: string;
  }[];
  readonly pendingTemplateIds?: readonly string[];
  readonly neighborGroups?: readonly NeighborGroup[];
  readonly compressiblePaths?: readonly CompressionCandidate[];
  readonly synthesisClusters?: readonly {
    subject: string;
    evidence_ids: readonly string[];
  }[];
  readonly pendingSubjects?: readonly string[];
  readonly findMergeCandidates?: (workspaceId: string) => Promise<readonly MergeCandidate[]>;
  readonly pathPlasticityPort?: PathPlasticityComputePort;
  readonly clearPendingWorkspace?: (workspaceId: string) => Promise<void>;
  readonly schedulerOverride?: {
    reportCompletion: Mock<(result: Awaited<ReturnType<Librarian["run"]>>) => Promise<void>>;
  };
} = {}) {
  const mergePort = {
    findMergeCandidates:
      options.findMergeCandidates ??
      vi.fn(async () => options.mergeCandidates ?? []),
    hasPendingMergeProposal: vi.fn(async (primaryId: string) => (options.pendingMergeIds ?? []).includes(primaryId)),
    createMergeProposal: vi.fn(async (_workspaceId: string, candidate: MergeCandidate) => ({
      proposal_id: `proposal:${candidate.primary_id}`
    })),
    findTemplateClusters: vi.fn(async () => options.templateClusters ?? []),
    hasPendingTemplateProposal: vi.fn(async (representativeId: string) =>
      (options.pendingTemplateIds ?? []).includes(representativeId)
    ),
    createTemplateCandidate: vi.fn(async (_workspaceId: string, cluster: { representative_id: string }) => ({
      candidate_id: `template:${cluster.representative_id}`
    }))
  };
  const neighborPort = {
    findSubjectNeighbors: vi.fn(async () => options.neighborGroups ?? [])
  };
  const compressionPort = {
    findCompressiblePaths: vi.fn(async () => options.compressiblePaths ?? []),
    createCompressionCandidate: vi.fn(async (_workspaceId: string, candidate: CompressionCandidate) => ({
      candidate_id: `compression:${candidate.chain_start}`
    }))
  };
  const synthesisPort = {
    findSynthesisCandidateClusters: vi.fn(async () => options.synthesisClusters ?? []),
    hasPendingSynthesisForSubject: vi.fn(async (_workspaceId: string, subject: string) =>
      (options.pendingSubjects ?? []).includes(subject)
    ),
    createSynthesisReviewCandidate: vi.fn(async (_workspaceId: string, subject: string) => ({
      candidate_id: `synthesis:${subject}`
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
      mergePort,
      neighborPort,
      compressionPort,
      synthesisPort,
      ...(options.pathPlasticityPort === undefined ? {} : { pathPlasticityPort: options.pathPlasticityPort }),
      ...(options.clearPendingWorkspace === undefined
        ? {}
        : { pathPlasticityPendingPort: { clearPendingWorkspace: options.clearPendingWorkspace } }),
      scheduler,
      healthJournal,
      now: () => "2026-03-27T00:00:00.000Z"
    }),
    mergePort,
    neighborPort,
    compressionPort,
    synthesisPort,
    scheduler,
    healthJournal
  };
}

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.MERGE_PROPOSAL,
    required_tier: GardenTier.TIER_2,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}
