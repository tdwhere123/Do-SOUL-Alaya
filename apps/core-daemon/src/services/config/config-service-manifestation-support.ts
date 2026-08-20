import {
  DYNAMICS_CONSTANTS,
  ManifestationBudgetConfigSchema,
  type ManifestationBudgetConfig
} from "@do-soul/alaya-protocol";

const MANIFESTATION_BUDGET_CAP_FIELDS = [
  "stance_bias_cap",
  "dialogue_nudge_cap",
  "lens_entry_cap"
] as const;

const MANIFESTATION_ESCALATION_POLICY_FIELDS = [
  "nudge_min_pressure",
  "nudge_min_confidence",
  "lens_min_pressure",
  "lens_min_confidence",
  "lens_requires_task_coupling",
  "lens_requires_governance_ceiling"
] as const;

export function defaultManifestationBudgetConfig(
  workspaceId: string,
  clock: () => string
): ManifestationBudgetConfig {
  return ManifestationBudgetConfigSchema.parse({
    workspace_id: workspaceId,
    stance_bias_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_stance_bias_cap,
    dialogue_nudge_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_dialogue_nudge_cap,
    lens_entry_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_lens_entry_cap,
    escalation_policy: {
      nudge_min_pressure: DYNAMICS_CONSTANTS.manifestation_budget.default_nudge_min_pressure,
      nudge_min_confidence: DYNAMICS_CONSTANTS.manifestation_budget.default_nudge_min_confidence,
      lens_min_pressure: DYNAMICS_CONSTANTS.manifestation_budget.default_lens_min_pressure,
      lens_min_confidence: DYNAMICS_CONSTANTS.manifestation_budget.default_lens_min_confidence,
      lens_requires_task_coupling: true,
      lens_requires_governance_ceiling: true
    },
    updated_at: clock()
  });
}

export function buildManifestationBudgetChangeSummary(
  patch: Record<string, unknown>,
  escalationPolicyPatch: Record<string, unknown>
): Readonly<{ fields_changed: readonly string[] }> {
  return {
    fields_changed: [
      ...MANIFESTATION_BUDGET_CAP_FIELDS.filter((field) => patch[field] !== undefined),
      ...MANIFESTATION_ESCALATION_POLICY_FIELDS
        .filter((field) => escalationPolicyPatch[field] !== undefined)
        .map((field) => `escalation_policy.${field}`)
    ]
  };
}
