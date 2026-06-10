import { describe, expect, it } from "vitest";
import {
  ManifestationLevel,
  ManifestationState,
  PathGovernanceClass,
  StabilityClass,
  type ManifestationState as ManifestationStateValue,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  GOVERNANCE_CEILING_FAILSAFE_BAND,
  GOVERNANCE_PROMOTION_THRESHOLDS,
  STABILITY_PROMOTION_THRESHOLDS,
  clampLevelByGovernance,
  clampManifestationByGovernance,
  evolveGovernanceClass,
  evolveStabilityClass,
  governanceAuthorisesLevel,
  manifestationAuthorityFor,
  memoryGovernanceCeiling,
  planPromotion
} from "../../path-manifestation-policy.js";

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
      support_events_count: STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count
    });
    expect(next).toBe(StabilityClass.NORMAL);
  });

  it("keeps volatile when support is below threshold", () => {
    const next = evolveStabilityClass({
      current: StabilityClass.VOLATILE,
      governance_class: PathGovernanceClass.STRICTLY_GOVERNED,
      support_events_count: STABILITY_PROMOTION_THRESHOLDS.volatile_to_normal_support_count - 1
    });
    expect(next).toBe(StabilityClass.VOLATILE);
  });

  it("promotes normal to stable once support reaches threshold", () => {
    const next = evolveStabilityClass({
      current: StabilityClass.NORMAL,
      governance_class: PathGovernanceClass.RECALL_ALLOWED,
      support_events_count: STABILITY_PROMOTION_THRESHOLDS.normal_to_stable_support_count
    });
    expect(next).toBe(StabilityClass.STABLE);
  });

  it("walks volatile through normal up to stable in a single evaluation when support is high", () => {
    const next = evolveStabilityClass({
      current: StabilityClass.VOLATILE,
      governance_class: PathGovernanceClass.RECALL_ALLOWED,
      support_events_count: STABILITY_PROMOTION_THRESHOLDS.normal_to_stable_support_count
    });
    expect(next).toBe(StabilityClass.STABLE);
  });

  it("promotes stable to pinned only when governance is strictly_governed", () => {
    expect(
      evolveStabilityClass({
        current: StabilityClass.STABLE,
        governance_class: PathGovernanceClass.STRICTLY_GOVERNED,
        support_events_count: 999
      })
    ).toBe(StabilityClass.PINNED);
    expect(
      evolveStabilityClass({
        current: StabilityClass.STABLE,
        governance_class: PathGovernanceClass.RECALL_ALLOWED,
        support_events_count: 999
      })
    ).toBe(StabilityClass.STABLE);
  });
});

describe("evolveGovernanceClass promotion ladder", () => {
  it("promotes hint_only to attention_only after support reaches threshold with zero contradictions", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.HINT_ONLY,
      support_events_count: GOVERNANCE_PROMOTION_THRESHOLDS.hint_to_attention_support_count,
      contradiction_events_count: 0
    });
    expect(next).toBe(PathGovernanceClass.ATTENTION_ONLY);
  });

  it("holds hint_only when any contradiction is present", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.HINT_ONLY,
      support_events_count: GOVERNANCE_PROMOTION_THRESHOLDS.hint_to_attention_support_count,
      contradiction_events_count: 1
    });
    expect(next).toBe(PathGovernanceClass.HINT_ONLY);
  });

  it("promotes attention_only to recall_allowed after support reaches threshold", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.ATTENTION_ONLY,
      support_events_count: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      contradiction_events_count: 0
    });
    expect(next).toBe(PathGovernanceClass.RECALL_ALLOWED);
  });

  it("walks hint_only straight to recall_allowed when support is past the second threshold", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.HINT_ONLY,
      support_events_count: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      contradiction_events_count: 0
    });
    expect(next).toBe(PathGovernanceClass.RECALL_ALLOWED);
  });

  it("never auto-promotes recall_allowed beyond recall_allowed", () => {
    const next = evolveGovernanceClass({
      current: PathGovernanceClass.RECALL_ALLOWED,
      support_events_count: 999,
      contradiction_events_count: 0
    });
    expect(next).toBe(PathGovernanceClass.RECALL_ALLOWED);
  });

  it("leaves strictly_governed unchanged regardless of support / contradictions", () => {
    expect(
      evolveGovernanceClass({
        current: PathGovernanceClass.STRICTLY_GOVERNED,
        support_events_count: 999,
        contradiction_events_count: 0
      })
    ).toBe(PathGovernanceClass.STRICTLY_GOVERNED);
    expect(
      evolveGovernanceClass({
        current: PathGovernanceClass.STRICTLY_GOVERNED,
        support_events_count: 0,
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
      nextContradictionEventsCount: 0
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
      nextContradictionEventsCount: 0
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
      nextContradictionEventsCount: 0
    });
    expect(plan.stability).toBeNull();
    expect(plan.governance).toBeNull();
  });

  it("withholds governance promotion when any contradiction is reported", () => {
    const plan = planPromotion({
      path: createSeedPath(),
      nextSupportEventsCount: GOVERNANCE_PROMOTION_THRESHOLDS.attention_to_recall_support_count,
      nextContradictionEventsCount: 1
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
      nextContradictionEventsCount: 0
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
      nextContradictionEventsCount: 0
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
      nextContradictionEventsCount: 0
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
      nextContradictionEventsCount: 0
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
      nextContradictionEventsCount: 0
    });
    expect(plan.governance).not.toBeNull();
    expect(plan.governance?.previous).toBe(PathGovernanceClass.ATTENTION_ONLY);
    expect(plan.governance?.next).toBe(PathGovernanceClass.RECALL_ALLOWED);
  });
});

describe("memoryGovernanceCeiling — governance HARD CEILING band mapping", () => {
  // Helper: a contribution with a TRUSTED recall_allowed-birth provenance marker
  // (signal-graph seed). Non-recall_allowed bands ignore evidence_basis.
  function band(
    governance_class: PathRelation["legitimacy"]["governance_class"]
  ): { governance_class: typeof governance_class; evidence_basis: readonly string[] } {
    return { governance_class, evidence_basis: ["signal_graph_reference"] };
  }
  // Helper: an UNTRUSTED recall_allowed contribution — the band a co-usage/
  // supports/derives path reaches via the agent-pumpable auto-promotion ladder.
  // evidence_basis still carries only its BIRTH marker (plasticity rewrites
  // governance_class but never evidence_basis).
  function pumpedRecallAllowed(birthMarker: string): {
    governance_class: "recall_allowed";
    evidence_basis: readonly string[];
  } {
    return { governance_class: "recall_allowed", evidence_basis: [birthMarker] };
  }

  it("maps each band to its most-permissive ManifestationState ceiling", () => {
    expect(memoryGovernanceCeiling([band(PathGovernanceClass.HINT_ONLY)])).toBe(
      ManifestationState.HINT
    );
    expect(memoryGovernanceCeiling([band(PathGovernanceClass.ATTENTION_ONLY)])).toBe(
      ManifestationState.EXCERPT
    );
    expect(memoryGovernanceCeiling([band(PathGovernanceClass.RECALL_ALLOWED)])).toBe(
      ManifestationState.FULL_ELIGIBLE
    );
    expect(memoryGovernanceCeiling([band(PathGovernanceClass.STRICTLY_GOVERNED)])).toBe(
      ManifestationState.FULL_ELIGIBLE
    );
  });

  it("empty contribution set (no governing inbound path) defaults to full_eligible (unrestricted)", () => {
    expect(memoryGovernanceCeiling([])).toBe(ManifestationState.FULL_ELIGIBLE);
  });

  it("reduces multiple inbound bands to the MOST PERMISSIVE — strong assoc not throttled by weak", () => {
    // A memory governed by BOTH a hint_only and a (trusted) recall_allowed
    // inbound path takes the full_eligible ceiling: a strong association must
    // not be capped by a weak co-existing one.
    expect(
      memoryGovernanceCeiling([
        band(PathGovernanceClass.HINT_ONLY),
        band(PathGovernanceClass.RECALL_ALLOWED)
      ])
    ).toBe(ManifestationState.FULL_ELIGIBLE);
    // hint_only + attention_only -> excerpt (the more permissive of the two).
    expect(
      memoryGovernanceCeiling([
        band(PathGovernanceClass.HINT_ONLY),
        band(PathGovernanceClass.ATTENTION_ONLY)
      ])
    ).toBe(ManifestationState.EXCERPT);
    // Order independence.
    expect(
      memoryGovernanceCeiling([
        band(PathGovernanceClass.RECALL_ALLOWED),
        band(PathGovernanceClass.HINT_ONLY)
      ])
    ).toBe(ManifestationState.FULL_ELIGIBLE);
  });

  describe("Finding #2 — ceiling does not ride the agent-pumpable governance band", () => {
    it.each([
      ["recalls_edge_co_usage"],
      ["llm_supports_inference"],
      ["llm_derives_inference"],
      ["shared_entity_overlap"]
    ])(
      "an auto-promoted recall_allowed (birth marker %s, no trusted provenance) caps at excerpt",
      (birthMarker) => {
        // A positive co-usage/supports/derives/shares_entity path that climbed
        // to recall_allowed by pumping support_events_count >= 8 keeps only its
        // birth evidence_basis — it must NOT lift the ceiling to full_eligible.
        expect(memoryGovernanceCeiling([pumpedRecallAllowed(birthMarker)])).toBe(
          ManifestationState.EXCERPT
        );
      }
    );

    it("a trusted-seed recall_allowed (signal_graph_reference) reaches full_eligible", () => {
      expect(
        memoryGovernanceCeiling([
          { governance_class: "recall_allowed", evidence_basis: ["signal_graph_reference"] }
        ])
      ).toBe(ManifestationState.FULL_ELIGIBLE);
    });

    it("a human/auto edge-accept recall_allowed (edge_proposal_accept:<id>) reaches full_eligible", () => {
      expect(
        memoryGovernanceCeiling([
          {
            governance_class: "recall_allowed",
            evidence_basis: ["edge_proposal_accept:edge_prop_abc123"]
          }
        ])
      ).toBe(ManifestationState.FULL_ELIGIBLE);
    });

    it("strictly_governed (user-set, not auto-reachable) reaches full_eligible regardless of evidence", () => {
      expect(
        memoryGovernanceCeiling([
          { governance_class: "strictly_governed", evidence_basis: ["anything"] }
        ])
      ).toBe(ManifestationState.FULL_ELIGIBLE);
    });

    it("a pumped recall_allowed co-existing with a trusted one still reaches full_eligible (most-permissive)", () => {
      // The trust narrowing is per-contribution: a legitimate trusted path is
      // not penalised by a pumped sibling, and a pumped path cannot exceed
      // excerpt on its own.
      expect(
        memoryGovernanceCeiling([
          pumpedRecallAllowed("recalls_edge_co_usage"),
          { governance_class: "recall_allowed", evidence_basis: ["signal_graph_reference"] }
        ])
      ).toBe(ManifestationState.FULL_ELIGIBLE);
    });
  });
});

describe("clampManifestationByGovernance — pure total min over the strict ordering", () => {
  const order: readonly ManifestationStateValue[] = [
    ManifestationState.HIDDEN,
    ManifestationState.HINT,
    ManifestationState.EXCERPT,
    ManifestationState.FULL_ELIGIBLE
  ];

  it("returns the LOWER band for the full tier x ceiling grid", () => {
    for (const tier of order) {
      for (const ceiling of order) {
        const tierRank = order.indexOf(tier);
        const ceilingRank = order.indexOf(ceiling);
        const expected = tierRank <= ceilingRank ? tier : ceiling;
        expect(clampManifestationByGovernance(tier, ceiling)).toBe(expected);
      }
    }
  });

  it("never elevates: a hidden tier with a full_eligible ceiling stays hidden", () => {
    expect(
      clampManifestationByGovernance(ManifestationState.HIDDEN, ManifestationState.FULL_ELIGIBLE)
    ).toBe(ManifestationState.HIDDEN);
  });

  it("caps: a full_eligible tier with a hint ceiling drops to hint", () => {
    expect(
      clampManifestationByGovernance(ManifestationState.FULL_ELIGIBLE, ManifestationState.HINT)
    ).toBe(ManifestationState.HINT);
  });
});

describe("GOVERNANCE_CEILING_FAILSAFE_BAND — fail-closed to the lowest visibility band", () => {
  it("is HINT, the only band that is never an over-surface for ANY governance class", () => {
    // A transient governance-read failure must cap to the LOWEST non-hidden band.
    // hint is the only band <= every governance class's true ceiling: hint_only
    // (hint), attention_only (excerpt), recall_allowed (full_eligible), and
    // strictly_governed (full_eligible) all permit at least hint, so capping to
    // hint cannot exceed any class's true ceiling. A higher failsafe (excerpt)
    // would over-surface a hint_only memory. see also: recall-service.ts
    //   collectGovernanceCeilings (throw branch).
    expect(GOVERNANCE_CEILING_FAILSAFE_BAND).toBe(ManifestationState.HINT);
    // The failsafe band must be <= each governance class's true ceiling band, so
    // clamping to it on a read error never over-surfaces any class.
    for (const governance of [
      PathGovernanceClass.HINT_ONLY,
      PathGovernanceClass.ATTENTION_ONLY,
      PathGovernanceClass.RECALL_ALLOWED,
      PathGovernanceClass.STRICTLY_GOVERNED
    ]) {
      const trueCeiling = memoryGovernanceCeiling([
        { governance_class: governance, evidence_basis: ["signal_graph_reference"] }
      ]);
      expect(clampManifestationByGovernance(trueCeiling, GOVERNANCE_CEILING_FAILSAFE_BAND)).toBe(
        GOVERNANCE_CEILING_FAILSAFE_BAND
      );
    }
  });
});
