import { describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  GardenTaskKind,
  GardenTier,
  HealthIssueCauseKind,
  HealthIssueResolutionState,
  HealthIssueSeverity,
  HealthIssueSuggestedAction,
  type GardenTaskDescriptor,
  type HealthIssueCauseKindValue,
  type HealthIssueGroup
} from "@do-soul/alaya-protocol";
import { Auditor, type AuditorHealthIssueGroupPort } from "../../garden/index.js";

function createTask(overrides: Partial<GardenTaskDescriptor> = {}): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: GardenTaskKind.ORPHAN_DETECTION,
    required_tier: GardenTier.TIER_1,
    workspace_id: "workspace-1",
    run_id: "run-1",
    target_object_refs: [],
    priority: 50,
    created_at: "2026-03-28T09:59:00.000Z",
    ...overrides
  };
}

function createHealthIssueGroupPortHarness(): {
  readonly port: AuditorHealthIssueGroupPort;
  readonly groups: Map<string, HealthIssueGroup>;
  readonly upserts: MockedFunction<(group: HealthIssueGroup) => void>;
} {
  const groups = new Map<string, HealthIssueGroup>();
  const upserts = vi.fn((group: HealthIssueGroup) => {
    const key = compositeKey(group.workspace_id, group.target_object_id, group.cause_kind);
    groups.set(key, group);
  });
  let counter = 0;
  const port: AuditorHealthIssueGroupPort = {
    findExistingGroup: ({ workspaceId, targetObjectId, causeKind }) =>
      groups.get(compositeKey(workspaceId, targetObjectId, causeKind)) ?? null,
    upsertHealthIssueGroup: upserts,
    generateGroupId: () => `group-${(counter += 1)}`
  };
  return { port, groups, upserts };
}

function compositeKey(workspaceId: string, targetObjectId: string, causeKind: HealthIssueCauseKindValue): string {
  return `${workspaceId}|${targetObjectId}|${causeKind}`;
}

describe("Auditor HealthIssueGroup wiring", () => {
  it("orphan_detection pass writes HealthIssueGroup rows keyed by target_memory_id x cause_kind", async () => {
    const { port, groups, upserts } = createHealthIssueGroupPortHarness();
    const auditor = new Auditor({
      evidenceCheckPort: { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      orphanDetectionPort: {
        findOrphanedMemories: vi.fn(async () => [
          {
            memory_id: "memory-a",
            workspace_id: "workspace-1",
            suspected_surface_gaps: ["surface://gap-a"],
            orphan_confidence: 0.9
          },
          {
            memory_id: "memory-b",
            workspace_id: "workspace-1",
            suspected_surface_gaps: ["surface://gap-b"],
            orphan_confidence: 0.5
          }
        ]),
        createOrphanRadarRecord: vi.fn(async () => undefined)
      },
      greenMaintenancePort: {
        findExpiringGreenStatuses: vi.fn(async () => []),
        renewGreenPassiveStable: vi.fn(() => undefined),
        requestActiveVerification: vi.fn(() => undefined),
        revokeGreen: vi.fn(() => ({ affected: 0 }))
      },
      bootstrappingPort: {
        assessColdStart: vi.fn(async () => ({ is_cold_start: false, memory_count: 5, claim_count: 5 })),
        generateDraftCandidates: vi.fn(async () => []),
        findHighFrequencyPatterns: vi.fn(async () => []),
        createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
        hasPendingSynthesisCandidate: vi.fn(async () => false)
      },
      scheduler: { reportCompletion: vi.fn(async () => undefined) },
      healthIssueGroupPort: port,
      now: () => "2026-03-28T10:00:00.000Z"
    });

    const result = await auditor.run(createTask());
    expect(result.success).toBe(true);
    expect(upserts).toHaveBeenCalledTimes(2);

    const memoryAGroup = groups.get(compositeKey("workspace-1", "memory-a", HealthIssueCauseKind.ORPHAN_RADAR));
    expect(memoryAGroup).toBeDefined();
    expect(memoryAGroup?.severity).toBe(HealthIssueSeverity.WARN);
    expect(memoryAGroup?.confidence).toBe(0.9);
    expect(memoryAGroup?.resolution_state).toBe(HealthIssueResolutionState.PENDING);
    expect(memoryAGroup?.count).toBe(1);
    expect(memoryAGroup?.suggested_actions).toContain(HealthIssueSuggestedAction.RELINK);

    const memoryBGroup = groups.get(compositeKey("workspace-1", "memory-b", HealthIssueCauseKind.ORPHAN_RADAR));
    expect(memoryBGroup?.severity).toBe(HealthIssueSeverity.INFO);
  });

  it("evidence_staleness_check writes HealthIssueGroup rows with evidence_failure cause", async () => {
    const { port, groups, upserts } = createHealthIssueGroupPortHarness();
    const auditor = new Auditor({
      evidenceCheckPort: {
        findMemoriesWithStaleEvidence: vi.fn(async () => [
          {
            memory_entry_id: "memory-x",
            stale_evidence_refs: ["evidence-1", "evidence-2"]
          }
        ])
      },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      greenMaintenancePort: {
        findExpiringGreenStatuses: vi.fn(async () => []),
        renewGreenPassiveStable: vi.fn(() => undefined),
        requestActiveVerification: vi.fn(() => undefined),
        revokeGreen: vi.fn(() => ({ affected: 1 }))
      },
      bootstrappingPort: {
        assessColdStart: vi.fn(async () => ({ is_cold_start: false, memory_count: 5, claim_count: 5 })),
        generateDraftCandidates: vi.fn(async () => []),
        findHighFrequencyPatterns: vi.fn(async () => []),
        createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
        hasPendingSynthesisCandidate: vi.fn(async () => false)
      },
      scheduler: { reportCompletion: vi.fn(async () => undefined) },
      healthIssueGroupPort: port,
      now: () => "2026-03-28T10:00:00.000Z"
    });

    const result = await auditor.run(createTask({ task_kind: GardenTaskKind.EVIDENCE_STALENESS_CHECK }));
    expect(result.success).toBe(true);
    expect(upserts).toHaveBeenCalledTimes(1);

    const evidenceFailureGroup = groups.get(
      compositeKey("workspace-1", "memory-x", HealthIssueCauseKind.EVIDENCE_FAILURE)
    );
    expect(evidenceFailureGroup).toBeDefined();
    expect(evidenceFailureGroup?.cause_kind).toBe(HealthIssueCauseKind.EVIDENCE_FAILURE);
    expect(evidenceFailureGroup?.count).toBe(2);
    expect(evidenceFailureGroup?.suggested_actions).toContain(
      HealthIssueSuggestedAction.REQUEST_EVIDENCE
    );
  });

  it("repeated orphan pass merges into the same group and bumps count + last_seen_at", async () => {
    const { port, groups, upserts } = createHealthIssueGroupPortHarness();
    const auditor = new Auditor({
      evidenceCheckPort: { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
      pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
      orphanDetectionPort: {
        findOrphanedMemories: vi.fn(async () => [
          {
            memory_id: "memory-a",
            workspace_id: "workspace-1",
            suspected_surface_gaps: ["surface://gap-a"],
            orphan_confidence: 0.9
          }
        ]),
        createOrphanRadarRecord: vi.fn(async () => undefined)
      },
      greenMaintenancePort: {
        findExpiringGreenStatuses: vi.fn(async () => []),
        renewGreenPassiveStable: vi.fn(() => undefined),
        requestActiveVerification: vi.fn(() => undefined),
        revokeGreen: vi.fn(() => ({ affected: 0 }))
      },
      bootstrappingPort: {
        assessColdStart: vi.fn(async () => ({ is_cold_start: false, memory_count: 5, claim_count: 5 })),
        generateDraftCandidates: vi.fn(async () => []),
        findHighFrequencyPatterns: vi.fn(async () => []),
        createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
        hasPendingSynthesisCandidate: vi.fn(async () => false)
      },
      scheduler: { reportCompletion: vi.fn(async () => undefined) },
      healthIssueGroupPort: port,
      now: (() => {
        const stamps = ["2026-03-28T10:00:00.000Z", "2026-03-28T11:00:00.000Z"];
        let index = 0;
        return () => stamps[Math.min(index++, stamps.length - 1)]!;
      })()
    });

    await auditor.run(createTask({ task_id: "task-1" }));
    await auditor.run(createTask({ task_id: "task-2" }));

    expect(upserts).toHaveBeenCalledTimes(2);
    const group = groups.get(compositeKey("workspace-1", "memory-a", HealthIssueCauseKind.ORPHAN_RADAR));
    expect(group).toBeDefined();
    expect(group?.count).toBe(2);
    expect(group?.first_seen_at).toBe("2026-03-28T10:00:00.000Z");
    expect(group?.last_seen_at).toBe("2026-03-28T11:00:00.000Z");
  });
});
