import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MemoryGovernanceEventType,
  ObjectLifecycleState,
  RecallContextEventType,
  ProjectMappingState,
  RetentionPolicy,
  ScopeClass,
  SynthesisStatus,
  type EventLogEntry,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallPolicy,
  type SoulActiveConstraint,
  type Slot,
  type SynthesisCapsule,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  RecallService,
  classifyGlobalCandidate,
  type RecallServiceDependencies
} from "../../recall/recall-service.js";
import type {
  RecallServiceEmbeddingRecallPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort
} from "../../recall/recall-service-types.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/embedding-recall-service.js";
import {
  createAnchor,
  createDependencies,
  createMemoryEntry,
  createPathRelation,
  createPreparedQueryHandle,
  createSlot,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
  it("uses the unified path plane for direct (path_expansion) and multi-hop (graph_expansion) candidate generation", async () => {
    // graph_expansion and path_expansion now traverse the same PathRelation
    // plane. A direct hop-1 association is admitted on path_expansion; a hop-2
    // neighbor reached only by traversal is admitted on graph_expansion. The
    // double-count guard keeps a target on exactly one plane.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "graph-target",
        content: "Graph neighbor has the answer.",
        activation_score: 0.1,
        domain_tags: ["graph"]
      }),
      createMemoryEntry({
        object_id: "path-target",
        content: "Path neighbor has the answer.",
        activation_score: 0.1,
        domain_tags: ["path"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    // seed -> path-target (direct, path_expansion); seed -> graph-target
    // (direct path that the multi-hop traversal would also see, but the guard
    // keeps it on path_expansion). To prove graph_expansion still produces a
    // hop-2-only neighbor we route graph-target one hop beyond path-target.
    const seedToPathTarget = createPathRelation({
      path_id: "path-direct",
      sourceId: "seed-memory",
      targetId: "path-target",
      relationKind: "co_recalled",
      strength: 1
    });
    const pathTargetToGraphTarget = createPathRelation({
      path_id: "path-hop2",
      sourceId: "path-target",
      targetId: "graph-target",
      relationKind: "supports",
      strength: 1
    });
    const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
      const ids = new Set(
        anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
      );
      const out: PathRelation[] = [];
      if (ids.has("seed-memory")) {
        out.push(seedToPathTarget);
      }
      if (ids.has("path-target")) {
        out.push(pathTargetToGraphTarget);
      }
      return out;
    });
    const pathExpansionPort: RecallServicePathExpansionPort = { findByAnchors };
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 1
        },
        semantic_supplement: {
          enabled: false,
          max_supplement: 0
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
          max_entries: 3,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      expect.arrayContaining(["seed-memory", "graph-target", "path-target"])
    );
    // path-target is a direct hop-1 association off the seed -> path_expansion.
    expect(result.diagnostics?.candidates.find((candidate) => candidate.object_id === "path-target")?.admission_planes)
      .toContain("path_expansion");
    // graph-target is reachable only via a second hop -> graph_expansion, and
    // the double-count guard keeps it off path_expansion.
    const graphTargetDiag = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "graph-target"
    );
    expect(graphTargetDiag?.admission_planes).toContain("graph_expansion");
    expect(graphTargetDiag?.admission_planes).not.toContain("path_expansion");
    expect(graphTargetDiag?.fused_rank_contribution_per_stream.graph_expansion).toBeGreaterThan(0.04);
  });

  it("excludes negative-bias paths from path_expansion positive candidates", async () => {
    // invariant: a negative path (recall_bias < 0) records suppression, so
    // its target is excluded from positive path_expansion candidates —
    // admitting it would amplify the suppressed memory.
    // see also: packages/core/src/recall/path-relations.ts:isPathExcludedFromRecall.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "path-target",
        content: "Path neighbor that the seed contradicts.",
        activation_score: 0.1,
        domain_tags: ["path"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    // anti-patterns-lint-allow: structurally-exact PathRelation fixture +
    // policy override mirror the sibling path_expansion test on purpose so
    // tsc validates the discriminated-union literals per case.
    const negativePathRelation: PathRelation = {
      path_id: "path-neg-1",
      workspace_id: "workspace-1",
      anchors: {
        source_anchor: { kind: "object", object_id: "seed-memory" },
        target_anchor: { kind: "object", object_id: "path-target" }
      },
      constitution: {
        relation_kind: "contradicts",
        why_this_relation_exists: ["test negative relation"]
      },
      effect_vector: {
        salience: 1,
        // negative recall_bias = recallBiasSign(-1) * magnitude(0.4)
        recall_bias: -0.4,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "lens_entry"
      },
      plasticity_state: {
        strength: 1,
        direction_bias: "source_to_target",
        stability_class: "stable",
        support_events_count: 1,
        contradiction_events_count: 0
      },
      lifecycle: {
        status: "active",
        retirement_rule: "manual"
      },
      legitimacy: {
        evidence_basis: ["test"],
        governance_class: "recall_allowed"
      },
      created_at: "2026-03-20T00:00:00.000Z",
      updated_at: "2026-03-20T00:00:00.000Z"
    };
    const pathExpansionPort: RecallServicePathExpansionPort = {
      findByAnchors: vi.fn(async () => [negativePathRelation])
    };
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 1
        },
        semantic_supplement: {
          enabled: false,
          max_supplement: 0
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
          max_entries: 3,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    // path-target must NOT be admitted through path_expansion off the
    // negative path. If it appears at all (e.g. via another plane), its
    // admission_planes must not include path_expansion.
    const pathTarget = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "path-target"
    );
    expect(pathTarget?.admission_planes ?? []).not.toContain("path_expansion");
  });

  it("excludes recall-neutral exception_to paths (recall_bias == 0) from path_expansion positive candidates", async () => {
    // invariant: the exception_to marker carries recall_bias exactly 0. It
    // is a topology marker, not a positive association — the strict-positive
    // isPathRecallEligible gate must keep it out of positive path_expansion
    // just like the negative families. Pre-fix the `< 0` test admitted it.
    // see also: packages/core/src/recall/path-relations.ts:isPathExcludedFromRecall.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "Deployment recall seed.",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "path-target",
        content: "Path neighbor reached via an exception_to marker.",
        activation_score: 0.1,
        domain_tags: ["path"]
      })
    ];
    const { dependencies } = createDependencies(memories);
    // anti-patterns-lint-allow: structurally-exact PathRelation fixture +
    // policy override mirror the sibling path_expansion tests on purpose so
    // tsc validates the discriminated-union literals per case.
    const neutralPathRelation: PathRelation = {
      path_id: "path-neutral-1",
      workspace_id: "workspace-1",
      anchors: {
        source_anchor: { kind: "object", object_id: "seed-memory" },
        target_anchor: { kind: "object", object_id: "path-target" }
      },
      constitution: {
        relation_kind: "exception_to",
        why_this_relation_exists: ["test neutral relation"]
      },
      effect_vector: {
        salience: 1,
        // recall-neutral marker: recallBiasSign(0) * magnitude(0) = 0
        recall_bias: 0,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "lens_entry"
      },
      plasticity_state: {
        strength: 1,
        direction_bias: "source_to_target",
        stability_class: "stable",
        support_events_count: 1,
        contradiction_events_count: 0
      },
      lifecycle: {
        status: "active",
        retirement_rule: "manual"
      },
      legitimacy: {
        evidence_basis: ["test"],
        governance_class: "recall_allowed"
      },
      created_at: "2026-03-20T00:00:00.000Z",
      updated_at: "2026-03-20T00:00:00.000Z"
    };
    const pathExpansionPort: RecallServicePathExpansionPort = {
      findByAnchors: vi.fn(async () => [neutralPathRelation])
    };
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 1
        },
        semantic_supplement: {
          enabled: false,
          max_supplement: 0
        }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1000,
          max_entries: 3,
          per_dimension_limits: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    const pathTarget = result.diagnostics?.candidates.find(
      (candidate) => candidate.object_id === "path-target"
    );
    expect(pathTarget?.admission_planes ?? []).not.toContain("path_expansion");
  });

  it("actively suppresses a target via a reinforced (high-strength) negative path", async () => {
    // A plasticity-reinforced contradiction (recall_bias < 0, strength near 1)
    // demotes its target's fused score below an otherwise-equivalent peer that
    // carries no negative path. Both targets are lexical hits, so the only
    // ranking difference is the active suppression delta.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "deployment rollback procedure overview",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "suppressed-target",
        content: "deployment rollback procedure detail one",
        activation_score: 0.5
      }),
      createMemoryEntry({
        object_id: "control-target",
        content: "deployment rollback procedure detail two",
        activation_score: 0.5
      })
    ];
    const { dependencies } = createDependencies(memories);
    const negativePath = createPathRelation({
      path_id: "path-neg-strong",
      sourceId: "seed-memory",
      targetId: "suppressed-target",
      relationKind: "contradicts",
      recallBias: -0.5,
      strength: 0.95
    });
    const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
      const ids = new Set(
        anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
      );
      return ids.has("seed-memory") ? [negativePath] : [];
    });
    const service = new RecallService({
      ...dependencies,
      pathExpansionPort: { findByAnchors }
    });
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: { enabled: false, max_supplement: 0 }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
      }
    });

    const result = await service.recall({
      taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail" },
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: policy
    });

    const suppressed = result.diagnostics?.candidates.find((c) => c.object_id === "suppressed-target");
    const control = result.diagnostics?.candidates.find((c) => c.object_id === "control-target");
    // The suppressed target must still be present (suppression demotes, it does
    // not remove), but it must rank strictly below the equivalent control.
    expect(suppressed).toBeDefined();
    expect(control).toBeDefined();
    expect(suppressed?.fused_score ?? 1).toBeLessThan(control?.fused_score ?? 0);
    expect(suppressed?.fused_rank ?? 0).toBeGreaterThan(control?.fused_rank ?? Number.MAX_SAFE_INTEGER);
  });

  it("does not let an attention_only negative path suppress even at high strength", async () => {
    // invariant: the governance gate (isPathGovernedForSuppression) blocks the
    // weaponizable suppression lane. strength is agent-pumpable through replayed
    // co-usage, so an attention_only negative seeded by agent-controllable
    // content must NOT demote a victim no matter how high strength climbs — only
    // recall_allowed / strictly_governed negatives reach the delta. Isolate by
    // recalling the same corpus twice (path wired vs not) and asserting the
    // target's fused score is identical.
    // see also: path-relation.ts isPathGovernedForSuppression.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "deployment rollback procedure overview",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "victim-target",
        content: "deployment rollback procedure detail one",
        activation_score: 0.5
      })
    ];
    const weaponizedNegativePath = createPathRelation({
      path_id: "path-neg-attention-pumped",
      sourceId: "seed-memory",
      targetId: "victim-target",
      relationKind: "contradicts",
      recallBias: -0.5,
      // Far above PATH_SUPPRESSION_STRENGTH_FLOOR: strength alone would license a
      // full delta if governance were not the gate.
      strength: 0.95,
      stabilityClass: "stable",
      // Agent-reachable band: must never actively suppress.
      governanceClass: "attention_only"
    });

    const runRecall = async (wirePath: boolean): Promise<number> => {
      const { dependencies } = createDependencies(memories);
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return wirePath && ids.has("seed-memory") ? [weaponizedNegativePath] : [];
      });
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const target = result.diagnostics?.candidates.find((c) => c.object_id === "victim-target");
      expect(target).toBeDefined();
      return target?.fused_score ?? -1;
    };

    const withAttentionNegative = await runRecall(true);
    const withoutPath = await runRecall(false);
    // Governance gate rejects the attention_only negative: identical fused score.
    expect(withAttentionNegative).toBeCloseTo(withoutPath, 10);
  });

  it("caps stacked recall_allowed negatives so ganging cannot deepen the demotion", async () => {
    // invariant: multiple converging governed negatives compound only up to one
    // reinforced-supersession delta (0.27). see also:
    // packages/core/src/recall/path-relations.ts:PATH_SUPPRESSION_MAX_PER_TARGET.
    // ganging extra negatives onto the same victim cannot push its fused score
    // any lower than a single negative already does. Isolate the cap by running
    // the same corpus with three converging negatives vs one negative: the
    // victim's fused score must be identical (the cap clamps the stack), and the
    // victim must remain delivered (suppression demotes, never removes from the
    // ranked set).
    const buildMemories = () => [
      createMemoryEntry({
        object_id: "seed-one",
        content: "deployment rollback procedure overview alpha",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "seed-two",
        content: "deployment rollback procedure overview beta",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "seed-three",
        content: "deployment rollback procedure overview gamma",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "victim-target",
        content: "deployment rollback procedure detail one",
        activation_score: 0.5
      })
    ];
    const allNegatives = ["seed-one", "seed-two", "seed-three"].map((seedId, index) =>
      createPathRelation({
        path_id: `path-neg-gang-${index}`,
        sourceId: seedId,
        targetId: "victim-target",
        relationKind: "supersedes",
        recallBias: -0.5,
        strength: 0.95,
        governanceClass: "recall_allowed"
      })
    );

    const runRecall = async (negatives: readonly PathRelation[]): Promise<{
      readonly delivered: boolean;
      readonly fusedScore: number;
    }> => {
      const { dependencies } = createDependencies(buildMemories());
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return negatives.filter((path) => {
          const source = path.anchors.source_anchor;
          return source.kind === "object" && ids.has(source.object_id);
        });
      });
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const victim = result.diagnostics?.candidates.find((c) => c.object_id === "victim-target");
      expect(victim).toBeDefined();
      return {
        delivered: result.candidates.some((candidate) => candidate.object_id === "victim-target"),
        fusedScore: victim?.fused_score ?? -1
      };
    };

    const single = await runRecall([allNegatives[0]!]);
    const ganged = await runRecall(allNegatives);
    // The cap clamps the stack to one delta: three converging negatives demote
    // the victim no more than one does.
    expect(ganged.fusedScore).toBeCloseTo(single.fusedScore, 10);
    // Suppression demotes, never removes: the victim is still delivered.
    expect(single.delivered).toBe(true);
    expect(ganged.delivered).toBe(true);
  });

  it("demotes a low-base victim to a floor residual without erasing it from the candidate set", async () => {
    // invariant: PATH_SUPPRESSION_RESIDUAL_FLOOR. A single full-strength
    // recall_allowed negative produces a delta (~0.27) that exceeds a low-base
    // victim's fused_score. Without the residual floor the subtraction would
    // drive the victim to 0 and drop it out of the candidate set (erasure).
    // The floor keeps a positive pre-suppression candidate present as a tail
    // candidate: still ranked, fused_score > 0, but strictly demoted below its
    // no-path baseline. see also: packages/core/src/recall/fusion-delivery.ts:applyPathSuppressionToFusionScores.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "deployment rollback procedure overview alpha beta gamma",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "low-base-victim",
        // Minimal lexical overlap with the query so its fused_score lands below
        // the single-negative cap delta.
        content: "rollback note",
        activation_score: 0.1
      })
    ];
    const negativePath = createPathRelation({
      path_id: "path-neg-low-base",
      sourceId: "seed-memory",
      targetId: "low-base-victim",
      relationKind: "supersedes",
      recallBias: -0.5,
      strength: 0.95,
      governanceClass: "recall_allowed"
    });

    const runRecall = async (wirePath: boolean): Promise<{
      readonly fusedScore: number;
      readonly present: boolean;
    }> => {
      const { dependencies } = createDependencies(memories);
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return wirePath && ids.has("seed-memory") ? [negativePath] : [];
      });
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: { enabled: false, max_supplement: 0 }
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure overview" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const victim = result.diagnostics?.candidates.find((c) => c.object_id === "low-base-victim");
      return {
        fusedScore: victim?.fused_score ?? -1,
        present: victim !== undefined
      };
    };

    const baseline = await runRecall(false);
    const suppressed = await runRecall(true);
    // Baseline below the cap delta: the subtraction alone would reach 0.
    expect(baseline.fusedScore).toBeGreaterThan(0);
    expect(baseline.fusedScore).toBeLessThan(0.27);
    // Suppressed: still a candidate, demoted below baseline, but floored above 0.
    expect(suppressed.present).toBe(true);
    expect(suppressed.fusedScore).toBeGreaterThan(0);
    expect(suppressed.fusedScore).toBeLessThan(baseline.fusedScore);
  });

  it("does not let a weak attention_only negative path move rankings", async () => {
    // A barely-formed negative association (strength below the suppression
    // floor) contributes zero delta. Isolate the effect by recalling the same
    // corpus twice — once with the weak negative path wired and once without —
    // and asserting the target's fused score is identical. invariant:
    // PATH_SUPPRESSION_STRENGTH_FLOOR. Comparing two runs of the same memory
    // (rather than two sibling memories) removes object-id-ordering noise.
    const memories = [
      createMemoryEntry({
        object_id: "seed-memory",
        content: "deployment rollback procedure overview",
        activation_score: 0.9
      }),
      createMemoryEntry({
        object_id: "weak-target",
        content: "deployment rollback procedure detail one",
        activation_score: 0.5
      })
    ];
    const weakNegativePath = createPathRelation({
      path_id: "path-neg-weak",
      sourceId: "seed-memory",
      targetId: "weak-target",
      relationKind: "contradicts",
      recallBias: -0.4,
      // attention_only co-occurrence band: below PATH_SUPPRESSION_STRENGTH_FLOOR.
      strength: 0.5,
      stabilityClass: "volatile",
      governanceClass: "attention_only"
    });
    const basePolicyPatch = {
      coarse_filter_semantic: { enabled: false, max_supplement: 0 }
    } as const;

    const runRecall = async (wirePath: boolean): Promise<number> => {
      const { dependencies } = createDependencies(memories);
      const findByAnchors = vi.fn(async (_workspaceId: string, anchorRefs: readonly PathAnchorRef[]) => {
        const ids = new Set(
          anchorRefs.flatMap((ref) => (ref.kind === "object" ? [ref.object_id] : []))
        );
        return wirePath && ids.has("seed-memory") ? [weakNegativePath] : [];
      });
      const service = new RecallService({
        ...dependencies,
        pathExpansionPort: { findByAnchors }
      });
      const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
      const policy = overridePolicy(basePolicy, {
        coarse_filter: {
          ...basePolicy.coarse_filter,
          semantic_supplement: basePolicyPatch.coarse_filter_semantic
        },
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_total_tokens: 4000, max_entries: 5, per_dimension_limits: null }
        }
      });
      const result = await service.recall({
        taskSurface: { ...createTaskSurface(), display_name: "deployment rollback procedure detail" },
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const target = result.diagnostics?.candidates.find((c) => c.object_id === "weak-target");
      expect(target).toBeDefined();
      return target?.fused_score ?? -1;
    };

    const withWeakPath = await runRecall(true);
    const withoutPath = await runRecall(false);
    // The weak negative path is below the strength floor, so it applies no
    // suppression: the target's fused score is unchanged versus the no-path run.
    expect(withWeakPath).toBeCloseTo(withoutPath, 10);
  });
});
