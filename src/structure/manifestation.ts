import { normalizeUnit } from "../foundation/validation.js";
import type {
  ActivationCandidate,
  ManifestationBudgetConfig,
  ManifestationBudgetRemaining,
  ManifestationDecision,
  ManifestationLevel,
  PathGovernanceClass,
  TaskSurfaceRef
} from "./types.js";
import { listPathAnchorRefContextRefs, validateActivationCandidate, validateManifestationBudgetConfig } from "./validation.js";

const governanceOrder: Readonly<Record<PathGovernanceClass, number>> = {
  hint_only: 0,
  attention_only: 1,
  recall_allowed: 2,
  strictly_governed: 3
};

export interface ResolveManifestationInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly candidates: readonly ActivationCandidate[];
  readonly taskSurfaceRef: TaskSurfaceRef | null;
  readonly budgetConfig: ManifestationBudgetConfig;
}

export function resolveManifestations(input: ResolveManifestationInput): readonly ManifestationDecision[] {
  const config = validateManifestationBudgetConfig(input.budgetConfig);
  const orderedCandidates = input.candidates
    .map(validateActivationCandidate)
    .filter((candidate) => candidate.workspace_id === input.workspaceId && candidate.run_id === input.runId)
    .sort(compareCandidatesForDeterministicEvaluation);

  let budget: ManifestationBudgetRemaining = {
    stance_bias: config.stance_bias_cap,
    dialogue_nudge: config.dialogue_nudge_cap,
    lens_entry: config.lens_entry_cap
  };
  const decisions: ManifestationDecision[] = [];

  for (const candidate of orderedCandidates) {
    const desired = determineDesiredLevel(candidate, config, input.taskSurfaceRef);
    const allocation = allocateBudget(desired.level, budget);
    budget = allocation.remainingBudget;
    decisions.push({
      candidate_id: candidate.candidate_id,
      source_path_id: candidate.source_path_id,
      assigned_level: allocation.assignedLevel,
      reason: buildDecisionReason({
        assignedLevel: allocation.assignedLevel,
        exhaustedLevels: allocation.exhaustedLevels,
        blockedReason: desired.blockedReason
      }),
      budget_remaining: allocation.remainingBudget
    });
  }

  return Object.freeze(decisions);
}

function determineDesiredLevel(
  candidate: ActivationCandidate,
  config: ManifestationBudgetConfig,
  taskSurfaceRef: TaskSurfaceRef | null
): { level: ManifestationLevel; blockedReason: string | null } {
  const nudgeEligible =
    normalizeUnit(candidate.pressure) >= config.escalation_policy.nudge_min_pressure &&
    normalizeUnit(candidate.confidence) >= config.escalation_policy.nudge_min_confidence;
  const lens = evaluateLensEligibility(candidate, config, taskSurfaceRef);

  if (lens.eligible) {
    return { level: "lens_entry", blockedReason: null };
  }

  if (
    candidate.effect_vector_snapshot.default_manifestation_preference === "dialogue_nudge" ||
    candidate.effect_vector_snapshot.default_manifestation_preference === "lens_entry" ||
    nudgeEligible
  ) {
    return { level: "dialogue_nudge", blockedReason: lens.blockedReason };
  }

  return { level: "stance_bias", blockedReason: lens.blockedReason };
}

function evaluateLensEligibility(
  candidate: ActivationCandidate,
  config: ManifestationBudgetConfig,
  taskSurfaceRef: TaskSurfaceRef | null
): { eligible: boolean; blockedReason: string | null } {
  const meetsLensStrength =
    normalizeUnit(candidate.pressure) >= config.escalation_policy.lens_min_pressure &&
    normalizeUnit(candidate.confidence) >= config.escalation_policy.lens_min_confidence;

  if (!meetsLensStrength) {
    return { eligible: false, blockedReason: null };
  }

  if (config.escalation_policy.lens_requires_task_coupling && taskSurfaceRef === null) {
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
    !governanceAllowsLens(candidate.governance_ceiling)
  ) {
    return { eligible: false, blockedReason: "governance_ceiling" };
  }

  return { eligible: true, blockedReason: null };
}

function hasTaskCoupling(candidate: ActivationCandidate, taskSurfaceRef: TaskSurfaceRef): boolean {
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

function governanceAllowsLens(governanceCeiling: PathGovernanceClass): boolean {
  return governanceOrder[governanceCeiling] >= governanceOrder.recall_allowed;
}

function allocateBudget(
  desiredLevel: ManifestationLevel,
  budget: ManifestationBudgetRemaining
): {
  readonly assignedLevel: ManifestationLevel | null;
  readonly exhaustedLevels: readonly ManifestationLevel[];
  readonly remainingBudget: ManifestationBudgetRemaining;
} {
  const exhaustedLevels: ManifestationLevel[] = [];
  let remainingBudget = budget;
  for (const level of getAllocationOrder(desiredLevel)) {
    if (remainingBudget[level] > 0) {
      remainingBudget = { ...remainingBudget, [level]: remainingBudget[level] - 1 };
      return { assignedLevel: level, exhaustedLevels, remainingBudget };
    }
    exhaustedLevels.push(level);
  }
  return { assignedLevel: null, exhaustedLevels, remainingBudget };
}

function getAllocationOrder(level: ManifestationLevel): readonly ManifestationLevel[] {
  switch (level) {
    case "lens_entry":
      return ["lens_entry", "dialogue_nudge", "stance_bias"];
    case "dialogue_nudge":
      return ["dialogue_nudge", "stance_bias"];
    case "stance_bias":
      return ["stance_bias"];
  }
}

function buildDecisionReason(input: {
  readonly assignedLevel: ManifestationLevel | null;
  readonly exhaustedLevels: readonly ManifestationLevel[];
  readonly blockedReason: string | null;
}): string {
  if (input.assignedLevel === null) {
    const lastExhausted = input.exhaustedLevels[input.exhaustedLevels.length - 1] ?? "stance_bias";
    return `discarded:${lastExhausted}_budget_exhausted`;
  }
  const details = [`assigned:${input.assignedLevel}`];
  for (const exhaustedLevel of input.exhaustedLevels) {
    details.push(`downgraded:${exhaustedLevel}_budget_exhausted`);
  }
  if (input.blockedReason !== null) {
    details.push(`blocked:${input.blockedReason}`);
  }
  return details.join("; ");
}

function compareCandidatesForDeterministicEvaluation(left: ActivationCandidate, right: ActivationCandidate): number {
  const scoreDelta = scoreCandidate(right) - scoreCandidate(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  const pressureDelta = normalizeUnit(right.pressure) - normalizeUnit(left.pressure);
  if (pressureDelta !== 0) {
    return pressureDelta;
  }
  const confidenceDelta = normalizeUnit(right.confidence) - normalizeUnit(left.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }
  return left.candidate_id.localeCompare(right.candidate_id);
}

function scoreCandidate(candidate: ActivationCandidate): number {
  return normalizeUnit(candidate.pressure) * normalizeUnit(candidate.confidence);
}
