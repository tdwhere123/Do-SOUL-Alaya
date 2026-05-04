import { describe, expect, it } from "vitest";
import {
  ActivationCandidateSchema,
  ComputeProviderPriority,
  ComputeProviderPrioritySchema,
  ComputeRoutingDecisionSchema,
  ConsolidationCyclePlanSchema,
  ConsolidationCycleResultSchema,
  ControlPlaneObjectKind,
  ControlPlaneObjectKindSchema,
  DirectionBias,
  DYNAMICS_CONSTANTS,
  ExecutionStanceModelRefSchema,
  GardenProviderKind,
  GardenProviderKindSchema,
  ManifestationPreference,
  ObjectKind,
  ObjectKindSchema,
  PathAnchorRefSchema,
  PathGovernanceClass,
  PathRelationSchema,
  StabilityClass
} from "../index.js";

const validTimestamp = "2026-04-17T00:00:00.000Z";

describe("Phase C shared-contract foundation", () => {
  it("parses all PathAnchorRef variants", () => {
    const cases = [
      {
        kind: "object",
        object_id: "object-1"
      },
      {
        kind: "object_facet",
        object_id: "object-1",
        facet_key: "status"
      },
      {
        kind: "obligation",
        source_object_id: "object-1",
        obligation_digest: "digest-1"
      },
      {
        kind: "risk_concern",
        source_object_id: "object-1",
        concern_digest: "digest-2"
      },
      {
        kind: "time_concern",
        source_object_id: "object-1",
        window_digest: "digest-3"
      }
    ] as const;

    for (const value of cases) {
      expect(PathAnchorRefSchema.parse(value)).toEqual(value);
    }
  });

  it("registers path relations as persistent objects and activation candidates as control-plane objects", () => {
    expect(ObjectKindSchema.parse("path_relation")).toBe("path_relation");
    expect(ControlPlaneObjectKindSchema.parse("activation_candidate")).toBe("activation_candidate");
    expect(ObjectKind.PATH_RELATION).toBe("path_relation");
    expect(ControlPlaneObjectKind.ACTIVATION_CANDIDATE).toBe("activation_candidate");
  });

  it("parses PathRelation, ActivationCandidate, and consolidation cycle contracts", () => {
    const relation = {
      path_id: "path-1",
      workspace_id: "workspace-1",
      anchors: {
        source_anchor: {
          kind: "object",
          object_id: "object-1"
        },
        target_anchor: {
          kind: "object_facet",
          object_id: "object-2",
          facet_key: "status"
        }
      },
      constitution: {
        relation_kind: "supports",
        why_this_relation_exists: ["reinforced_by_history", "governed_path"]
      },
      effect_vector: {
        salience: 0.7,
        recall_bias: 0.6,
        verification_bias: 0.4,
        unfinishedness_bias: 0.2,
        default_manifestation_preference: ManifestationPreference.STANCE_BIAS
      },
      plasticity_state: {
        strength: 0.55,
        direction_bias: DirectionBias.SOURCE_TO_TARGET,
        stability_class: StabilityClass.NORMAL,
        support_events_count: 3,
        contradiction_events_count: 1,
        last_reinforced_at: validTimestamp,
        last_weakened_at: validTimestamp
      },
      lifecycle: {
        retirement_rule: "retire_after_cooldown",
        cooldown_rule: "7d_without_support",
        override_rule: "manual_override"
      },
      legitimacy: {
        evidence_basis: ["evidence-1", "evidence-2"],
        governance_class: PathGovernanceClass.RECALL_ALLOWED
      },
      created_at: validTimestamp,
      updated_at: validTimestamp
    } as const;

    const activationCandidate = {
      candidate_id: "candidate-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      source_path_id: "path-1",
      source_anchor: relation.anchors.source_anchor,
      target_anchor: relation.anchors.target_anchor,
      why_now: "matching turn intent",
      effect_vector_snapshot: relation.effect_vector,
      pressure: 0.4,
      confidence: 0.8,
      governance_ceiling: PathGovernanceClass.HINT_ONLY,
      created_at: validTimestamp
    } as const;

    const consolidationPlan = {
      workspace_id: "workspace-1",
      planned_at: validTimestamp,
      promotions: [
        {
          path_id: "path-1",
          from_stability: StabilityClass.VOLATILE,
          to_stability: StabilityClass.NORMAL
        }
      ],
      retirements: [
        {
          path_id: "path-2",
          reason: "cooldown_expired"
        }
      ],
      governance_changes: [
        {
          path_id: "path-3",
          from_class: PathGovernanceClass.HINT_ONLY,
          to_class: PathGovernanceClass.ATTENTION_ONLY
        }
      ],
      direction_changes: [
        {
          path_id: "path-4",
          from_bias: DirectionBias.SOURCE_TO_TARGET,
          to_bias: DirectionBias.BIDIRECTIONAL_ASYMMETRIC
        }
      ],
      fuse_state: {
        blown: false,
        retry_count: 0
      }
    } as const;

    const consolidationResult = {
      workspace_id: "workspace-1",
      committed_at: validTimestamp,
      promotions_committed: 1,
      retirements_committed: 1,
      governance_changes_committed: 1,
      direction_changes_committed: 1,
      fuse_outcome: "ok"
    } as const;

    expect(PathRelationSchema.parse(relation)).toEqual(relation);
    expect(ActivationCandidateSchema.parse(activationCandidate)).toEqual(activationCandidate);
    expect(ConsolidationCyclePlanSchema.parse(consolidationPlan)).toEqual(consolidationPlan);
    expect(ConsolidationCycleResultSchema.parse(consolidationResult)).toEqual(consolidationResult);
  });

  it("parses compute routing decisions and preserves model_ref compatibility", () => {
    const decision = {
      decision_id: "decision-1",
      workspace_id: "workspace-1",
      selected_provider: ComputeProviderPriority.CUSTOM_API,
      model_id: "gpt-4.1-mini",
      adapter: "custom-openai-compatible",
      selection_reason: "custom_api selected as highest-priority configured compute provider",
      decided_at: validTimestamp
    } as const;

    expect(ComputeProviderPrioritySchema.parse("official_api")).toBe("official_api");
    expect(ComputeProviderPrioritySchema.parse("custom_api")).toBe("custom_api");
    expect(ComputeProviderPrioritySchema.parse("local_model")).toBe("local_model");
    expect(ComputeProviderPrioritySchema.parse("stub")).toBe("stub");
    expect(ComputeRoutingDecisionSchema.parse(decision)).toEqual(decision);
    expect(
      ExecutionStanceModelRefSchema.parse({
        provider: decision.selected_provider,
        model_id: decision.model_id,
        adapter: decision.adapter
      })
    ).toEqual({
      provider: decision.selected_provider,
      model_id: decision.model_id,
      adapter: decision.adapter
    });
  });

  it("exports garden provider kinds from protocol ownership", () => {
    expect(GardenProviderKindSchema.parse("local_heuristics")).toBe("local_heuristics");
    expect(GardenProviderKindSchema.parse("official_api")).toBe("official_api");
    expect(GardenProviderKindSchema.parse("custom_api")).toBe("custom_api");
    expect(GardenProviderKindSchema.parse("local_model")).toBe("local_model");
    expect(Object.values(GardenProviderKind)).toEqual([
      "local_heuristics",
      "official_api",
      "custom_api",
      "local_model"
    ]);
  });

  it("freezes the path plasticity constants", () => {
    expect(DYNAMICS_CONSTANTS.path_plasticity).toEqual({
      reinforcement_increment: 0.1,
      weakening_decrement: -0.05,
      salience_boost_on_hit: 0.15,
      volatile_to_normal_support_count: 5,
      normal_to_stable_support_count: 15,
      stable_to_pinned_support_count: 50,
      retirement_cooldown_ms: 7 * 24 * 3600 * 1000,
      consolidation_fuse_max_retries: 3,
      consolidation_fuse_cooldown_ms: 60_000,
      // A3: feedback-loop-specific tuning (see DYNAMICS_CONSTANTS comment).
      strength_floor: 0,
      strength_ceiling: 1,
      retirement_strength_threshold: 0.05,
      retirement_inactivity_ms: 30 * 24 * 3600 * 1000
    });
    expect(Object.isFrozen(DYNAMICS_CONSTANTS.path_plasticity)).toBe(true);
  });
});
