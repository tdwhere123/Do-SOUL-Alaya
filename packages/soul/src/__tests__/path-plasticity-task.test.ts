import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { Auditor } from "../garden/auditor.js";
import {
  PATH_PLASTICITY_TASK_DEFAULTS,
  resolvePathPlasticitySinceIso,
  type PathPlasticityComputePort,
  type PathPlasticityComputeResult
} from "../garden/path-plasticity-task.js";

const NOW_ISO = "2026-05-04T12:00:00.000Z";

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-plasticity-1",
    task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
    required_tier: GardenTier.TIER_1,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 50,
    created_at: NOW_ISO,
    ...overrides
  };
}

function createAuditor(plasticityPort: PathPlasticityComputePort | undefined) {
  const scheduler = { reportCompletion: vi.fn(async () => undefined) };
  const auditor = new Auditor({
    evidenceCheckPort: { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
    pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
    pointerHealPort: {
      findHealablePointers: vi.fn(async () => []),
      clearEvidenceRef: vi.fn(async () => undefined),
      clearMemoryRef: vi.fn(async () => undefined),
      clearSynthesisRef: vi.fn(async () => undefined)
    },
    orphanDetectionPort: {
      findOrphanedMemories: vi.fn(async () => []),
      createOrphanRadarRecord: vi.fn(async () => undefined)
    },
    greenMaintenancePort: {
      findExpiringGreenStatuses: vi.fn(async () => []),
      renewGreenPassiveStable: vi.fn(async () => undefined),
      requestActiveVerification: vi.fn(async () => undefined),
      revokeGreen: vi.fn(async () => undefined)
    },
    bootstrappingPort: {
      assessColdStart: vi.fn(async () => ({
        is_cold_start: false,
        memory_count: 10,
        claim_count: 5
      })),
      generateDraftCandidates: vi.fn(async () => []),
      findHighFrequencyPatterns: vi.fn(async () => []),
      createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
      hasPendingSynthesisCandidate: vi.fn(async () => false)
    },
    pathPlasticityPort: plasticityPort,
    scheduler,
    now: () => NOW_ISO
  });
  return { auditor, scheduler };
}

describe("Auditor.path_plasticity_update", () => {
  it("dispatches the path_plasticity_update task to the plasticity port and reports the per-tick deltas back to the scheduler (covers MEMORY_USAGE_REPORTED → PathRelation strength delta E2E for one Garden tick)", async () => {
    // The port stands in for PathPlasticityService — it represents the
    // boundary where MEMORY_USAGE_REPORTED events translate into measurable
    // PathRelation strength deltas. The Auditor dispatches one tick and the
    // port returns the affected path_ids.
    const computeAndApplyPlasticity = vi.fn(async (): Promise<PathPlasticityComputeResult> => ({
      reinforced: 2,
      weakened: 1,
      retired: 1,
      affectedPathIds: ["path-reinforced-1", "path-reinforced-2", "path-weakened-1", "path-retired-1"]
    }));
    const { auditor, scheduler } = createAuditor({ computeAndApplyPlasticity });

    const result = await auditor.run(createTask());

    expect(result.success).toBe(true);
    expect(result.role).toBe(GardenRole.AUDITOR);
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
        // The default lookback window resolves to NOW - 24h.
        sinceIso: new Date(
          Date.parse(NOW_ISO) - PATH_PLASTICITY_TASK_DEFAULTS.DEFAULT_LOOKBACK_MS
        ).toISOString()
      })
    );
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("uses the explicit since-watermark embedded in target_object_refs[0] when present", async () => {
    const explicitSince = "2026-05-03T00:00:00.000Z";
    const computeAndApplyPlasticity = vi.fn(async () => ({
      reinforced: 0,
      weakened: 0,
      retired: 0,
      affectedPathIds: []
    }));
    const { auditor } = createAuditor({ computeAndApplyPlasticity });

    await auditor.run(createTask({ target_object_refs: [explicitSince] }));

    expect(computeAndApplyPlasticity).toHaveBeenCalledWith(
      expect.objectContaining({ sinceIso: explicitSince })
    );
  });

  it("soft-skips path_plasticity_update when the optional plasticity port is not configured (mirrors orphan_detection's optional-port pattern)", async () => {
    const { auditor, scheduler } = createAuditor(undefined);

    const result = await auditor.run(createTask());

    expect(result.success).toBe(true);
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries[0]).toMatch(/skipped because path plasticity port is not configured/);
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

  it("propagates a port failure as a task failure result without crashing the Garden tick", async () => {
    const computeAndApplyPlasticity = vi.fn(async () => {
      throw new Error("plasticity service exploded");
    });
    const { auditor, scheduler } = createAuditor({ computeAndApplyPlasticity });

    const result = await auditor.run(createTask());

    expect(result.success).toBe(false);
    expect(result.error_message).toMatch(/plasticity service exploded/);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });
});
