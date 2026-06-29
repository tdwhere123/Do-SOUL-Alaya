import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PathAnchorRef, type PathRelation } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { createDependencies, createMemoryEntry, createPathRelation, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

describe("RecallService", () => {
  // Path-suppression budget arithmetic asserts the flat fusion ordering (retained under the kill-switch).
  beforeEach(() => { process.env.ALAYA_RECALL_FLAT_BASELINE = "1"; });
  afterEach(() => { delete process.env.ALAYA_RECALL_FLAT_BASELINE; });
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
