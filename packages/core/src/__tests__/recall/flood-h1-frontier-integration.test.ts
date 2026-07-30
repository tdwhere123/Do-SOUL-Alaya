import { describe, expect, it, vi } from "vitest";
import type { PathAnchorRef } from "@do-soul/alaya-protocol";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../config/index.js";
import { RecallService } from "../../recall/recall-service.js";
import type { RecallServicePathExpansionPort } from
  "../../recall/runtime/recall-service-types.js";
import {
  createDependencies,
  createMemoryEntry,
  createPathRelation,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

describe("H=1 bounded frontier integration", () => {
  it("transfers into a target admitted after the initial candidate cap", async () => {
    const seed = createMemoryEntry({
      object_id: "frontier-seed",
      content: "Deployment recall seed.",
      domain_tags: ["frontier-seed-only"],
      activation_score: 0.9
    });
    const target = createMemoryEntry({
      object_id: "frontier-target",
      content: "Answer reachable only through the path frontier.",
      domain_tags: ["frontier-target-only"],
      run_id: "frontier-target-run",
      activation_score: 0.1
    });
    const relation = createPathRelation({
      path_id: "frontier-answers-with",
      sourceId: seed.object_id,
      targetId: target.object_id,
      relationKind: "answers_with",
      strength: 1
    });
    const findByAnchors = vi.fn(async (
      _workspaceId: string,
      anchors: readonly PathAnchorRef[]
    ) => anchors.some((anchor) =>
      anchor.kind === "object" && (
        anchor.object_id === seed.object_id ||
        anchor.object_id === target.object_id
      )
    ) ? [relation] : []);
    const pathExpansionPort: RecallServicePathExpansionPort = { findByAnchors };
    const { dependencies } = createDependencies([seed, target]);
    const service = new RecallService({ ...dependencies, pathExpansionPort });
    const basePolicy = service.buildDefaultPolicy(
      "analyze",
      createTaskSurface().runtime_id
    );
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          max_candidates: 1
        },
        semantic_supplement: { enabled: false, max_supplement: 0 }
      },
      fine_assessment: {
        ...basePolicy.fine_assessment,
        budgets: {
          max_total_tokens: 1_000,
          max_entries: 2,
          per_dimension_limits: null
        }
      }
    });

    installCoreConfigFromProcessEnv({
      ALAYA_RECALL_CONF_H1_MAX_PRODUCT: "on"
    });
    try {
      const result = await service.recall({
        taskSurface: createTaskSurface(),
        workspaceId: "workspace-1",
        strategy: "analyze",
        policyOverride: policy
      });
      const diagnostic = result.diagnostics?.candidates.find(
        (candidate) => candidate.object_id === target.object_id
      );

      expect(diagnostic?.admission_planes).toContain("graph_expansion");
      expect(diagnostic?.flood_potential).toMatchObject({
        score_mode: "rrf_seeded_h1_max_product",
        path_status: "active",
        h1_max_product: {
          strongest_transfer: expect.any(Number),
          frontier_admitted: true,
          transition_counts: {
            evaluated_edge_count: 1,
            seed_overlap_edge_count: 1,
            transferred_edge_count: 1,
            rejected_edge_count: 0
          }
        },
        edge_traces: [
          expect.objectContaining({ path_id: relation.path_id })
        ]
      });
      expect(diagnostic?.flood_potential?.h1_max_product?.strongest_transfer)
        .toBeGreaterThan(0);
      expect(diagnostic?.flood_fuel_coverage?.h1_transferable_count)
        .toBeGreaterThan(0);
      expect(
        diagnostic?.flood_fuel_coverage
          ?.h1_newly_admitted_frontier_target_count
      ).toBe(1);
    } finally {
      resetCoreConfigForTests();
    }
  });
});
