import {
    ManifestationBudgetConfigSchema,
    ManifestationDecisionSchema,
    type ActivationCandidate,
    type ManifestationBudgetConfig,
    type ManifestationDecision,
    type TaskObjectSurface
  } from "@do-soul/alaya-protocol";
import { loadOrDefaultWithWorkspaceGuard } from "../shared/load-or-default-with-workspace-guard.js";
import { validateActivationCandidates } from "../shared/validated-activation-candidates.js";
import { appendManifestationGovernanceEvents } from "./manifestation-event-writer.js";
import {
  SYSTEM_NOW,
  allocateBudget,
  anchorMemoryObjectId,
  buildDecisionReason,
  compareCandidatesForDeterministicEvaluation,
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
    const decisions = this.evaluateCandidates(
      orderedCandidates,
      config,
      params.taskSurfaceRef,
      initialBudget
    );

    await appendManifestationGovernanceEvents({
      eventLogWriter: this.deps.eventLogWriter,
      workspaceId: params.workspaceId,
      runId: params.runId,
      decisions,
      decidedAt
    });
    return decisions;
  }

  private evaluateCandidates(
    candidates: readonly Readonly<ActivationCandidate>[],
    config: Readonly<ManifestationBudgetConfig>,
    taskSurfaceRef: Readonly<TaskObjectSurface> | null,
    initialBudget: BudgetState
  ): readonly Readonly<ManifestationDecision>[] {
    const { decisions } = candidates.reduce<{
      readonly budgets: BudgetState;
      readonly decisions: readonly Readonly<ManifestationDecision>[];
    }>(
      (state, candidate) => {
        const evaluation = this.evaluateCandidate(
          candidate,
          config,
          taskSurfaceRef,
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
