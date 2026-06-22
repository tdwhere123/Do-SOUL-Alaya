import {
  DYNAMICS_CONSTANTS,
  ManifestationBudgetConfigSchema,
  ManifestationLevel,
  listPathAnchorRefContextRefs,
  type ActivationCandidate,
  type ManifestationBudgetConfig,
  type ManifestationLevel as ManifestationLevelValue,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { governanceAuthorisesLevel } from "../path-graph/path-manifestation-policy.js";
import { clamp01 } from "../shared/clamp.js";
import type {
  BudgetAllocationResult,
  BudgetState,
  LensEligibility
} from "./manifestation-resolver-types.js";

export const SYSTEM_NOW = (): string => new Date().toISOString();

export function determineDesiredLevel(
  candidate: Readonly<ActivationCandidate>,
  config: Readonly<ManifestationBudgetConfig>,
  taskSurfaceRef: Readonly<TaskObjectSurface> | null
): {
  level: ManifestationLevelValue;
  lens: LensEligibility;
} {
  const nudgeEligible =
    clamp01(candidate.pressure) >= config.escalation_policy.nudge_min_pressure &&
    clamp01(candidate.confidence) >= config.escalation_policy.nudge_min_confidence;
  const lens = evaluateLensEligibility(candidate, config, taskSurfaceRef);

  if (lens.eligible) {
    return { level: ManifestationLevel.LENS_ENTRY, lens };
  }

  if (
    candidate.effect_vector_snapshot.default_manifestation_preference ===
      ManifestationLevel.DIALOGUE_NUDGE ||
    candidate.effect_vector_snapshot.default_manifestation_preference ===
      ManifestationLevel.LENS_ENTRY ||
    nudgeEligible
  ) {
    return { level: ManifestationLevel.DIALOGUE_NUDGE, lens };
  }

  return { level: ManifestationLevel.STANCE_BIAS, lens };
}

export function allocateBudget(
  desiredLevel: ManifestationLevelValue,
  budgets: BudgetState,
  governanceCeiling: ActivationCandidate["governance_ceiling"]
): BudgetAllocationResult {
  const fallbackOrder = getAllocationOrder(desiredLevel);
  const exhaustedLevels: ManifestationLevelValue[] = [];
  let nextBudget = budgets;
  let governanceBlocked = false;

  for (const level of fallbackOrder) {
    if (!governanceAuthorisesLevel(governanceCeiling, level)) {
      governanceBlocked = true;
      continue;
    }
    if (nextBudget[level] > 0) {
      nextBudget = Object.freeze({
        ...nextBudget,
        [level]: nextBudget[level] - 1
      });
      return Object.freeze({
        assignedLevel: level,
        exhaustedLevels: Object.freeze([...exhaustedLevels]),
        remainingBudget: nextBudget,
        governanceBlocked
      });
    }

    exhaustedLevels.push(level);
  }

  return Object.freeze({
    assignedLevel: null,
    exhaustedLevels: Object.freeze([...exhaustedLevels]),
    remainingBudget: nextBudget,
    governanceBlocked
  });
}

export function buildDecisionReason(input: {
  assignedLevel: ManifestationLevelValue | null;
  exhaustedLevels: readonly ManifestationLevelValue[];
  blockedReason: LensEligibility["blockedReason"];
  governanceBlocked: boolean;
}): string {
  const details: string[] = [];

  if (input.assignedLevel === null) {
    const parts: string[] = [];
    if (input.exhaustedLevels.length > 0) {
      const lastExhausted =
        input.exhaustedLevels[input.exhaustedLevels.length - 1] ??
        ManifestationLevel.STANCE_BIAS;
      parts.push(`discarded:${lastExhausted}_budget_exhausted`);
    }
    if (input.governanceBlocked) {
      parts.push("discarded:governance_ceiling_blocked");
    }
    if (parts.length === 0) {
      parts.push(`discarded:${ManifestationLevel.STANCE_BIAS}_budget_exhausted`);
    }
    return parts.join("; ");
  }

  details.push(`assigned:${input.assignedLevel}`);

  for (const exhaustedLevel of input.exhaustedLevels) {
    details.push(`downgraded:${exhaustedLevel}_budget_exhausted`);
  }

  if (input.blockedReason !== null) {
    details.push(`blocked:${input.blockedReason}`);
  }

  if (input.governanceBlocked) {
    details.push("blocked:governance_ceiling");
  }

  return details.join("; ");
}

export function countAssigned(
  decisions: readonly Readonly<{ assigned_level: ManifestationLevelValue | null }>[],
  level: ManifestationLevelValue
): number {
  return decisions.filter((decision) => decision.assigned_level === level).length;
}

export function compareCandidatesForDeterministicEvaluation(
  left: Readonly<ActivationCandidate>,
  right: Readonly<ActivationCandidate>
): number {
  const scoreDelta = scoreCandidate(right) - scoreCandidate(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const pressureDelta = clamp01(right.pressure) - clamp01(left.pressure);
  if (pressureDelta !== 0) {
    return pressureDelta;
  }

  const confidenceDelta = clamp01(right.confidence) - clamp01(left.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  return left.candidate_id.localeCompare(right.candidate_id);
}

export function createDefaultManifestationBudgetConfig(
  workspaceId: string,
  nowIso: string
): Readonly<ManifestationBudgetConfig> {
  return ManifestationBudgetConfigSchema.parse({
    workspace_id: workspaceId,
    stance_bias_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_stance_bias_cap,
    dialogue_nudge_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_dialogue_nudge_cap,
    lens_entry_cap: DYNAMICS_CONSTANTS.manifestation_budget.default_lens_entry_cap,
    escalation_policy: {
      nudge_min_pressure:
        DYNAMICS_CONSTANTS.manifestation_budget.default_nudge_min_pressure,
      nudge_min_confidence:
        DYNAMICS_CONSTANTS.manifestation_budget.default_nudge_min_confidence,
      lens_min_pressure:
        DYNAMICS_CONSTANTS.manifestation_budget.default_lens_min_pressure,
      lens_min_confidence:
        DYNAMICS_CONSTANTS.manifestation_budget.default_lens_min_confidence,
      lens_requires_task_coupling: true,
      lens_requires_governance_ceiling: true
    },
    updated_at: nowIso
  });
}

export function anchorMemoryObjectId(
  anchor: ActivationCandidate["target_anchor"]
): string | null {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
  }
}

function evaluateLensEligibility(
  candidate: Readonly<ActivationCandidate>,
  config: Readonly<ManifestationBudgetConfig>,
  taskSurfaceRef: Readonly<TaskObjectSurface> | null
): LensEligibility {
  const meetsLensStrength =
    clamp01(candidate.pressure) >= config.escalation_policy.lens_min_pressure &&
    clamp01(candidate.confidence) >= config.escalation_policy.lens_min_confidence;

  if (!meetsLensStrength) {
    return { eligible: false, blockedReason: null };
  }

  if (
    config.escalation_policy.lens_requires_task_coupling &&
    taskSurfaceRef === null
  ) {
    return { eligible: false, blockedReason: "task_surface_ref_missing" };
  }

  if (
    config.escalation_policy.lens_requires_task_coupling &&
    taskSurfaceRef !== null &&
    !hasTaskCoupling(candidate, taskSurfaceRef)
  ) {
    return { eligible: false, blockedReason: "task_coupling" };
  }

  if (
    config.escalation_policy.lens_requires_governance_ceiling &&
    !governanceAuthorisesLevel(candidate.governance_ceiling, ManifestationLevel.LENS_ENTRY)
  ) {
    return { eligible: false, blockedReason: "governance_ceiling" };
  }

  return { eligible: true, blockedReason: null };
}

function hasTaskCoupling(
  candidate: Readonly<ActivationCandidate>,
  taskSurfaceRef: Readonly<TaskObjectSurface>
): boolean {
  const contextRefs = new Set(taskSurfaceRef.context_refs);

  for (const ref of [
    ...listPathAnchorRefContextRefs(candidate.source_anchor),
    ...listPathAnchorRefContextRefs(candidate.target_anchor)
  ]) {
    if (contextRefs.has(ref)) {
      return true;
    }
  }

  return false;
}

function getAllocationOrder(
  desiredLevel: ManifestationLevelValue
): readonly ManifestationLevelValue[] {
  switch (desiredLevel) {
    case ManifestationLevel.LENS_ENTRY:
      return [
        ManifestationLevel.LENS_ENTRY,
        ManifestationLevel.DIALOGUE_NUDGE,
        ManifestationLevel.STANCE_BIAS
      ];
    case ManifestationLevel.DIALOGUE_NUDGE:
      return [ManifestationLevel.DIALOGUE_NUDGE, ManifestationLevel.STANCE_BIAS];
    case ManifestationLevel.STANCE_BIAS:
      return [ManifestationLevel.STANCE_BIAS];
  }

  return unreachableManifestationLevel(desiredLevel);
}

function scoreCandidate(candidate: Readonly<ActivationCandidate>): number {
  return clamp01(candidate.pressure) * clamp01(candidate.confidence);
}

function unreachableManifestationLevel(value: never): never {
  throw new Error(`Unhandled manifestation level: ${String(value)}`);
}
