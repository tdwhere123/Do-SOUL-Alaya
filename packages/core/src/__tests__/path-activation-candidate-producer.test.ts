import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  DirectionBias,
  ManifestationLevel,
  ManifestationPreference,
  PathGovernanceClass,
  PathLifecycleStatus,
  RetentionPolicy,
  StabilityClass,
  type ActivationCandidate,
  type EventLogEntry,
  type ManifestationBudgetConfig,
  type PathRelation,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  AuditorSchedulingAdvisor,
  type PathVerificationBiasReaderPort
} from "../auditor-scheduling-advisor.js";
import { ManifestationResolver } from "../manifestation-resolver.js";
import {
  PathActivationCandidateProducer,
  type PathActivationCandidateProducerPathReaderPort
} from "../path-activation-candidate-producer.js";

const NOW = "2026-04-17T09:00:00.000Z";
const WORKSPACE = "workspace-alpha";
const RUN = "run-alpha";

describe("PathActivationCandidateProducer", () => {
  it("emits no candidates for retired paths", async () => {
    const activePath = createPathRelation({
      path_id: "path-active",
      sourceMemoryId: "mem-source",
      targetMemoryId: "mem-target"
    });
    const retiredPath = createPathRelation({
      path_id: "path-retired",
      sourceMemoryId: "mem-source",
      targetMemoryId: "mem-other",
      lifecycleStatus: PathLifecycleStatus.RETIRED
    });
    const reader: PathActivationCandidateProducerPathReaderPort = {
      findActiveByAnchorObjectIds: vi.fn(async () => [activePath, retiredPath])
    };
    const producer = new PathActivationCandidateProducer({
      pathReader: reader,
      generateCandidateId: stableIdGenerator("cand"),
      now: () => NOW
    });

    const candidates = await producer.produce({
      workspaceId: WORKSPACE,
      runId: RUN,
      anchorMemoryObjectIds: ["mem-source"]
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source_path_id).toBe("path-active");
  });

  it("emits no candidates for dormant paths (dormant is excluded from activation just like retired)", async () => {
    const activePath = createPathRelation({
      path_id: "path-active",
      sourceMemoryId: "mem-source",
      targetMemoryId: "mem-target"
    });
    const dormantPath = createPathRelation({
      path_id: "path-dormant",
      sourceMemoryId: "mem-source",
      targetMemoryId: "mem-other",
      lifecycleStatus: PathLifecycleStatus.DORMANT
    });
    const reader: PathActivationCandidateProducerPathReaderPort = {
      findActiveByAnchorObjectIds: vi.fn(async () => [activePath, dormantPath])
    };
    const producer = new PathActivationCandidateProducer({
      pathReader: reader,
      generateCandidateId: stableIdGenerator("cand"),
      now: () => NOW
    });

    const candidates = await producer.produce({
      workspaceId: WORKSPACE,
      runId: RUN,
      anchorMemoryObjectIds: ["mem-source"]
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source_path_id).toBe("path-active");
  });

  it("emits no candidates for negative-bias paths (recall_bias < 0 is suppression, not activation)", async () => {
    const activePath = createPathRelation({
      path_id: "path-active",
      sourceMemoryId: "mem-source",
      targetMemoryId: "mem-target"
    });
    const negativePath = createPathRelation({
      path_id: "path-negative",
      sourceMemoryId: "mem-source",
      targetMemoryId: "mem-other",
      // recall_bias = recallBiasSign(-1) * magnitude(0.4): a negative path
      // records suppression and must never surface as a positive activation
      // candidate, even when its lifecycle is active.
      effectVectorOverrides: { recall_bias: -0.4 }
    });
    const reader: PathActivationCandidateProducerPathReaderPort = {
      findActiveByAnchorObjectIds: vi.fn(async () => [activePath, negativePath])
    };
    const producer = new PathActivationCandidateProducer({
      pathReader: reader,
      generateCandidateId: stableIdGenerator("cand"),
      now: () => NOW
    });

    const candidates = await producer.produce({
      workspaceId: WORKSPACE,
      runId: RUN,
      anchorMemoryObjectIds: ["mem-source"]
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source_path_id).toBe("path-active");
  });

  it("emits no candidates for recall-neutral exception_to paths (recall_bias == 0)", async () => {
    const activePath = createPathRelation({
      path_id: "path-active",
      sourceMemoryId: "mem-source",
      targetMemoryId: "mem-target"
    });
    const neutralPath = createPathRelation({
      path_id: "path-neutral",
      sourceMemoryId: "mem-source",
      targetMemoryId: "mem-other",
      // recall_bias exactly 0: a topology marker excluded by the
      // strict-positive isPathRecallEligible gate.
      effectVectorOverrides: { recall_bias: 0 }
    });
    const reader: PathActivationCandidateProducerPathReaderPort = {
      findActiveByAnchorObjectIds: vi.fn(async () => [activePath, neutralPath])
    };
    const producer = new PathActivationCandidateProducer({
      pathReader: reader,
      generateCandidateId: stableIdGenerator("cand"),
      now: () => NOW
    });

    const candidates = await producer.produce({
      workspaceId: WORKSPACE,
      runId: RUN,
      anchorMemoryObjectIds: ["mem-source"]
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source_path_id).toBe("path-active");
  });

  it("snapshots effect_vector immutably (source mutation does not leak)", async () => {
    const sourceEffectVector = {
      salience: 0.42,
      recall_bias: 0.18,
      verification_bias: 0.7,
      unfinishedness_bias: 0.55,
      default_manifestation_preference: ManifestationPreference.DIALOGUE_NUDGE
    };
    const mutablePath: PathRelation = {
      ...createPathRelation({
        path_id: "path-snapshot",
        sourceMemoryId: "mem-source",
        targetMemoryId: "mem-target"
      }),
      effect_vector: sourceEffectVector
    } as PathRelation;
    const reader: PathActivationCandidateProducerPathReaderPort = {
      findActiveByAnchorObjectIds: vi.fn(async () => [mutablePath])
    };
    const producer = new PathActivationCandidateProducer({
      pathReader: reader,
      generateCandidateId: stableIdGenerator("cand"),
      now: () => NOW
    });

    const candidates = await producer.produce({
      workspaceId: WORKSPACE,
      runId: RUN,
      anchorMemoryObjectIds: ["mem-source"]
    });

    expect(candidates).toHaveLength(1);
    const snapshot = candidates[0]?.effect_vector_snapshot;
    expect(snapshot).toEqual({
      salience: 0.42,
      recall_bias: 0.18,
      verification_bias: 0.7,
      unfinishedness_bias: 0.55,
      default_manifestation_preference: ManifestationPreference.DIALOGUE_NUDGE
    });

    // Mutating the source effect_vector after emission must not affect the
    // candidate snapshot — producer copies the fields, not the reference.
    (sourceEffectVector as { salience: number }).salience = 0.999;
    (sourceEffectVector as { verification_bias: number }).verification_bias = 0.001;
    expect(candidates[0]?.effect_vector_snapshot.salience).toBe(0.42);
    expect(candidates[0]?.effect_vector_snapshot.verification_bias).toBe(0.7);
  });
});

describe("AuditorSchedulingAdvisor.prioritizeRechecksByBias", () => {
  it("orders peers by verification_bias descending — nonzero bias wins over zero", async () => {
    const biasMap: Record<string, number> = {
      "mem-zero-bias": 0,
      "mem-high-bias": 0.6,
      "mem-mid-bias": 0.3
    };
    const reader: PathVerificationBiasReaderPort = {
      getMaxVerificationBias: vi.fn(async (_workspaceId, memoryId) => biasMap[memoryId] ?? 0)
    };
    const advisor = new AuditorSchedulingAdvisor({ verificationBiasReader: reader });

    const prioritized = await advisor.prioritizeRechecksByBias(WORKSPACE, [
      { memoryObjectId: "mem-zero-bias", enqueuedAt: "2026-04-17T08:00:00.000Z" },
      { memoryObjectId: "mem-high-bias", enqueuedAt: "2026-04-17T09:00:00.000Z" },
      { memoryObjectId: "mem-mid-bias", enqueuedAt: "2026-04-17T08:30:00.000Z" }
    ]);

    expect(prioritized.map((entry) => entry.memoryObjectId)).toEqual([
      "mem-high-bias",
      "mem-mid-bias",
      "mem-zero-bias"
    ]);
    expect(prioritized[0]?.verificationBias).toBe(0.6);
  });

});

describe("ManifestationResolver.resolveWithBias", () => {
  it("propagates unfinishedness_bias to a sidecar entry keyed by target memory", async () => {
    const candidate: ActivationCandidate = {
      candidate_id: "candidate-pending",
      workspace_id: WORKSPACE,
      run_id: RUN,
      source_path_id: "path-pending",
      source_anchor: { kind: "object", object_id: "mem-source" },
      target_anchor: { kind: "object", object_id: "mem-target" },
      why_now: "path:co_recalled",
      effect_vector_snapshot: {
        salience: 0.8,
        recall_bias: 0.4,
        verification_bias: 0.0,
        unfinishedness_bias: 0.55,
        default_manifestation_preference: ManifestationPreference.STANCE_BIAS
      },
      pressure: 0.8,
      confidence: 0.8,
      governance_ceiling: PathGovernanceClass.RECALL_ALLOWED,
      created_at: NOW
    };
    const deps = createResolverDependencies({ config: null });
    const resolver = new ManifestationResolver({
      budgetConfigProvider: deps.budgetConfigProvider,
      eventLogWriter: deps.eventLogWriter,
      now: () => NOW
    });

    const result = await resolver.resolveWithBias({
      workspaceId: WORKSPACE,
      runId: RUN,
      candidates: [candidate],
      taskSurfaceRef: createTaskSurface(["mem-source"])
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.biasSidecar).toHaveLength(1);
    expect(result.biasSidecar[0]).toMatchObject({
      candidate_id: "candidate-pending",
      target_memory_object_id: "mem-target",
      unfinishedness_bias: 0.55,
      pending_incomplete: true
    });
  });

  it("honors default_manifestation_preference when escalation thresholds are not met", async () => {
    const candidate: ActivationCandidate = {
      candidate_id: "candidate-prefers-nudge",
      workspace_id: WORKSPACE,
      run_id: RUN,
      source_path_id: "path-preferred",
      source_anchor: { kind: "object", object_id: "mem-source" },
      target_anchor: { kind: "object", object_id: "mem-target" },
      why_now: "path:co_recalled",
      effect_vector_snapshot: {
        salience: 0.2,
        recall_bias: 0.1,
        verification_bias: 0.0,
        unfinishedness_bias: 0.0,
        default_manifestation_preference: ManifestationPreference.DIALOGUE_NUDGE
      },
      pressure: 0.1,
      confidence: 0.1,
      governance_ceiling: PathGovernanceClass.RECALL_ALLOWED,
      created_at: NOW
    };
    const deps = createResolverDependencies({ config: null });
    const resolver = new ManifestationResolver({
      budgetConfigProvider: deps.budgetConfigProvider,
      eventLogWriter: deps.eventLogWriter,
      now: () => NOW
    });

    const decisions = await resolver.resolve({
      workspaceId: WORKSPACE,
      runId: RUN,
      candidates: [candidate],
      taskSurfaceRef: null
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.assigned_level).toBe(ManifestationLevel.DIALOGUE_NUDGE);
  });
});

function createPathRelation(input: {
  readonly path_id: string;
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly lifecycleStatus?: typeof PathLifecycleStatus[keyof typeof PathLifecycleStatus];
  readonly effectVectorOverrides?: Partial<PathRelation["effect_vector"]>;
}): Readonly<PathRelation> {
  return Object.freeze({
    path_id: input.path_id,
    workspace_id: WORKSPACE,
    anchors: Object.freeze({
      source_anchor: Object.freeze({ kind: "object" as const, object_id: input.sourceMemoryId }),
      target_anchor: Object.freeze({ kind: "object" as const, object_id: input.targetMemoryId })
    }),
    constitution: Object.freeze({
      relation_kind: "co_recalled",
      why_this_relation_exists: Object.freeze(["test fixture"])
    }),
    effect_vector: Object.freeze({
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: ManifestationPreference.LENS_ENTRY,
      ...input.effectVectorOverrides
    }),
    plasticity_state: Object.freeze({
      strength: 0.6,
      direction_bias: DirectionBias.BIDIRECTIONAL_ASYMMETRIC,
      stability_class: StabilityClass.STABLE,
      support_events_count: 3,
      contradiction_events_count: 0
    }),
    lifecycle: Object.freeze({
      status: input.lifecycleStatus ?? PathLifecycleStatus.ACTIVE,
      retirement_rule: "manual"
    }),
    legitimacy: Object.freeze({
      evidence_basis: Object.freeze(["recalls_edge_co_usage"]),
      governance_class: PathGovernanceClass.RECALL_ALLOWED
    }),
    created_at: NOW,
    updated_at: NOW
  }) as Readonly<PathRelation>;
}

function stableIdGenerator(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

function createResolverDependencies(input: {
  readonly config: Readonly<ManifestationBudgetConfig> | null;
}) {
  return {
    budgetConfigProvider: {
      getConfig: vi.fn(async () => input.config)
    },
    eventLogWriter: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
        event_id: `event-${Math.random()}`,
        created_at: NOW,
        revision: 0,
        ...entry
      }))
    }
  };
}

function createTaskSurface(contextRefs: readonly string[]): Readonly<TaskObjectSurface> {
  return Object.freeze({
    runtime_id: "task-surface-fixture",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-04-17T10:00:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: "Fixture surface",
    context_refs: Object.freeze([...contextRefs])
  });
}
