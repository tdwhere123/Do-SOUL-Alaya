import {
  DYNAMICS_CONSTANTS,
  ManifestationBudgetConfigSchema,
  ManifestationBudgetEvaluatedPayloadSchema,
  ManifestationDecisionSchema,
  ManifestationEscalationDecidedPayloadSchema,
  ManifestationLevel,
  PathGovernanceClass,
  RuntimeGovernanceEventType,
  listPathAnchorRefContextRefs,
  type ActivationCandidate,
  type EventLogEntry,
  type ManifestationBudgetConfig,
  type ManifestationDecision,
  type ManifestationLevel as ManifestationLevelValue,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { loadOrDefaultWithWorkspaceGuard } from "./shared/load-or-default-with-workspace-guard.js";
import { normalizeUnit } from "./shared/normalize-unit.js";
import { validateActivationCandidates } from "./shared/validated-activation-candidates.js";

export interface ManifestationBudgetConfigProviderPort {
  getConfig(workspaceId: string): Promise<Readonly<ManifestationBudgetConfig> | null>;
}

export interface ManifestationResolverEventLogWriterPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
}

export interface ManifestationResolverDependencies {
  readonly budgetConfigProvider: ManifestationBudgetConfigProviderPort;
  readonly eventLogWriter: ManifestationResolverEventLogWriterPort;
  readonly now?: () => string;
}

export interface ResolveManifestationParams {
  readonly workspaceId: string;
  readonly runId: string;
  readonly candidates: readonly Readonly<ActivationCandidate>[];
  readonly taskSurfaceRef: Readonly<TaskObjectSurface> | null;
}

type BudgetState = Readonly<{
  stance_bias: number;
  dialogue_nudge: number;
  lens_entry: number;
}>;

type BudgetAllocationResult = Readonly<{
  assignedLevel: ManifestationLevelValue | null;
  exhaustedLevels: readonly ManifestationLevelValue[];
  remainingBudget: BudgetState;
}>;

type LensEligibility = {
  eligible: boolean;
  blockedReason: "task_surface_ref_missing" | "task_coupling" | "governance_ceiling" | null;
};

const governanceOrder = {
  [PathGovernanceClass.HINT_ONLY]: 0,
  [PathGovernanceClass.ATTENTION_ONLY]: 1,
  [PathGovernanceClass.RECALL_ALLOWED]: 2,
  [PathGovernanceClass.STRICTLY_GOVERNED]: 3
} as const;
const SYSTEM_NOW = () => new Date().toISOString();

export class ManifestationResolver {
  private readonly now: () => string;

  public constructor(private readonly deps: ManifestationResolverDependencies) {
    this.now = deps.now ?? SYSTEM_NOW;
  }

  public async resolve(
    params: ResolveManifestationParams
  ): Promise<readonly Readonly<ManifestationDecision>[]> {
    const decidedAt = this.now();
    const config = await this.loadConfig(params.workspaceId, decidedAt);
    const orderedCandidates = validateActivationCandidates(params.candidates)
      .filter(
        (candidate) =>
          candidate.workspace_id === params.workspaceId && candidate.run_id === params.runId
      )
      .sort(compareCandidatesForDeterministicEvaluation);
    const initialBudget: BudgetState = Object.freeze({
      stance_bias: config.stance_bias_cap,
      dialogue_nudge: config.dialogue_nudge_cap,
      lens_entry: config.lens_entry_cap
    });
    const { decisions } = orderedCandidates.reduce<{
      readonly budgets: BudgetState;
      readonly decisions: readonly Readonly<ManifestationDecision>[];
    }>(
      (state, candidate) => {
        const evaluation = this.evaluateCandidate(
          candidate,
          config,
          params.taskSurfaceRef,
          state.budgets
        );

        return {
          budgets: evaluation.nextBudget,
          decisions: Object.freeze([...state.decisions, evaluation.decision])
        };
      },
      {
        budgets: initialBudget,
        decisions: Object.freeze([])
      }
    );

    await this.deps.eventLogWriter.append({
      event_type: RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED,
      entity_type: "manifestation_budget",
      entity_id: params.runId,
      workspace_id: params.workspaceId,
      run_id: params.runId,
      caused_by: "deterministic_rule",
      revision: 0,
      payload_json: ManifestationBudgetEvaluatedPayloadSchema.parse({
        workspace_id: params.workspaceId,
        run_id: params.runId,
        total_candidates: orderedCandidates.length,
        stance_bias_assigned: countAssigned(decisions, ManifestationLevel.STANCE_BIAS),
        dialogue_nudge_assigned: countAssigned(decisions, ManifestationLevel.DIALOGUE_NUDGE),
        lens_entry_assigned: countAssigned(decisions, ManifestationLevel.LENS_ENTRY),
        discarded: decisions.filter((decision) => decision.assigned_level === null).length,
        evaluated_at: decidedAt
      })
    });
    // Keep the live path append order explicit: consumers should never observe
    // a decision batch before the aggregate budget evaluation for the same run.
    await this.deps.eventLogWriter.append({
      event_type: RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED,
      entity_type: "manifestation_decision_batch",
      entity_id: params.runId,
      workspace_id: params.workspaceId,
      run_id: params.runId,
      caused_by: "deterministic_rule",
      revision: 0,
      payload_json: ManifestationEscalationDecidedPayloadSchema.parse({
        workspace_id: params.workspaceId,
        run_id: params.runId,
        decisions: decisions.map((decision) => ({
          candidate_id: decision.candidate_id,
          assigned_level: decision.assigned_level,
          reason: decision.reason
        })),
        decided_at: decidedAt
      })
    });

    return Object.freeze(decisions);
  }

  private evaluateCandidate(
    candidate: Readonly<ActivationCandidate>,
    config: Readonly<ManifestationBudgetConfig>,
    taskSurfaceRef: Readonly<TaskObjectSurface> | null,
    budgets: BudgetState
  ): Readonly<{
    readonly decision: Readonly<ManifestationDecision>;
    readonly nextBudget: BudgetState;
  }> {
    const desiredLevel = determineDesiredLevel(candidate, config, taskSurfaceRef);
    const allocation = allocateBudget(desiredLevel.level, budgets);
    const reason = buildDecisionReason({
      assignedLevel: allocation.assignedLevel,
      exhaustedLevels: allocation.exhaustedLevels,
      blockedReason: desiredLevel.lens.blockedReason
    });

    return Object.freeze({
      decision: ManifestationDecisionSchema.parse({
        candidate_id: candidate.candidate_id,
        source_path_id: candidate.source_path_id,
        assigned_level: allocation.assignedLevel,
        reason,
        budget_remaining: allocation.remainingBudget
      }),
      nextBudget: allocation.remainingBudget
    });
  }

  private async loadConfig(
    workspaceId: string,
    nowIso: string
  ): Promise<Readonly<ManifestationBudgetConfig>> {
    const { value } = await loadOrDefaultWithWorkspaceGuard({
      workspaceId,
      load: () => this.deps.budgetConfigProvider.getConfig(workspaceId),
      parse: (config) => ManifestationBudgetConfigSchema.parse(config),
      createDefault: () => createDefaultManifestationBudgetConfig(workspaceId, nowIso),
      label: "Manifestation budget"
    });

    return value;
  }
}

function determineDesiredLevel(
  candidate: Readonly<ActivationCandidate>,
  config: Readonly<ManifestationBudgetConfig>,
  taskSurfaceRef: Readonly<TaskObjectSurface> | null
): {
  level: ManifestationLevelValue;
  lens: LensEligibility;
} {
  const nudgeEligible =
    normalizeUnit(candidate.pressure) >= config.escalation_policy.nudge_min_pressure &&
    normalizeUnit(candidate.confidence) >= config.escalation_policy.nudge_min_confidence;
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

function evaluateLensEligibility(
  candidate: Readonly<ActivationCandidate>,
  config: Readonly<ManifestationBudgetConfig>,
  taskSurfaceRef: Readonly<TaskObjectSurface> | null
): LensEligibility {
  const meetsLensStrength =
    normalizeUnit(candidate.pressure) >= config.escalation_policy.lens_min_pressure &&
    normalizeUnit(candidate.confidence) >= config.escalation_policy.lens_min_confidence;

  if (!meetsLensStrength) {
    return {
      eligible: false,
      blockedReason: null
    };
  }

  if (
    config.escalation_policy.lens_requires_task_coupling &&
    taskSurfaceRef === null
  ) {
    return {
      eligible: false,
      blockedReason: "task_surface_ref_missing"
    };
  }

  if (
    config.escalation_policy.lens_requires_task_coupling &&
    taskSurfaceRef !== null &&
    !hasTaskCoupling(candidate, taskSurfaceRef)
  ) {
    return {
      eligible: false,
      blockedReason: "task_coupling"
    };
  }

  if (
    config.escalation_policy.lens_requires_governance_ceiling &&
    !governanceAllowsLens(candidate.governance_ceiling)
  ) {
    return {
      eligible: false,
      blockedReason: "governance_ceiling"
    };
  }

  return {
    eligible: true,
    blockedReason: null
  };
}

function governanceAllowsLens(governanceCeiling: ActivationCandidate["governance_ceiling"]): boolean {
  return governanceOrder[governanceCeiling] >= governanceOrder[PathGovernanceClass.RECALL_ALLOWED];
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

function allocateBudget(
  desiredLevel: ManifestationLevelValue,
  budgets: BudgetState
): BudgetAllocationResult {
  const fallbackOrder = getAllocationOrder(desiredLevel);
  const exhaustedLevels: ManifestationLevelValue[] = [];
  let nextBudget = budgets;

  for (const level of fallbackOrder) {
    if (nextBudget[level] > 0) {
      nextBudget = Object.freeze({
        ...nextBudget,
        [level]: nextBudget[level] - 1
      });
      return Object.freeze({
        assignedLevel: level,
        exhaustedLevels: Object.freeze([...exhaustedLevels]),
        remainingBudget: nextBudget
      });
    }

    exhaustedLevels.push(level);
  }

  return Object.freeze({
    assignedLevel: null,
    exhaustedLevels: Object.freeze([...exhaustedLevels]),
    remainingBudget: nextBudget
  });
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

function buildDecisionReason(input: {
  assignedLevel: ManifestationLevelValue | null;
  exhaustedLevels: readonly ManifestationLevelValue[];
  blockedReason: LensEligibility["blockedReason"];
}): string {
  const details: string[] = [];

  if (input.assignedLevel === null) {
    const lastExhausted = input.exhaustedLevels[input.exhaustedLevels.length - 1] ?? ManifestationLevel.STANCE_BIAS;
    return `discarded:${lastExhausted}_budget_exhausted`;
  }

  details.push(`assigned:${input.assignedLevel}`);

  for (const exhaustedLevel of input.exhaustedLevels) {
    details.push(`downgraded:${exhaustedLevel}_budget_exhausted`);
  }

  if (input.blockedReason !== null) {
    details.push(`blocked:${input.blockedReason}`);
  }

  return details.join("; ");
}

function countAssigned(
  decisions: readonly Readonly<ManifestationDecision>[],
  level: ManifestationLevelValue
): number {
  return decisions.filter((decision) => decision.assigned_level === level).length;
}

function compareCandidatesForDeterministicEvaluation(
  left: Readonly<ActivationCandidate>,
  right: Readonly<ActivationCandidate>
): number {
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

function scoreCandidate(candidate: Readonly<ActivationCandidate>): number {
  return normalizeUnit(candidate.pressure) * normalizeUnit(candidate.confidence);
}

function createDefaultManifestationBudgetConfig(
  workspaceId: string,
  nowIso: string
): Readonly<ManifestationBudgetConfig> {
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
    updated_at: nowIso
  });
}

function unreachableManifestationLevel(value: never): never {
  throw new Error(`Unhandled manifestation level: ${String(value)}`);
}
