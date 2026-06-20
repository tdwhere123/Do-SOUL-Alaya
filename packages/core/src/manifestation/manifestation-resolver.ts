import {
  DYNAMICS_CONSTANTS,
    ManifestationBudgetEvaluatedPayloadSchema,
    ManifestationBudgetConfigSchema,
    ManifestationDecisionSchema,
    ManifestationEscalationDecidedPayloadSchema,
    ManifestationLevel,
    RuntimeGovernanceEventType,
    type ActivationCandidate,
    type EventLogEntry,
    type ManifestationBudgetConfig,
    type ManifestationDecision,
    type ManifestationLevel as ManifestationLevelValue,
    type TaskObjectSurface
  } from "@do-soul/alaya-protocol";
import { loadOrDefaultWithWorkspaceGuard } from "../shared/load-or-default-with-workspace-guard.js";
import { validateActivationCandidates } from "../shared/validated-activation-candidates.js";
import {
  SYSTEM_NOW,
  allocateBudget,
  anchorMemoryObjectId,
  buildDecisionReason,
  compareCandidatesForDeterministicEvaluation,
  countAssigned,
  createDefaultManifestationBudgetConfig,
  determineDesiredLevel
} from "./manifestation-resolver-helpers.js";
import type {
  BudgetState,
  ManifestationBiasSidecarEntry,
  ManifestationResolverDependencies,
  ResolveManifestationParams,
  ResolveManifestationWithBiasResult
} from "./manifestation-resolver-types.js";
export type {
  ManifestationBiasSidecarEntry,
  ManifestationBudgetConfigProviderPort,
  ManifestationResolverDependencies,
  ManifestationResolverEventLogWriterPort,
  ResolveManifestationParams,
  ResolveManifestationWithBiasResult
} from "./manifestation-resolver-types.js";

export class ManifestationResolver {
  private readonly now: () => string;

  public constructor(private readonly deps: ManifestationResolverDependencies) {
    this.now = deps.now ?? SYSTEM_NOW;
  }

  // Extension surface: returns the same decisions as resolve() plus an
  // additive bias sidecar that downstream callers (recall sidecar
  // assembly, Auditor scheduling) consume without reaching back into
  // PathRelation rows. Keeping resolve() shape unchanged preserves the
  // existing consumer contract.
  public async resolveWithBias(
    params: ResolveManifestationParams
  ): Promise<Readonly<ResolveManifestationWithBiasResult>> {
    const decisions = await this.resolve(params);
    const decisionIndex = new Map<string, Readonly<ManifestationDecision>>();
    for (const decision of decisions) {
      decisionIndex.set(decision.candidate_id, decision);
    }

    const biasSidecar: Readonly<ManifestationBiasSidecarEntry>[] = [];
    for (const candidate of params.candidates) {
      if (
        candidate.workspace_id !== params.workspaceId ||
        candidate.run_id !== params.runId
      ) {
        continue;
      }
      if (!decisionIndex.has(candidate.candidate_id)) {
        continue;
      }
      const targetMemoryId = anchorMemoryObjectId(candidate.target_anchor);
      const unfinishednessBias = candidate.effect_vector_snapshot.unfinishedness_bias;
      const verificationBias = candidate.effect_vector_snapshot.verification_bias;
      biasSidecar.push(
        Object.freeze({
          candidate_id: candidate.candidate_id,
          target_memory_object_id: targetMemoryId,
          unfinishedness_bias: unfinishednessBias,
          pending_incomplete: unfinishednessBias > 0,
          verification_bias: verificationBias
        })
      );
    }

    return Object.freeze({
      decisions,
      biasSidecar: Object.freeze(biasSidecar)
    });
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
    const allocation = allocateBudget(desiredLevel.level, budgets, candidate.governance_ceiling);
    const reason = buildDecisionReason({
      assignedLevel: allocation.assignedLevel,
      exhaustedLevels: allocation.exhaustedLevels,
      blockedReason: desiredLevel.lens.blockedReason,
      governanceBlocked: allocation.governanceBlocked
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
