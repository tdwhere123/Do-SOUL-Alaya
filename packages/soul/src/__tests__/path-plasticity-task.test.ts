import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { Librarian } from "../garden/librarian.js";
import {
  PATH_PLASTICITY_TASK_DEFAULTS,
  resolvePathPlasticitySinceIso,
  resolvePathPlasticityUntilIso,
  type PathPlasticityComputePort,
  type PathPlasticityComputeResult,
  type PathPlasticityPendingPort
} from "../garden/path-plasticity-task.js";

const NOW_ISO = "2026-05-04T12:00:00.000Z";

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-plasticity-1",
    task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
    required_tier: GardenTier.TIER_2,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 50,
    created_at: NOW_ISO,
    ...overrides
  };
}

function createLibrarian(
  plasticityPort: PathPlasticityComputePort | undefined,
  options: {
    readonly pathPlasticityBudgetMs?: number;
    readonly pathPlasticityPendingPort?: PathPlasticityPendingPort;
  } = {}
) {
  const scheduler = { reportCompletion: vi.fn(async () => undefined) };
  const clearPendingWorkspace = vi.fn(async () => undefined);
  const librarian = new Librarian({
    mergePort: {
      findMergeCandidates: vi.fn(async () => []),
      hasPendingMergeProposal: vi.fn(async () => false),
      createMergeProposal: vi.fn(async () => ({ proposal_id: "proposal-1" })),
      findTemplateClusters: vi.fn(async () => []),
      hasPendingTemplateProposal: vi.fn(async () => false),
      createTemplateCandidate: vi.fn(async () => ({ candidate_id: "template-1" }))
    },
    neighborPort: { findSubjectNeighbors: vi.fn(async () => []) },
    compressionPort: {
      findCompressiblePaths: vi.fn(async () => []),
      createCompressionCandidate: vi.fn(async () => ({ candidate_id: "compression-1" }))
    },
    synthesisPort: {
      findSynthesisCandidateClusters: vi.fn(async () => []),
      hasPendingSynthesisForSubject: vi.fn(async () => false),
      createSynthesisReviewCandidate: vi.fn(async () => ({ candidate_id: "synthesis-1" }))
    },
    ...(plasticityPort === undefined ? {} : { pathPlasticityPort: plasticityPort }),
    pathPlasticityPendingPort: options.pathPlasticityPendingPort ?? { clearPendingWorkspace },
    scheduler,
    ...(options.pathPlasticityBudgetMs === undefined
      ? {}
      : { pathPlasticityBudgetMs: options.pathPlasticityBudgetMs }),
    now: () => NOW_ISO
  });
  return { librarian, scheduler, clearPendingWorkspace };
}

describe("Librarian.path_plasticity_update", () => {
  it("dispatches the path_plasticity_update task to the plasticity port and reports the per-tick deltas back to the scheduler", async () => {
    const computeAndApplyPlasticity = vi.fn(async (): Promise<PathPlasticityComputeResult> => ({
      reinforced: 2,
      weakened: 1,
      retired: 1,
      affectedPathIds: ["path-reinforced-1", "path-reinforced-2", "path-weakened-1", "path-retired-1"]
    }));
    const markProcessed = vi.fn(async () => undefined);
    const { librarian, scheduler, clearPendingWorkspace } = createLibrarian({
      computeAndApplyPlasticity,
      markProcessed
    });

    const result = await librarian.run(createTask());

    expect(result.success).toBe(true);
    expect(result.role).toBe(GardenRole.LIBRARIAN);
    expect(result.tier).toBe(GardenTier.TIER_2);
    expect(result.objects_affected).toEqual([
      "path-reinforced-1",
      "path-reinforced-2",
      "path-weakened-1",
      "path-retired-1"
    ]);
    expect(result.audit_entries[0]).toMatch(/reinforced=2/);
    expect(result.audit_entries[0]).toMatch(/weakened=1/);
    expect(result.audit_entries[0]).toMatch(/retired=1/);
    expect(computeAndApplyPlasticity).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sinceIso: new Date(Date.parse(NOW_ISO) - PATH_PLASTICITY_TASK_DEFAULTS.DEFAULT_LOOKBACK_MS).toISOString(),
        untilIso: NOW_ISO
      })
    );
    expect(markProcessed).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      processedThroughIso: NOW_ISO,
      processedAuditEventId: null
    });
    expect(clearPendingWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("uses explicit lower and upper watermarks embedded in target_object_refs", async () => {
    const explicitSince = "2026-05-03T00:00:00.000Z";
    const explicitUntil = "2026-05-04T11:59:00.000Z";
    const computeAndApplyPlasticity = vi.fn(async () => ({
      reinforced: 0,
      weakened: 0,
      retired: 0,
      affectedPathIds: []
    }));
    const markProcessed = vi.fn(async () => undefined);
    const { librarian, clearPendingWorkspace } = createLibrarian({
      computeAndApplyPlasticity,
      markProcessed
    });

    await librarian.run(createTask({ target_object_refs: [explicitSince, explicitUntil] }));

    expect(computeAndApplyPlasticity).toHaveBeenCalledWith(
      expect.objectContaining({ sinceIso: explicitSince, untilIso: explicitUntil })
    );
    expect(markProcessed).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      processedThroughIso: explicitUntil,
      processedAuditEventId: null
    });
    expect(clearPendingWorkspace).toHaveBeenCalledWith("workspace-1");
  });

  it("soft-skips path_plasticity_update when the optional plasticity port is not configured", async () => {
    const { librarian, scheduler, clearPendingWorkspace } = createLibrarian(undefined);

    const result = await librarian.run(createTask());

    expect(result.success).toBe(true);
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries[0]).toMatch(/skipped because path plasticity port is not configured/);
    expect(clearPendingWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("resolvePathPlasticitySinceIso ignores a non-ISO target ref and falls back to the default lookback", () => {
    const since = resolvePathPlasticitySinceIso(["not-an-iso-string"], NOW_ISO);
    expect(since).toBe(
      new Date(Date.parse(NOW_ISO) - PATH_PLASTICITY_TASK_DEFAULTS.DEFAULT_LOOKBACK_MS).toISOString()
    );
  });

  it("resolvePathPlasticitySinceIso accepts an empty target_object_refs and falls back to the default lookback", () => {
    const since = resolvePathPlasticitySinceIso([], NOW_ISO);
    expect(since).toBe(
      new Date(Date.parse(NOW_ISO) - PATH_PLASTICITY_TASK_DEFAULTS.DEFAULT_LOOKBACK_MS).toISOString()
    );
  });

  it("resolvePathPlasticityUntilIso accepts target_object_refs[1] and otherwise falls back to now", () => {
    expect(resolvePathPlasticityUntilIso(["2026-05-03T00:00:00.000Z", "2026-05-04T11:00:00.000Z"], NOW_ISO)).toBe(
      "2026-05-04T11:00:00.000Z"
    );
    expect(resolvePathPlasticityUntilIso(["2026-05-03T00:00:00.000Z", "not-iso"], NOW_ISO)).toBe(NOW_ISO);
  });

  it("propagates a port failure as a task failure result and clears the pending marker", async () => {
    const computeAndApplyPlasticity = vi.fn(async () => {
      throw new Error("plasticity service exploded");
    });
    const { librarian, scheduler, clearPendingWorkspace } = createLibrarian({ computeAndApplyPlasticity });

    const result = await librarian.run(createTask());

    expect(result.success).toBe(false);
    expect(result.error_message).toMatch(/plasticity service exploded/);
    expect(clearPendingWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("fails a hung path_plasticity_update within the wall-clock budget and does not mark the watermark processed", async () => {
    let receivedAbortSignal: AbortSignal | undefined;
    const computeAndApplyPlasticity = vi.fn(async (params: {
      readonly abortSignal?: AbortSignal;
    }) => {
      receivedAbortSignal = params.abortSignal;
      return await new Promise<PathPlasticityComputeResult>(() => undefined);
    });
    const markProcessed = vi.fn(async () => undefined);
    const { librarian, scheduler, clearPendingWorkspace } = createLibrarian(
      { computeAndApplyPlasticity, markProcessed },
      { pathPlasticityBudgetMs: 5 }
    );

    const result = await librarian.run(createTask());

    expect(result.success).toBe(false);
    expect(result.error_message).toBe("path_plasticity_update timed out after 5ms");
    expect(receivedAbortSignal?.aborted).toBe(true);
    expect(markProcessed).not.toHaveBeenCalled();
    expect(clearPendingWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("waits past the wall-clock budget after the mutation boundary starts and then advances the watermark", async () => {
    const computeAndApplyPlasticity = vi.fn(async (params: {
      readonly onMutationBoundaryEntered?: () => void;
    }): Promise<PathPlasticityComputeResult> => {
      params.onMutationBoundaryEntered?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        reinforced: 1,
        weakened: 0,
        retired: 0,
        affectedPathIds: ["path-post-commit-1"]
      };
    });
    const markProcessed = vi.fn(async () => undefined);
    const { librarian, scheduler, clearPendingWorkspace } = createLibrarian(
      { computeAndApplyPlasticity, markProcessed },
      { pathPlasticityBudgetMs: 5 }
    );

    const result = await librarian.run(createTask());

    expect(result.success).toBe(true);
    expect(result.objects_affected).toEqual(["path-post-commit-1"]);
    expect(markProcessed).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      processedThroughIso: NOW_ISO,
      processedAuditEventId: null
    });
    expect(clearPendingWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });
});
