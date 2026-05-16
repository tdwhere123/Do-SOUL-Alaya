import { describe, expect, it, vi } from "vitest";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  MemoryDimension,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import {
  AUDITOR_CONSTANTS,
  Auditor,
  type BrokenPointerRecord,
  type ColdStartAssessment,
  type DraftCandidate,
  type ExpiringGreenStatus,
  type HighFrequencyPattern,
  type StaleMemoryEntry
} from "../garden/auditor.js";

describe("Auditor", () => {
  it("exposes the auditor role and tier", () => {
    const auditor = createAuditor().auditor;

    expect(auditor.role).toBe("auditor");
    expect(auditor.tier).toBe("tier_1");
  });

  it("runs evidence staleness checks, revokes Green, records health diagnostics, and reports completion", async () => {
    const { auditor, evidenceCheckPort, greenMaintenancePort, healthJournal, scheduler } = createAuditor({
      staleEntries: [
        { memory_entry_id: "memory-1", stale_evidence_refs: ["evidence-1"] },
        { memory_entry_id: "memory-2", stale_evidence_refs: ["evidence-2", "evidence-3"] }
      ]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK }));

    expect(evidenceCheckPort.findMemoriesWithStaleEvidence).toHaveBeenCalledWith("workspace-1");
    expect(greenMaintenancePort.revokeGreen).toHaveBeenNthCalledWith(
      1,
      "memory-1",
      "verification_fail",
      "task-1",
      "workspace-1"
    );
    expect(greenMaintenancePort.revokeGreen).toHaveBeenNthCalledWith(
      2,
      "memory-2",
      "verification_fail",
      "task-1",
      "workspace-1"
    );
    expect(healthJournal.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.EVIDENCE_FAILURE,
        workspace_id: "workspace-1",
        detail_json: expect.objectContaining({
          affected_memory_ids: ["memory-1", "memory-2"],
          total_stale_refs: 3
        })
      })
    );
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["memory-1", "memory-2"],
      audit_entries: ["evidence_staleness_check: revoked green for 2 entries (noop: 0)"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  // gate-6-delta I4: revoke + renew + grace_request now commit a
  // green-governance EventLog row in the same SQLite transaction as
  // the underlying SQL UPDATE. The mock eventLogRepo captures the
  // (events, mutate) pair so we can assert (a) the canonical event
  // type lands and (b) the storage mutation runs inside the
  // transaction body, not before/after.
  it("emits SOUL_GREEN_REVOKED alongside revoke during evidence staleness check", async () => {
    const appendManyWithMutation = vi.fn(async (entries: readonly unknown[], mutate: (rows: readonly unknown[]) => unknown) => {
      const persisted = entries.map((entry, idx) => ({ ...(entry as object), event_id: `evt-${idx}`, created_at: "2026-03-27T00:00:00.000Z", revision: idx }));
      mutate(persisted);
      return undefined;
    });
    const eventLogRepo = {
      append: vi.fn(),
      appendManyWithMutation
    } as unknown as { readonly appendManyWithMutation: ReturnType<typeof vi.fn> };
    const { auditor, greenMaintenancePort } = createAuditor({
      staleEntries: [{ memory_entry_id: "memory-1", stale_evidence_refs: ["evidence-1"] }],
      eventLogRepo
    });

    await auditor.run(createTask({ task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK }));

    expect(appendManyWithMutation).toHaveBeenCalledTimes(1);
    const firstCall = appendManyWithMutation.mock.calls[0] ?? [[], () => undefined];
    const emittedEntries = firstCall[0];
    expect(emittedEntries).toEqual([
      expect.objectContaining({
        event_type: "soul.green.revoked",
        entity_type: "memory_entry",
        entity_id: "memory-1",
        workspace_id: "workspace-1",
        caused_by: "auditor",
        payload_json: expect.objectContaining({
          target_object_id: "memory-1",
          revoke_reason: "verification_fail",
          task_id: "task-1"
        })
      })
    ]);
    // The storage mutation still ran (inside the mutate callback).
    expect(greenMaintenancePort.revokeGreen).toHaveBeenCalledWith(
      "memory-1",
      "verification_fail",
      "task-1",
      "workspace-1"
    );
  });

  it("emits SOUL_GREEN_RENEWED for passive-stable expiring statuses and SOUL_GREEN_GRACE_REQUESTED for verification-required ones", async () => {
    const appendManyWithMutation = vi.fn(async (entries: readonly unknown[], mutate: (rows: readonly unknown[]) => unknown) => {
      const persisted = entries.map((entry, idx) => ({ ...(entry as object), event_id: `evt-${idx}`, created_at: "2026-03-27T00:00:00.000Z", revision: idx }));
      mutate(persisted);
      return undefined;
    });
    const eventLogRepo = {
      append: vi.fn(),
      appendManyWithMutation
    } as unknown as { readonly appendManyWithMutation: ReturnType<typeof vi.fn> };
    const { auditor, greenMaintenancePort } = createAuditor({
      expiringStatuses: [
        createExpiringGreenStatus("g1", MemoryDimension.PREFERENCE),
        createExpiringGreenStatus("g2", MemoryDimension.FACT)
      ],
      eventLogRepo
    });

    await auditor.run(createTask({ task_kind: GardenTaskKind.GREEN_MAINTENANCE }));

    const allEntries = appendManyWithMutation.mock.calls.flatMap((call) => call[0] ?? []);
    const eventTypes = allEntries.map((entry) => (entry as { readonly event_type: string }).event_type);
    expect(eventTypes).toContain("soul.green.renewed");
    expect(eventTypes).toContain("soul.green.grace_requested");
    expect(greenMaintenancePort.renewGreenPassiveStable).toHaveBeenCalledWith("g1", "task-1");
    expect(greenMaintenancePort.requestActiveVerification).toHaveBeenCalledWith("g2", "task-1");
  });

  it("does not revoke Green or record health diagnostics when evidence staleness finds nothing", async () => {
    const { auditor, greenMaintenancePort, healthJournal, scheduler } = createAuditor();

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK }));

    expect(greenMaintenancePort.revokeGreen).not.toHaveBeenCalled();
    expect(healthJournal.record).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries).toEqual([
      "evidence_staleness_check: revoked green for 0 entries (noop: 0)"
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("limits evidence staleness processing to the first batch", async () => {
    const staleEntries: StaleMemoryEntry[] = Array.from(
      { length: AUDITOR_CONSTANTS.BATCH_SIZE + 4 },
      (_, index) => ({
        memory_entry_id: `memory-${index + 1}`,
        stale_evidence_refs: [`evidence-${index + 1}`]
      })
    );
    const { auditor, greenMaintenancePort } = createAuditor({ staleEntries });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK }));

    expect(greenMaintenancePort.revokeGreen).toHaveBeenCalledTimes(AUDITOR_CONSTANTS.BATCH_SIZE);
    expect(result.objects_affected).toHaveLength(AUDITOR_CONSTANTS.BATCH_SIZE);
  });

  it("runs pointer health checks and records broken pointer diagnostics", async () => {
    const { auditor, pointerHealthPort, healthJournal, scheduler } = createAuditor({
      brokenPointers: [
        {
          source_object_id: "memory-1",
          source_object_kind: "memory_entry",
          broken_ref: "evidence-missing",
          ref_kind: "evidence_ref"
        }
      ]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.POINTER_HEALTH_CHECK }));

    expect(pointerHealthPort.findBrokenPointers).toHaveBeenCalledWith("workspace-1");
    expect(healthJournal.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event_kind: HealthEventKind.POINTER_FAILURE,
        detail_json: expect.objectContaining({
          broken_count: 1
        })
      })
    );
    expect(result).toMatchObject({
      success: true,
      objects_affected: ["memory-1"],
      audit_entries: ["pointer_health_check: detected 1 broken refs (detection only)"]
    });
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("does not call any repair method during pointer health checks", async () => {
    const { auditor, pointerHealthPort } = createAuditor({
      brokenPointers: [
        {
          source_object_id: "memory-1",
          source_object_kind: "memory_entry",
          broken_ref: "memory-missing",
          ref_kind: "memory_ref"
        }
      ]
    });

    await auditor.run(createTask({ task_kind: GardenTaskKind.POINTER_HEALTH_CHECK }));

    expect(pointerHealthPort.repair).not.toHaveBeenCalled();
  });

  it("renews preference and episode Green statuses with passive stable verification", async () => {
    const { auditor, greenMaintenancePort, scheduler } = createAuditor({
      expiringStatuses: [
        createExpiringGreenStatus("green-1", MemoryDimension.PREFERENCE),
        createExpiringGreenStatus("green-2", MemoryDimension.EPISODE)
      ]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.GREEN_MAINTENANCE }));

    expect(greenMaintenancePort.findExpiringGreenStatuses).toHaveBeenCalledWith(
      "workspace-1",
      AUDITOR_CONSTANTS.EXPIRY_LOOKAHEAD_MS
    );
    expect(greenMaintenancePort.renewGreenPassiveStable).toHaveBeenNthCalledWith(1, "green-1", "task-1");
    expect(greenMaintenancePort.renewGreenPassiveStable).toHaveBeenNthCalledWith(2, "green-2", "task-1");
    expect(greenMaintenancePort.requestActiveVerification).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual(["green-1", "green-2"]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("requests active verification for fact, constraint, and procedure Green statuses", async () => {
    const { auditor, greenMaintenancePort } = createAuditor({
      expiringStatuses: [
        createExpiringGreenStatus("green-fact", MemoryDimension.FACT),
        createExpiringGreenStatus("green-constraint", MemoryDimension.CONSTRAINT),
        createExpiringGreenStatus("green-procedure", MemoryDimension.PROCEDURE)
      ]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.GREEN_MAINTENANCE }));

    expect(greenMaintenancePort.requestActiveVerification).toHaveBeenNthCalledWith(
      1,
      "green-fact",
      "task-1"
    );
    expect(greenMaintenancePort.requestActiveVerification).toHaveBeenNthCalledWith(
      2,
      "green-constraint",
      "task-1"
    );
    expect(greenMaintenancePort.requestActiveVerification).toHaveBeenNthCalledWith(
      3,
      "green-procedure",
      "task-1"
    );
    expect(greenMaintenancePort.renewGreenPassiveStable).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual(["green-fact", "green-constraint", "green-procedure"]);
  });

  it("skips hazard Green statuses during maintenance", async () => {
    const { auditor, greenMaintenancePort, scheduler } = createAuditor({
      expiringStatuses: [createExpiringGreenStatus("green-hazard", MemoryDimension.HAZARD)]
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.GREEN_MAINTENANCE }));

    expect(greenMaintenancePort.renewGreenPassiveStable).not.toHaveBeenCalled();
    expect(greenMaintenancePort.requestActiveVerification).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries).toEqual(["green_maintenance: processed 0 expiring green statuses"]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("assesses cold start and generates draft candidates when bootstrapping is needed", async () => {
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
  readonly eventLogRepo?: { readonly appendManyWithMutation: ReturnType<typeof vi.fn> };
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
    reportCompletion: vi.fn(async () => undefined)
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

function createExpiringGreenStatus(
  greenStatusId: string,
  dimension: MemoryDimension
): ExpiringGreenStatus {
  return {
    green_status_id: greenStatusId,
    memory_entry_id: `${greenStatusId}-memory`,
    dimension,
    valid_until: "2026-03-28T00:00:00.000Z"
  };
}
