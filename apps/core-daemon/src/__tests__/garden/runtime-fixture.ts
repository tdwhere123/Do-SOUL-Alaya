import { vi } from "vitest";
import type { PathGraphSnapshot, PathRelation } from "@do-soul/alaya-protocol";
import { createGardenRuntime } from "../../garden/runtime.js";

export type GardenRuntimeInput = Parameters<typeof createGardenRuntime>[0];

export function createConsolidationCapableConnection(): GardenRuntimeInput["databaseConnection"] {
  // A prepare()-bearing connection also makes createGardenRuntime construct a
  // SqliteGardenTaskRepo (its abandoned-claim reclaim calls statement.all), so
  // every fake statement answers get/all/run with empty results: an empty
  // budget table (get -> undefined) means no cooldown, so the cycle proceeds.
  const statement = { get: () => undefined, all: () => [], run: () => undefined };
  return {
    prepare: () => statement
  } as unknown as GardenRuntimeInput["databaseConnection"];
}

export function createDormantPath(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "obj-a" },
      target_anchor: { kind: "object", object_id: "obj-b" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["seed-why"]
    },
    effect_vector: {
      salience: 0,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.05,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "dormant",
      retirement_rule: "retire_after_cooldown"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-10T00:00:00.000Z",
    ...overrides
  } as PathRelation;
}

export function createRuntimeInput(options: {
  // Test mocks return only the result fields the garden runtime reads
  // (reinforced/weakened/retired/affectedPathIds); the full
  // PathPlasticityComputeResult shape is cast on at the assignment below.
  readonly computeAndApplyPlasticity: (
    params: Parameters<
      NonNullable<GardenRuntimeInput["pathPlasticityService"]>["computeAndApplyPlasticity"]
    >[0]
  ) => Promise<{
    readonly reinforced: number;
    readonly weakened: number;
    readonly retired: number;
    readonly affectedPathIds: readonly string[];
  }>;
  readonly gardenDataPorts?: GardenRuntimeInput["gardenDataPorts"];
  readonly healthJournalRepo?: GardenRuntimeInput["healthJournalRepo"];
  readonly embeddingBackfillHandler?: GardenRuntimeInput["embeddingBackfillHandler"];
  readonly pathRelationRepo?: GardenRuntimeInput["pathRelationRepo"];
  readonly pathPlasticityWatermarkRepo?: GardenRuntimeInput["pathPlasticityWatermarkRepo"];
  readonly workspaceRepo?: GardenRuntimeInput["workspaceRepo"];
  // A prepare()-bearing connection makes createGardenRuntime construct the
  // ConsolidationExecutor (else it is null and the consolidation cycle is
  // skipped). Default {} keeps the existing tests on the null-executor path.
  readonly databaseConnection?: GardenRuntimeInput["databaseConnection"];
  // Legacy topology mutation is deliberately opt-in in non-S4 fixtures.
  readonly legacyTopologyMutationsEnabled?: boolean;
}): GardenRuntimeInput {
  let latestSnapshot: PathGraphSnapshot | null = null;
  const publish = vi.fn(async (entry: Record<string, unknown>) => ({
    event_id: `event-${publish.mock.calls.length + 1}`,
    created_at: "2026-05-05T12:00:00.000Z",
    revision: 1,
    ...entry
  }));

  return {
    databaseConnection:
      options.databaseConnection ?? ({} as GardenRuntimeInput["databaseConnection"]),
    backlogThresholds: {
      warning_queue_depth: 100,
      warning_rearm_depth: 50,
      // Not consumed by createGardenRuntime (only warning_queue_depth /
      // warning_rearm_depth are read); present to satisfy
      // GardenBacklogThresholds.
      snapshot_interval_ms: 1000
    },
    eventLogRepo: {} as GardenRuntimeInput["eventLogRepo"],
    eventPublisher: {
      publish,
      appendManyWithMutation: vi.fn(
        async (
          entries: readonly Record<string, unknown>[],
          mutate: (entries: readonly Record<string, unknown>[]) => unknown
        ) =>
          mutate(
            entries.map((entry, index) => ({
              event_id: `event-many-${index + 1}`,
              created_at: "2026-05-05T12:00:00.000Z",
              revision: 1,
              ...entry
            }))
          )
      )
    } as unknown as GardenRuntimeInput["eventPublisher"],
    gardenDataPorts: options.gardenDataPorts ?? createGardenDataPorts(),
    healthJournalRepo:
      options.healthJournalRepo ??
      ({
        append: vi.fn(async () => undefined)
      } as unknown as GardenRuntimeInput["healthJournalRepo"]),
    handoffGapRepo: {
      findExpiredObjectsByWorkspace: vi.fn(async () => []),
      deleteById: vi.fn()
    } as unknown as GardenRuntimeInput["handoffGapRepo"],
    orphanDetectionEnabled: false,
    orphanRadarRepo: null,
    pathGraphSnapshotRepo: {
      findLatest: vi.fn(async () => latestSnapshot),
      create: vi.fn((snapshot: PathGraphSnapshot) => {
        latestSnapshot = snapshot;
      }),
      findHistory: vi.fn(async () => (latestSnapshot === null ? [] : [latestSnapshot])),
      deleteOlderThan: vi.fn(async () => undefined)
    } as unknown as GardenRuntimeInput["pathGraphSnapshotRepo"],
    pathRelationRepo:
      options.pathRelationRepo ??
      ({
        findActive: vi.fn(async () => []),
        findByAnchors: vi.fn(async () => [])
      } as unknown as GardenRuntimeInput["pathRelationRepo"]),
    ...(options.legacyTopologyMutationsEnabled === true
      ? { legacyTopologyMutationsEnabled: true }
      : {}),
    ...(options.pathPlasticityWatermarkRepo === undefined
      ? {}
      : { pathPlasticityWatermarkRepo: options.pathPlasticityWatermarkRepo }),
    pathPlasticityService: {
      computeAndApplyPlasticity:
        options.computeAndApplyPlasticity as NonNullable<
          GardenRuntimeInput["pathPlasticityService"]
        >["computeAndApplyPlasticity"]
    },
    ...(options.embeddingBackfillHandler === undefined
      ? {}
      : { embeddingBackfillHandler: options.embeddingBackfillHandler }),
    strongRefService: {
      isProtected: vi.fn(async () => false)
    } as unknown as GardenRuntimeInput["strongRefService"],
    workspaceRepo:
      options.workspaceRepo ??
      ({
        list: vi.fn(async () => [{ workspace_id: "workspace-1" }])
      } as unknown as GardenRuntimeInput["workspaceRepo"])
  };
}

export function createGardenDataPorts(
  overrides: Partial<GardenRuntimeInput["gardenDataPorts"]> = {}
): GardenRuntimeInput["gardenDataPorts"] {
  return {
    evidenceCheckPort: overrides.evidenceCheckPort ?? { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
    pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
    greenMaintenancePort: {
      findExpiringGreenStatuses: vi.fn(async () => []),
      renewGreenPassiveStable: vi.fn(async () => undefined),
      requestActiveVerification: vi.fn(async () => undefined),
      revokeGreen: vi.fn(() => ({ affected: 0 })),
      ...(overrides.greenMaintenancePort ?? {})
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
    tieringPort: {
      findHotDemotionCandidates: vi.fn(async () => []),
      demoteToWarm: vi.fn(async () => undefined)
    },
    dormantDemotionPort: {
      findLowActivityActiveMemories: vi.fn(async () => []),
      setLifecycleDormant: vi.fn(async () => "skipped" as const),
      ...(overrides.dormantDemotionPort ?? {})
    },
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
    }
  } as GardenRuntimeInput["gardenDataPorts"];
}
