import { describe, expect, it } from "vitest";
import {
  ManifestationLevel,
  PathGovernanceClass,
  StabilityClass,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  GOVERNANCE_PROMOTION_THRESHOLDS,
  STABILITY_PROMOTION_THRESHOLDS,
  clampLevelByGovernance,
  evolveGovernanceClass,
  evolveStabilityClass,
  governanceAuthorisesLevel,
  manifestationAuthorityFor,
  planPromotion
} from "../../path-graph/path-relations/path-manifestation-policy.js";

describe("path-manifestation-policy authority matrix", () => {
  it("hint_only authorises no manifestation levels", () => {
    const authority = manifestationAuthorityFor(PathGovernanceClass.HINT_ONLY);
    expect(authority.authorised_levels).toEqual([]);
    expect(
      governanceAuthorisesLevel(PathGovernanceClass.HINT_ONLY, ManifestationLevel.LENS_ENTRY)
    ).toBe(false);
    expect(
      governanceAuthorisesLevel(PathGovernanceClass.HINT_ONLY, ManifestationLevel.DIALOGUE_NUDGE)
    ).toBe(false);
    expect(
      governanceAuthorisesLevel(PathGovernanceClass.HINT_ONLY, ManifestationLevel.STANCE_BIAS)
    ).toBe(false);
  });

  it("attention_only authorises only lens_entry", () => {
    const authority = manifestationAuthorityFor(PathGovernanceClass.ATTENTION_ONLY);
    expect(authority.authorised_levels).toEqual([ManifestationLevel.LENS_ENTRY]);
    expect(
      governanceAuthorisesLevel(PathGovernanceClass.ATTENTION_ONLY, ManifestationLevel.LENS_ENTRY)
    ).toBe(true);
    expect(
      governanceAuthorisesLevel(
        PathGovernanceClass.ATTENTION_ONLY,
        ManifestationLevel.DIALOGUE_NUDGE
      )
    ).toBe(false);
    expect(
      governanceAuthorisesLevel(PathGovernanceClass.ATTENTION_ONLY, ManifestationLevel.STANCE_BIAS)
    ).toBe(false);
  });

  it("recall_allowed authorises lens_entry and dialogue_nudge", () => {
    const authority = manifestationAuthorityFor(PathGovernanceClass.RECALL_ALLOWED);
    expect(authority.authorised_levels).toEqual(
      expect.arrayContaining([ManifestationLevel.LENS_ENTRY, ManifestationLevel.DIALOGUE_NUDGE])
    );
    expect(authority.authorised_levels).toHaveLength(2);
    expect(
      governanceAuthorisesLevel(PathGovernanceClass.RECALL_ALLOWED, ManifestationLevel.STANCE_BIAS)
    ).toBe(false);
  });

  it("strictly_governed authorises all three including stance_bias", () => {
    const authority = manifestationAuthorityFor(PathGovernanceClass.STRICTLY_GOVERNED);
    expect(authority.authorised_levels).toEqual(
      expect.arrayContaining([
        ManifestationLevel.LENS_ENTRY,
        ManifestationLevel.DIALOGUE_NUDGE,
        ManifestationLevel.STANCE_BIAS
      ])
    );
    expect(authority.authorised_levels).toHaveLength(3);
    expect(
      governanceAuthorisesLevel(
        PathGovernanceClass.STRICTLY_GOVERNED,
        ManifestationLevel.STANCE_BIAS
      )
    ).toBe(true);
  });
});

describe("clampLevelByGovernance", () => {
  const lensFallback = [
    ManifestationLevel.LENS_ENTRY,
    ManifestationLevel.DIALOGUE_NUDGE,
    ManifestationLevel.STANCE_BIAS
  ] as const;

  it("returns null when governance authorises nothing", () => {
    expect(
      clampLevelByGovernance(
        ManifestationLevel.LENS_ENTRY,
        PathGovernanceClass.HINT_ONLY,
        lensFallback
      )
    ).toBeNull();
  });

  it("returns the desired level when governance authorises it", () => {
    expect(
      clampLevelByGovernance(
        ManifestationLevel.LENS_ENTRY,
        PathGovernanceClass.ATTENTION_ONLY,
        lensFallback
      )
    ).toBe(ManifestationLevel.LENS_ENTRY);
    expect(
      clampLevelByGovernance(
        ManifestationLevel.DIALOGUE_NUDGE,
        PathGovernanceClass.RECALL_ALLOWED,
        [ManifestationLevel.DIALOGUE_NUDGE, ManifestationLevel.STANCE_BIAS]
      )
    ).toBe(ManifestationLevel.DIALOGUE_NUDGE);
  });

  it("returns null when desired and all weaker levels are unauthorised", () => {
    expect(
      clampLevelByGovernance(
        ManifestationLevel.STANCE_BIAS,
        PathGovernanceClass.ATTENTION_ONLY,
        [ManifestationLevel.STANCE_BIAS]
      )
    ).toBeNull();
  });
});

describe("evolveStabilityClass", () => {
  it("promotes volatile to normal once support reaches threshold", () => {
    const next = evolveStabilityClass({
      current: StabilityClass.VOLATILE,
      governance_class: PathGovernanceClass.HINT_ONLY,
      support_exposure_count: STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count
    });
    expect(next).toBe(StabilityClass.NORMAL);
  });

  it("keeps volatile when support is below threshold", () => {
    const next = evolveStabilityClass({
      current: StabilityClass.VOLATILE,
      governance_class: PathGovernanceClass.STRICTLY_GOVERNED,
      support_exposure_count: STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count - 1
    });
    expect(next).toBe(StabilityClass.VOLATILE);
  });

  it("promotes normal to stable once support reaches threshold", () => {
    const next = evolveStabilityClass({
      current: StabilityClass.NORMAL,
      governance_class: PathGovernanceClass.RECALL_ALLOWED,
      support_exposure_count: STABILITY_PROMOTION_THRESHOLDS.normal_to_stable_support_count
    });
    expect(next).toBe(StabilityClass.STABLE);
  });

  it("walks volatile through normal up to stable in a single evaluation when support is high", () => {
    const next = evolveStabilityClass({
      current: StabilityClass.VOLATILE,
      governance_class: PathGovernanceClass.RECALL_ALLOWED,
      support_exposure_count: STABILITY_PROMOTION_THRESHOLDS.normal_to_stable_support_count
    });
    expect(next).toBe(StabilityClass.STABLE);
  });

  it("promotes stable to pinned only when governance is strictly_governed", () => {
    expect(
      evolveStabilityClass({
        current: StabilityClass.STABLE,
        governance_class: PathGovernanceClass.STRICTLY_GOVERNED,
        support_exposure_count: 999
      })
    ).toBe(StabilityClass.PINNED);
    expect(
      evolveStabilityClass({
        current: StabilityClass.STABLE,
        governance_class: PathGovernanceClass.RECALL_ALLOWED,
        support_exposure_count: 999
      })
    ).toBe(StabilityClass.STABLE);
  });
});

describe("evolveGovernanceClass promotion ladder", () => {
  it("promotes hint_only to attention_only after support reaches threshold with zero contradictions", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.HINT_ONLY,
      support_exposure_count: GOVERNANCE_PROMOTION_THRESHOLDS.hint_to_attention_support_count,
      contradiction_events_count: 0
    });
    expect(next).toBe(PathGovernanceClass.ATTENTION_ONLY);
  });

  it("holds hint_only when any contradiction is present", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.HINT_ONLY,
      support_exposure_count: GOVERNANCE_PROMOTION_THRESHOLDS.hint_to_attention_support_count,
      contradiction_events_count: 1
    });
    expect(next).toBe(PathGovernanceClass.HINT_ONLY);
  });

  it("promotes attention_only to recall_allowed after support reaches threshold", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.ATTENTION_ONLY,
      support_exposure_count: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      contradiction_events_count: 0
    });
    expect(next).toBe(PathGovernanceClass.RECALL_ALLOWED);
  });

  it("walks hint_only straight to recall_allowed when support is past the second threshold", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.HINT_ONLY,
      support_exposure_count: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      contradiction_events_count: 0
    });
    expect(next).toBe(PathGovernanceClass.RECALL_ALLOWED);
  });

  it("never auto-promotes recall_allowed beyond recall_allowed", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.RECALL_ALLOWED,
      support_exposure_count: 999,
      contradiction_events_count: 0
    });
    expect(next).toBe(PathGovernanceClass.RECALL_ALLOWED);
  });

  it("leaves strictly_governed unchanged regardless of support / contradictions", () => {
    expect(
      evolveGovernanceClass({
        current: PathGovernanceClass.STRICTLY_GOVERNED,
        support_exposure_count: 999,
        contradiction_events_count: 0
      })
    ).toBe(PathGovernanceClass.STRICTLY_GOVERNED);
    expect(
      evolveGovernanceClass({
        current: PathGovernanceClass.STRICTLY_GOVERNED,
        support_exposure_count: 0,
        contradiction_events_count: 99
      })
    ).toBe(PathGovernanceClass.STRICTLY_GOVERNED);
  });
});

describe("planPromotion", () => {
  function createSeedPath(overrides: Partial<PathRelation> = {}): PathRelation {
    return {
      path_id: "path-seed",
      workspace_id: "workspace-1",
      anchors: {
        source_anchor: { kind: "object", object_id: "obj-source" },
        target_anchor: { kind: "object", object_id: "obj-target" }
      },
      constitution: {
        relation_kind: "supports",
        why_this_relation_exists: ["seed"]
      },
      effect_vector: {
        salience: 0.5,
        recall_bias: 0,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      plasticity_state: {
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.VOLATILE,
        support_events_count: 0,
        contradiction_events_count: 0
      },
      lifecycle: { retirement_rule: "default" },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.HINT_ONLY
      },
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      ...overrides
    } as PathRelation;
  }

  it("returns a governance promotion step when the path crosses the hint_to_attention threshold cleanly", () => {
    const plan = planPromotion({
      path: createSeedPath(),
      nextSupportEventsCount: GOVERNANCE_PROMOTION_THRESHOLDS.hint_to_attention_support_count,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: GOVERNANCE_PROMOTION_THRESHOLDS.hint_to_attention_support_count,
      nextContradictionExposureCount: 0
    });
    expect(plan.governance).not.toBeNull();
    expect(plan.governance?.kind).toBe("governance_promotion");
    expect(plan.governance?.previous).toBe(PathGovernanceClass.HINT_ONLY);
    expect(plan.governance?.next).toBe(PathGovernanceClass.ATTENTION_ONLY);
  });

  it("returns a stability promotion step when support count crosses the volatile_to_normal threshold", () => {
    const plan = planPromotion({
      path: createSeedPath(),
      nextSupportEventsCount: STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count,
      nextContradictionExposureCount: 0
    });
    expect(plan.stability).not.toBeNull();
    expect(plan.stability?.kind).toBe("stability_promotion");
    expect(plan.stability?.previous).toBe(StabilityClass.VOLATILE);
    expect(plan.stability?.next).toBe(StabilityClass.NORMAL);
  });

  it("returns null steps when nothing crosses a threshold", () => {
    const plan = planPromotion({
      path: createSeedPath({
        plasticity_state: {
          strength: 0.5,
          direction_bias: "source_to_target",
          stability_class: StabilityClass.NORMAL,
          support_events_count: 2,
          contradiction_events_count: 0
        },
        legitimacy: {
          evidence_basis: ["evidence-1"],
          governance_class: PathGovernanceClass.RECALL_ALLOWED
        }
      }),
      nextSupportEventsCount: 2,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: 2,
      nextContradictionExposureCount: 0
    });
    expect(plan.stability).toBeNull();
    expect(plan.governance).toBeNull();
  });

  it("withholds governance promotion when any contradiction is reported", () => {
    const plan = planPromotion({
      path: createSeedPath(),
      nextSupportEventsCount: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      nextContradictionEventsCount: 1,
      nextSupportExposureCount: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      nextContradictionExposureCount: 1
    });
    expect(plan.governance).toBeNull();
  });

  it("only emits the pinned stability promotion when governance also reaches strictly_governed", () => {
    const planNonStrict = planPromotion({
      path: createSeedPath({
        plasticity_state: {
          strength: 0.9,
          direction_bias: "source_to_target",
          stability_class: StabilityClass.STABLE,
          support_events_count: 99,
          contradiction_events_count: 0
        },
        legitimacy: {
          evidence_basis: ["evidence-1"],
          governance_class: PathGovernanceClass.RECALL_ALLOWED
        }
      }),
      nextSupportEventsCount: 99,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: 99,
      nextContradictionExposureCount: 0
    });
    expect(planNonStrict.stability).toBeNull();

    const planStrict = planPromotion({
      path: createSeedPath({
        plasticity_state: {
          strength: 0.9,
          direction_bias: "source_to_target",
          stability_class: StabilityClass.STABLE,
          support_events_count: 99,
          contradiction_events_count: 0
        },
        legitimacy: {
          evidence_basis: ["evidence-1"],
          governance_class: PathGovernanceClass.STRICTLY_GOVERNED
        }
      }),
      nextSupportEventsCount: 99,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: 99,
      nextContradictionExposureCount: 0
    });
    expect(planStrict.stability).not.toBeNull();
    expect(planStrict.stability?.next).toBe(StabilityClass.PINNED);
  });

  it("withholds governance promotion for a negative path (recall_bias < 0) even at the attention_to_recall threshold with zero contradictions", () => {
    const plan = planPromotion({
      path: createSeedPath({
        constitution: {
          relation_kind: "supersedes",
          why_this_relation_exists: ["seed"]
        },
        effect_vector: {
          salience: 0.5,
          recall_bias: -0.5,
          verification_bias: 0,
          unfinishedness_bias: 0,
          default_manifestation_preference: "stance_bias"
        },
        plasticity_state: {
          strength: 0.9,
          direction_bias: "source_to_target",
          stability_class: StabilityClass.VOLATILE,
          support_events_count: 0,
          contradiction_events_count: 0
        },
        legitimacy: {
          evidence_basis: ["evidence-1"],
          governance_class: PathGovernanceClass.ATTENTION_ONLY
        }
      }),
      nextSupportEventsCount: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      nextContradictionExposureCount: 0
    });
    expect(plan.governance).toBeNull();
  });

  it("still evolves stability for a negative path while withholding governance promotion", () => {
    const plan = planPromotion({
      path: createSeedPath({
        constitution: {
          relation_kind: "supersedes",
          why_this_relation_exists: ["seed"]
        },
        effect_vector: {
          salience: 0.5,
          recall_bias: -0.5,
          verification_bias: 0,
          unfinishedness_bias: 0,
          default_manifestation_preference: "stance_bias"
        },
        plasticity_state: {
          strength: 0.9,
          direction_bias: "source_to_target",
          stability_class: StabilityClass.VOLATILE,
          support_events_count: 0,
          contradiction_events_count: 0
        },
        legitimacy: {
          evidence_basis: ["evidence-1"],
          governance_class: PathGovernanceClass.ATTENTION_ONLY
        }
      }),
      nextSupportEventsCount: STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count,
      nextContradictionExposureCount: 0
    });
    expect(plan.governance).toBeNull();
    expect(plan.stability).not.toBeNull();
    expect(plan.stability?.next).toBe(StabilityClass.NORMAL);
  });

  it("still promotes governance for a positive path (recall_bias > 0) at the same threshold", () => {
    const plan = planPromotion({
      path: createSeedPath({
        effect_vector: {
          salience: 0.5,
          recall_bias: 0.5,
          verification_bias: 0,
          unfinishedness_bias: 0,
          default_manifestation_preference: "stance_bias"
        },
        legitimacy: {
          evidence_basis: ["evidence-1"],
          governance_class: PathGovernanceClass.ATTENTION_ONLY
        }
      }),
      nextSupportEventsCount: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      nextContradictionExposureCount: 0
    });
    expect(plan.governance).not.toBeNull();
    expect(plan.governance?.previous).toBe(PathGovernanceClass.ATTENTION_ONLY);
    expect(plan.governance?.next).toBe(PathGovernanceClass.RECALL_ALLOWED);
  });

  it("uses support exposure rather than raw support count for promotions", () => {
    const plan = planPromotion({
      path: createSeedPath({
        legitimacy: {
          evidence_basis: ["evidence-1"],
          governance_class: PathGovernanceClass.ATTENTION_ONLY
        },
        plasticity_state: {
          strength: 0.5,
          direction_bias: "source_to_target",
          stability_class: StabilityClass.NORMAL,
          support_events_count: 7,
          contradiction_events_count: 0
        }
      }),
      nextSupportEventsCount: 8,
      nextContradictionEventsCount: 0,
      nextSupportExposureCount: 7.5,
      nextContradictionExposureCount: 0
    });
    expect(plan.governance).toBeNull();
    expect(plan.stability).toBeNull();
  });
});
