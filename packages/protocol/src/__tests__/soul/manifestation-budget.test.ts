import { describe, expect, it } from "vitest";
import {
  DYNAMICS_CONSTANTS,
  ManifestationBudgetConfigSchema,
  ManifestationBudgetEvaluatedPayloadSchema,
  ManifestationDecisionSchema,
  ManifestationEscalationDecidedPayloadSchema,
  ManifestationLevel,
  ManifestationLevelSchema,
  RuntimeGovernanceEventType,
  RuntimeGovernanceEventUnionSchema,
  parseRuntimeGovernanceEventPayload
} from "../../index.js";

const NOW = "2026-04-17T00:00:00.000Z";

describe("manifestation budget contracts", () => {
  it("parses manifestation level, budget config, and decision contracts", () => {
    const config = {
      workspace_id: "workspace-1",
      stance_bias_cap: 10,
      dialogue_nudge_cap: 3,
      lens_entry_cap: 1,
      escalation_policy: {
        nudge_min_pressure: 0.4,
        nudge_min_confidence: 0.5,
        lens_min_pressure: 0.7,
        lens_min_confidence: 0.7,
        lens_requires_task_coupling: true,
        lens_requires_governance_ceiling: true
      },
      updated_at: NOW
    } as const;
    const decision = {
      candidate_id: "candidate-1",
      source_path_id: "path-1",
      assigned_level: ManifestationLevel.DIALOGUE_NUDGE,
      reason: "nudge_threshold_met",
      budget_remaining: {
        stance_bias: 9,
        dialogue_nudge: 2,
        lens_entry: 1
      }
    } as const;

    expect(ManifestationLevelSchema.options).toEqual([
      ManifestationLevel.STANCE_BIAS,
      ManifestationLevel.DIALOGUE_NUDGE,
      ManifestationLevel.LENS_ENTRY
    ]);
    expect(ManifestationLevelSchema.parse("stance_bias")).toBe(ManifestationLevel.STANCE_BIAS);
    expect(ManifestationBudgetConfigSchema.parse(config)).toEqual(config);
    expect(ManifestationDecisionSchema.parse(decision)).toEqual(decision);
  });

  it("freezes the default manifestation budget constants", () => {
    expect(DYNAMICS_CONSTANTS.manifestation_budget).toEqual({
      default_stance_bias_cap: 10,
      default_dialogue_nudge_cap: 3,
      default_lens_entry_cap: 1,
      default_nudge_min_pressure: 0.4,
      default_nudge_min_confidence: 0.5,
      default_lens_min_pressure: 0.7,
      default_lens_min_confidence: 0.7
    });
    expect(Object.isFrozen(DYNAMICS_CONSTANTS.manifestation_budget)).toBe(true);
  });

  it("parses the C-7 manifestation event payloads", () => {
    const budgetPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      total_candidates: 3,
      stance_bias_assigned: 1,
      dialogue_nudge_assigned: 1,
      lens_entry_assigned: 1,
      discarded: 0,
      evaluated_at: NOW
    } as const;
    const decisionPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      decisions: [
        {
          candidate_id: "candidate-1",
          assigned_level: ManifestationLevel.LENS_ENTRY,
          reason: "lens_entry_assigned"
        },
        {
          candidate_id: "candidate-2",
          assigned_level: null,
          reason: "stance_bias_budget_exhausted"
        }
      ],
      decided_at: NOW
    } as const;
    const batchedDecisionPayload = {
      ...decisionPayload,
      batch_index: 0,
      batch_count: 2
    } as const;

    expect(ManifestationBudgetEvaluatedPayloadSchema.parse(budgetPayload)).toEqual(budgetPayload);
    expect(ManifestationEscalationDecidedPayloadSchema.parse(decisionPayload)).toEqual(
      decisionPayload
    );
    expect(ManifestationEscalationDecidedPayloadSchema.parse(batchedDecisionPayload)).toEqual(
      batchedDecisionPayload
    );
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED, budgetPayload)
    ).toEqual(budgetPayload);
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED, decisionPayload)
    ).toEqual(decisionPayload);
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED,
        payload: budgetPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED,
      payload: budgetPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED,
        payload: decisionPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED,
      payload: decisionPayload
    });
  });
});
