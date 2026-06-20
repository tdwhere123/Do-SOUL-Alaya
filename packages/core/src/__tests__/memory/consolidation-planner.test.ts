import { describe, expect, it } from "vitest";
import { DYNAMICS_CONSTANTS, type PathRelation } from "@do-soul/alaya-protocol";
import {
  __pickEvidenceRichestSurvivorForTests,
  ConsolidationPlanner,
  type ConsolidationPlannerPathRelationPort
} from "../../memory/consolidation-planner.js";

const NOW_ISO = "2026-05-20T12:00:00.000Z";
const WORKSPACE_ID = "workspace-1";
const DORMANT_AGE_MS = DYNAMICS_CONSTANTS.path_plasticity.consolidation_dormant_age_ms;

function createDormantPath(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: WORKSPACE_ID,
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

interface PlannerHarness {
  readonly planner: ConsolidationPlanner;
  readonly findDormantCalls: { workspaceId: string; olderThanIso: string }[];
}

function buildPlanner(dormantPaths: readonly PathRelation[]): PlannerHarness {
  const findDormantCalls: { workspaceId: string; olderThanIso: string }[] = [];
  const pathRelationRepo: ConsolidationPlannerPathRelationPort = {
    findDormantAll: async (workspaceId: string, olderThanIso: string) => {
      findDormantCalls.push({ workspaceId, olderThanIso });
      return dormantPaths;
    }
  };
  const planner = new ConsolidationPlanner({
    pathRelationRepo,
    now: () => NOW_ISO
  });
  return { planner, findDormantCalls };
}

describe("ConsolidationPlanner", () => {
  it("emits a merge for a dormant cluster sharing relation_kind and anchors", async () => {
    const survivor = createDormantPath({
      path_id: "path-survivor",
      legitimacy: { evidence_basis: ["ev-1", "ev-2"], governance_class: "recall_allowed" }
    });
    const loser = createDormantPath({
      path_id: "path-loser",
      legitimacy: { evidence_basis: ["ev-3"], governance_class: "recall_allowed" }
    });
    const { planner } = buildPlanner([survivor, loser]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    expect(plan.workspace_id).toBe(WORKSPACE_ID);
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges?.[0]?.survivor_path_id).toBe("path-survivor");
    expect(plan.merges?.[0]?.merged_path_ids).toEqual(["path-loser"]);
    // Consolidation only touches the merge lane; the other sections stay empty.
    expect(plan.promotions).toEqual([]);
    expect(plan.retirements).toEqual([]);
    expect(plan.fuse_state.blown).toBe(false);
  });

  it("derives the dormant-age threshold from DYNAMICS_CONSTANTS, not a literal", async () => {
    const { planner, findDormantCalls } = buildPlanner([]);

    await planner.planCycle(WORKSPACE_ID);

    expect(findDormantCalls).toHaveLength(1);
    const expectedOlderThan = new Date(Date.parse(NOW_ISO) - DORMANT_AGE_MS).toISOString();
    expect(findDormantCalls[0]?.olderThanIso).toBe(expectedOlderThan);
    expect(findDormantCalls[0]?.workspaceId).toBe(WORKSPACE_ID);
  });

  it("chooses the evidence-richest path as the merge survivor", async () => {
    const poor = createDormantPath({
      path_id: "path-poor",
      legitimacy: { evidence_basis: ["ev-1"], governance_class: "recall_allowed" }
    });
    const rich = createDormantPath({
      path_id: "path-rich",
      // evidence_basis length 3 is the richest — but 2+ also classifies as
      // "keep", so this also exercises that a keep path can be the survivor.
      legitimacy: {
        evidence_basis: ["ev-1", "ev-2", "ev-3"],
        governance_class: "recall_allowed"
      }
    });
    const { planner } = buildPlanner([poor, rich]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    expect(plan.merges).toHaveLength(1);
    expect(plan.merges?.[0]?.survivor_path_id).toBe("path-rich");
    // The poor (single-evidence, mergeable) path is the deletable loser.
    expect(plan.merges?.[0]?.merged_path_ids).toEqual(["path-poor"]);
  });

  it("fails explicitly when survivor selection receives an empty candidate set", () => {
    expect(() => __pickEvidenceRichestSurvivorForTests([])).toThrow(
      /requires at least one survivor-eligible candidate/u
    );
  });

  it("never merges or deletes an override-pinned path", async () => {
    const pinned = createDormantPath({
      path_id: "path-pinned",
      lifecycle: {
        status: "dormant",
        retirement_rule: "retire_after_cooldown",
        override_rule: "operator_pin"
      },
      legitimacy: { evidence_basis: ["ev-1"], governance_class: "recall_allowed" }
    });
    const ordinary = createDormantPath({
      path_id: "path-ordinary",
      legitimacy: { evidence_basis: ["ev-2"], governance_class: "recall_allowed" }
    });
    const { planner } = buildPlanner([pinned, ordinary]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    // Only one survivor-eligible member remains after dropping the pinned path,
    // so no merge fires; the pinned path is never a survivor nor a loser.
    expect(plan.merges).toEqual([]);
  });

  it("never merges or deletes a strictly_governed path (report-only)", async () => {
    const governed = createDormantPath({
      path_id: "path-governed",
      legitimacy: { evidence_basis: ["ev-1"], governance_class: "strictly_governed" }
    });
    const ordinary = createDormantPath({
      path_id: "path-ordinary",
      legitimacy: { evidence_basis: ["ev-2"], governance_class: "recall_allowed" }
    });
    const { planner } = buildPlanner([governed, ordinary]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    expect(plan.merges).toEqual([]);
  });

  it("keeps an evidence_basis>=2 path: it may survive but is never a deleted loser", async () => {
    // Two evidence-rich (keep) paths plus one bare mergeable. The richest keep
    // path survives; the other keep path must NOT be deleted — only the bare
    // mergeable path is a loser.
    const keepRichest = createDormantPath({
      path_id: "path-keep-richest",
      legitimacy: {
        evidence_basis: ["ev-1", "ev-2", "ev-3"],
        governance_class: "recall_allowed"
      }
    });
    const keepOther = createDormantPath({
      path_id: "path-keep-other",
      legitimacy: { evidence_basis: ["ev-4", "ev-5"], governance_class: "recall_allowed" }
    });
    const bareMergeable = createDormantPath({
      path_id: "path-mergeable",
      legitimacy: { evidence_basis: ["ev-6"], governance_class: "recall_allowed" }
    });
    const { planner } = buildPlanner([keepRichest, keepOther, bareMergeable]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    expect(plan.merges).toHaveLength(1);
    expect(plan.merges?.[0]?.survivor_path_id).toBe("path-keep-richest");
    // keepOther (evidence>=2 => keep) is never a loser; only the bare path is.
    expect(plan.merges?.[0]?.merged_path_ids).toEqual(["path-mergeable"]);
  });

  it("does not merge paths in different clusters (relation_kind / anchors differ)", async () => {
    const relA = createDormantPath({
      path_id: "path-rel-a",
      constitution: { relation_kind: "supports", why_this_relation_exists: ["why-a"] }
    });
    const relB = createDormantPath({
      path_id: "path-rel-b",
      constitution: { relation_kind: "derives_from", why_this_relation_exists: ["why-b"] }
    });
    const diffAnchors = createDormantPath({
      path_id: "path-diff-anchors",
      anchors: {
        source_anchor: { kind: "object", object_id: "obj-x" },
        target_anchor: { kind: "object", object_id: "obj-y" }
      }
    });
    const { planner } = buildPlanner([relA, relB, diffAnchors]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    // Three singleton clusters: each below the min cluster size, no merge.
    expect(plan.merges).toEqual([]);
  });

  it("clusters direction-flipped anchor pairs of the same relation together", async () => {
    const forward = createDormantPath({
      path_id: "path-forward",
      anchors: {
        source_anchor: { kind: "object", object_id: "obj-a" },
        target_anchor: { kind: "object", object_id: "obj-b" }
      },
      legitimacy: { evidence_basis: ["ev-1", "ev-2"], governance_class: "recall_allowed" }
    });
    const reverse = createDormantPath({
      path_id: "path-reverse",
      anchors: {
        source_anchor: { kind: "object", object_id: "obj-b" },
        target_anchor: { kind: "object", object_id: "obj-a" }
      },
      legitimacy: { evidence_basis: ["ev-3"], governance_class: "recall_allowed" }
    });
    const { planner } = buildPlanner([forward, reverse]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    expect(plan.merges).toHaveLength(1);
    expect(plan.merges?.[0]?.survivor_path_id).toBe("path-forward");
    expect(plan.merges?.[0]?.merged_path_ids).toEqual(["path-reverse"]);
  });

  it("emits no merge when there is nothing dormant", async () => {
    const { planner } = buildPlanner([]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    expect(plan.merges).toEqual([]);
  });

  it("never co-clusters opposite recall_bias-sign paths of the same relation_kind and anchors", async () => {
    // Belt-and-suspenders: a positive (amplifying) and a negative (suppressing)
    // path over the same relation_kind + anchors must land in different clusters
    // by recall_bias sign, so they can never merge into one survivor.
    const positive = createDormantPath({
      path_id: "path-positive",
      effect_vector: {
        salience: 0,
        recall_bias: 0.5,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      }
    });
    const negative = createDormantPath({
      path_id: "path-negative",
      effect_vector: {
        salience: 0,
        recall_bias: -0.5,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      }
    });
    const { planner } = buildPlanner([positive, negative]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    // Two singleton clusters split by sign: each below the min cluster size.
    expect(plan.merges).toEqual([]);
  });

  it("clusters same-sign paths of the same relation_kind and anchors together", async () => {
    const negativeRich = createDormantPath({
      path_id: "path-negative-rich",
      effect_vector: {
        salience: 0,
        recall_bias: -0.5,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      legitimacy: { evidence_basis: ["ev-1", "ev-2"], governance_class: "recall_allowed" }
    });
    const negativeBare = createDormantPath({
      path_id: "path-negative-bare",
      effect_vector: {
        salience: 0,
        recall_bias: -0.3,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      legitimacy: { evidence_basis: ["ev-3"], governance_class: "recall_allowed" }
    });
    const { planner } = buildPlanner([negativeRich, negativeBare]);

    const plan = await planner.planCycle(WORKSPACE_ID);

    expect(plan.merges).toHaveLength(1);
    expect(plan.merges?.[0]?.survivor_path_id).toBe("path-negative-rich");
    expect(plan.merges?.[0]?.merged_path_ids).toEqual(["path-negative-bare"]);
  });
});
