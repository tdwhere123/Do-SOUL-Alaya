import { describe, expect, it, vi } from "vitest";
import type { AuditorDependencies } from "../../garden/auditor.js";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type BrokenPointerRecord,
  type ColdStartAssessment,
  type DraftCandidate,
  type ExpiringGreenStatus,
  type GardenTaskDescriptor,
  type HighFrequencyPattern,
  type StaleMemoryEntry
} from "@do-soul/alaya-protocol";
import { AUDITOR_CONSTANTS, Auditor } from "../../garden/auditor.js";

describe("Auditor", () => {  it("assesses cold start and generates draft candidates when bootstrapping is needed", async () => {
    const { auditor, bootstrappingPort, scheduler } = createAuditor({
      coldStartAssessment: {
        is_cold_start: true,
        memory_count: 2,
        claim_count: 1
      },
      draftCandidates: [
        {
          candidate_id: "candidate-1",
          object_kind: "memory_entry",
          lifecycle_state: "candidate",
          requires_review: true,
          workspace_id: "workspace-1"
        },
        {
          candidate_id: "candidate-2",
          object_kind: "claim_form",
          lifecycle_state: "candidate",
          requires_review: true,
          workspace_id: "workspace-1"
        }
      ]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.BOOTSTRAPPING_SCAN }));

    expect(bootstrappingPort.assessColdStart).toHaveBeenCalledWith("workspace-1");
    expect(bootstrappingPort.generateDraftCandidates).toHaveBeenCalledWith("workspace-1");
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["candidate-1", "candidate-2"]
    });
    expect(result.audit_entries).toEqual([
      "bootstrapping_scan: cold start detected (2 memories, 1 claims); 2 draft candidates generated"
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("does not generate draft candidates when bootstrapping is not needed", async () => {
    const { auditor, bootstrappingPort, scheduler } = createAuditor({
      coldStartAssessment: {
        is_cold_start: false,
        memory_count: 20,
        claim_count: 8
      }
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.BOOTSTRAPPING_SCAN }));

    expect(bootstrappingPort.assessColdStart).toHaveBeenCalledWith("workspace-1");
    expect(bootstrappingPort.generateDraftCandidates).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries).toEqual([
      "bootstrapping_scan: not cold start (20 memories, 8 claims)"
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("uses the configured crystallization threshold when scanning high-frequency patterns", async () => {
    const { auditor, bootstrappingPort, scheduler } = createAuditor({
      patterns: [{ pattern_key: "pattern-a", frequency: AUDITOR_CONSTANTS.CRYSTALLIZATION_THRESHOLD }]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.CRYSTALLIZATION_SCAN }));

    expect(bootstrappingPort.findHighFrequencyPatterns).toHaveBeenCalledWith(
      "workspace-1",
      AUDITOR_CONSTANTS.CRYSTALLIZATION_THRESHOLD
    );
    expect(result.success).toBe(true);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("skips crystallization patterns that already have a pending synthesis candidate", async () => {
    const { auditor, bootstrappingPort } = createAuditor({
      patterns: [
        { pattern_key: "pattern-a", frequency: 4 },
        { pattern_key: "pattern-b", frequency: 5 }
      ],
      pendingPatternKeys: ["pattern-a"]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.CRYSTALLIZATION_SCAN }));

    expect(bootstrappingPort.hasPendingSynthesisCandidate).toHaveBeenNthCalledWith(
      1,
      "workspace-1",
      "pattern-a"
    );
    expect(bootstrappingPort.createSynthesisCandidate).toHaveBeenCalledTimes(1);
    expect(bootstrappingPort.createSynthesisCandidate).toHaveBeenCalledWith("workspace-1", "pattern-b");
    expect(result.objects_affected).toEqual(["candidate:pattern-b"]);
  });


  it("creates synthesis candidates for crystallization patterns without pending proposals", async () => {
    const { auditor, bootstrappingPort, scheduler } = createAuditor({
      patterns: [
        { pattern_key: "pattern-a", frequency: 4 },
        { pattern_key: "pattern-b", frequency: 6 }
      ]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.CRYSTALLIZATION_SCAN }));

    expect(bootstrappingPort.createSynthesisCandidate).toHaveBeenNthCalledWith(
      1,
      "workspace-1",
      "pattern-a"
    );
    expect(bootstrappingPort.createSynthesisCandidate).toHaveBeenNthCalledWith(
      2,
      "workspace-1",
      "pattern-b"
    );
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["candidate:pattern-a", "candidate:pattern-b"]
    });
    expect(result.audit_entries).toEqual([
      "crystallization_scan: 2 synthesis candidates created from 2 high-frequency patterns"
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("reports completion with success = true across all supported task kinds", async () => {
    const { auditor, scheduler } = createAuditor({
      coldStartAssessment: {
        is_cold_start: false,
        memory_count: 0,
        claim_count: 0
      }
    });

    const taskKinds = [
      GardenTaskKind.EVIDENCE_STALENESS_CHECK,
      GardenTaskKind.POINTER_HEALTH_CHECK,
      GardenTaskKind.GREEN_MAINTENANCE,
      GardenTaskKind.BOOTSTRAPPING_SCAN,
      GardenTaskKind.CRYSTALLIZATION_SCAN
    ] as const;

    for (const taskKind of taskKinds) {
      const result = await auditor.run(createTask({ task_kind: taskKind }));
      expect(result.success).toBe(true);
    }

    expect(scheduler.reportCompletion).toHaveBeenCalledTimes(taskKinds.length);
    for (const call of scheduler.reportCompletion.mock.calls) {
      expect(call[0]).toMatchObject({ success: true, role: GardenRole.AUDITOR, tier: GardenTier.TIER_1 });
    }
  });


  it("reports failure when a port throws", async () => {
    const { auditor, scheduler } = createAuditor({
      findBrokenPointers: vi.fn(async () => {
        throw new Error("pointer index unavailable");
      })
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.POINTER_HEALTH_CHECK }));

    expect(result).toMatchObject({
      success: false,
      error_message: "pointer index unavailable",
      objects_affected: [],
      audit_entries: []
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("reports failure for unsupported task kinds", async () => {
    const { auditor, scheduler } = createAuditor();

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.TTL_CLEANUP }));

    expect(result).toMatchObject({
      task_kind: GardenTaskKind.TTL_CLEANUP,
      success: false,
      error_message: "Auditor does not handle task kind: ttl_cleanup"
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("does not handle path_plasticity_update after the Gate-5F owner move", async () => {
    const { auditor, scheduler } = createAuditor();

    const result = await auditor.run(
      createTask({
        task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
        required_tier: GardenTier.TIER_2
      })
    );

    expect(result).toMatchObject({
      task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      success: false,
      error_message: "Auditor does not handle task kind: path_plasticity_update"
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });


  it("limits crystallization processing to the first batch of patterns", async () => {
    const patterns: HighFrequencyPattern[] = Array.from(
      { length: AUDITOR_CONSTANTS.BATCH_SIZE + 3 },
      (_, index) => ({
        pattern_key: `pattern-${index + 1}`,
        frequency: AUDITOR_CONSTANTS.CRYSTALLIZATION_THRESHOLD
      })
    );
    const { auditor, bootstrappingPort } = createAuditor({ patterns });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.CRYSTALLIZATION_SCAN }));

    expect(bootstrappingPort.createSynthesisCandidate).toHaveBeenCalledTimes(AUDITOR_CONSTANTS.BATCH_SIZE);
    expect(result.objects_affected).toHaveLength(AUDITOR_CONSTANTS.BATCH_SIZE);
  });
});

function createAuditor(options: {
  readonly staleEntries?: readonly StaleMemoryEntry[];
  readonly brokenPointers?: readonly BrokenPointerRecord[];
  readonly expiringStatuses?: readonly ExpiringGreenStatus[];
  readonly coldStartAssessment?: ColdStartAssessment;
  readonly draftCandidates?: readonly DraftCandidate[];
  readonly patterns?: readonly HighFrequencyPattern[];
  readonly pendingPatternKeys?: readonly string[];
  readonly findBrokenPointers?: (workspaceId: string) => Promise<readonly BrokenPointerRecord[]>;
  readonly eventLogRepo?: AuditorDependencies["eventLogRepo"];
  readonly revokeAffected?: number;
} = {}) {
  const evidenceCheckPort = {
    findMemoriesWithStaleEvidence: vi.fn(async () => options.staleEntries ?? [])
  };
  const pointerHealthPort = {
    findBrokenPointers:
      options.findBrokenPointers ??
      vi.fn(async () => options.brokenPointers ?? []),
    repair: vi.fn(async () => undefined)
  };
  const greenMaintenancePort = {
    findExpiringGreenStatuses: vi.fn(async () => options.expiringStatuses ?? []),
    renewGreenPassiveStable: vi.fn(async () => undefined),
    requestActiveVerification: vi.fn(async () => undefined),
    revokeGreen: vi.fn(() => ({ affected: options.revokeAffected ?? 1 }))
  };
  const bootstrappingPort = {
    assessColdStart: vi.fn(
      async () =>
        options.coldStartAssessment ?? {
          is_cold_start: false,
          memory_count: 12,
          claim_count: 6
        }
    ),
    generateDraftCandidates: vi.fn(async () => options.draftCandidates ?? []),
    findHighFrequencyPatterns: vi.fn(async () => options.patterns ?? []),
    createSynthesisCandidate: vi.fn(async (_workspaceId: string, patternKey: string) => ({
      candidate_id: `candidate:${patternKey}`
    })),
    hasPendingSynthesisCandidate: vi.fn(async (_workspaceId: string, patternKey: string) =>
      (options.pendingPatternKeys ?? []).includes(patternKey)
    )
  };
  const scheduler = {
    reportCompletion: vi.fn<AuditorDependencies["scheduler"]["reportCompletion"]>(
      async () => undefined
    )
  };
  const healthJournal = {
    record: vi.fn(async () => undefined)
  };

  return {
    auditor: new Auditor({
      evidenceCheckPort,
      pointerHealthPort,
      greenMaintenancePort,
      bootstrappingPort,
      scheduler,
      healthJournal,
      eventLogRepo: options.eventLogRepo,
      now: () => "2026-03-27T00:00:00.000Z"
    }),
    evidenceCheckPort,
    pointerHealthPort,
    greenMaintenancePort,
    bootstrappingPort,
    scheduler,
    healthJournal
  };
}

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK,
    required_tier: GardenTier.TIER_1,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}

