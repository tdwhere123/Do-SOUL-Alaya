import {
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type ConsolidationCycleResult,
  type ConsolidationCyclePlan,
  type ConsolidationTriggerBudget,
  type ConsolidationTriggerSource,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { type EventPublisherInput } from "../runtime/event-publisher.js";
import {
  isConsolidationDeletable,
  isConsolidationSurvivorEligible
} from "../manifestation/importance-gate.js";
import {
  CONSOLIDATION_FUSE_COOLDOWN_MS,
  CONSOLIDATION_FUSE_MAX_RETRIES,
  assertNoPathIdOverlap,
  concatMergeEvidence,
  concatMergeWhy,
  isDormantAtApply,
  summarizeMergedLoser,
  type ConsolidationCycleInput,
  type ConsolidationExecutorDependencies,
  type PreparedMerge,
  type PreparedMutation
} from "./consolidation-executor-shared.js";
export type {
  ConsolidationBudgetStorePort,
  ConsolidationCycleInput,
  ConsolidationExecutorDependencies,
  ConsolidationPathRelationPort
} from "./consolidation-executor-shared.js";

interface ConsolidationCycleContext {
  readonly plan: ConsolidationCyclePlan;
  readonly triggerSource: ConsolidationTriggerSource;
  readonly occurredAt: string;
  readonly occurredAtMs: number;
  readonly budget: ConsolidationTriggerBudget | null;
  readonly cooldownUntilMs: number | null;
  readonly windowElapsed: boolean;
}

interface PreparedConsolidationCycle {
  readonly mutations: readonly PreparedMutation[];
  readonly merges: readonly PreparedMerge[];
  readonly mergedLoserCount: number;
  readonly consumedBudget: ConsolidationTriggerBudget;
  readonly events: readonly EventPublisherInput[];
}

/**
 * ConsolidationExecutor consumes a `ConsolidationCyclePlan` and applies its
 * planned PathRelation structural mutations — stability promotions,
 * retirements, governance-class changes, direction-bias changes, and merges
 * (fold dormant duplicates into an evidence-richest survivor and delete the
 * losers) — in a single transactional batch, then emits one
 * `PATH_RELATION_MERGED` event per merge plus a `PATH_CONSOLIDATION_COMPLETED`
 * event, and returns a `ConsolidationCycleResult`.
 *
 * Budget: every committed cycle is charged against the
 * `consolidation_trigger_budgets` row for its trigger source. When the row's
 * cooldown is still active, or `max_attempts_within_window` is exhausted
 * within an unexpired window, the executor refuses the cycle, sets
 * `fuse_state.blown`, persists the cooldown, and emits
 * `PATH_CONSOLIDATION_FUSED`. The attempt counter is a rolling window — it
 * restarts at 1 once `cooldown_until` lapses — so a fused trigger source
 * recovers rather than wedging permanently. The charge is committed only
 * after the event-log + path-mutation transaction, so a failed cycle never
 * burns budget without a matching completed event.
 *
 * This operates strictly on PathRelation lifecycle. It does NOT touch
 * synthesis-capsule promotion (migration 072 retired that separate ladder).
 */
export class ConsolidationExecutor {
  private readonly now: () => string;

  public constructor(private readonly dependencies: ConsolidationExecutorDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async runCycle(input: ConsolidationCycleInput): Promise<ConsolidationCycleResult> {
    const context = await this.createCycleContext(input);
    const refused = await this.refuseBlockedCycle(context);
    if (refused !== null) {
      return refused;
    }
    assertNoPathIdOverlap(context.plan);
    const prepared = await this.prepareConsolidationCycle(context);
    this.commitPreparedCycle(prepared);
    await this.dependencies.budgetStore.upsert(prepared.consumedBudget);
    return this.completedCycleResult(context, prepared);
  }

  private async createCycleContext(input: ConsolidationCycleInput): Promise<ConsolidationCycleContext> {
    const occurredAt = this.now();
    const occurredAtMs = Date.parse(occurredAt);
    const budget = await this.dependencies.budgetStore.findByTriggerSource(input.triggerSource);
    const cooldownUntilMs = this.parseCooldownUntilMs(budget);
    return Object.freeze({
      plan: input.plan,
      triggerSource: input.triggerSource,
      occurredAt,
      occurredAtMs,
      budget,
      cooldownUntilMs,
      windowElapsed: budget === null || cooldownUntilMs === null || !Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= occurredAtMs
    });
  }

  private async refuseBlockedCycle(context: ConsolidationCycleContext): Promise<ConsolidationCycleResult | null> {
    if (context.cooldownUntilMs !== null && Number.isFinite(context.cooldownUntilMs) && context.cooldownUntilMs > context.occurredAtMs && context.budget !== null) {
      return this.refuse({ plan: context.plan, budget: context.budget, reason: `Consolidation budget cooldown active until ${context.budget.cooldown_until}.`, occurredAt: context.occurredAt, outcome: "cooldown_active" });
    }
    const attemptsUsed = context.budget?.attempts_used ?? 0;
    const maxAttempts = context.budget?.max_attempts_within_window ?? CONSOLIDATION_FUSE_MAX_RETRIES;
    if (!context.windowElapsed && attemptsUsed >= maxAttempts) {
      return this.refuse({ plan: context.plan, budget: context.budget, reason: `Consolidation budget exhausted: ${attemptsUsed}/${maxAttempts} attempts used.`, occurredAt: context.occurredAt, outcome: "tripped" });
    }
    if (context.plan.fuse_state.blown) {
      return this.refuse({ plan: context.plan, budget: context.budget, reason: context.plan.fuse_state.reason ?? "Consolidation cycle plan fuse already blown.", occurredAt: context.occurredAt, outcome: "tripped" });
    }
    return null;
  }

  private async prepareConsolidationCycle(context: ConsolidationCycleContext): Promise<PreparedConsolidationCycle> {
    const mutations = await this.prepareMutations(context.plan, context.occurredAt);
    const merges = await this.prepareMerges(context.plan, context.occurredAt);
    const mergedLoserCount = merges.reduce((total, merge) => total + merge.loserPathIds.length, 0);
    return Object.freeze({
      mutations,
      merges,
      mergedLoserCount,
      consumedBudget: this.chargeAttempt(context.budget, context.triggerSource, context.occurredAtMs, context.windowElapsed),
      events: Object.freeze([
        ...this.buildMergeEvents(context.plan, merges, context.occurredAt),
        this.buildCompletedEvent(context, mergedLoserCount)
      ])
    });
  }

  private buildMergeEvents(plan: ConsolidationCyclePlan, merges: readonly PreparedMerge[], occurredAt: string): readonly EventPublisherInput[] {
    return merges.map((merge) => ({
      event_type: RuntimeGovernanceEventType.PATH_RELATION_MERGED,
      entity_type: "path_relation",
      entity_id: merge.survivorPathId,
      workspace_id: plan.workspace_id,
      run_id: null,
      caused_by: "consolidation-executor",
      payload_json: parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_MERGED, {
        survivor_path_id: merge.survivorPathId,
        merged_path_ids: merge.loserPathIds,
        relation_kind: merge.relationKind,
        survivor_why_entry_count: merge.survivorWhyEntryCount,
        merged_losers: merge.mergedLosers,
        merged_at: occurredAt
      })
    }));
  }

  private buildCompletedEvent(context: ConsolidationCycleContext, mergedLoserCount: number): EventPublisherInput {
    return {
      event_type: RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED,
      entity_type: "workspace",
      entity_id: context.plan.workspace_id,
      workspace_id: context.plan.workspace_id,
      run_id: null,
      caused_by: "consolidation-executor",
      payload_json: parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED, {
        workspace_id: context.plan.workspace_id,
        paths_reinforced: 0,
        paths_weakened: 0,
        paths_retired: context.plan.retirements.length + mergedLoserCount,
        stability_promotions: context.plan.promotions.length,
        duration_ms: Math.max(0, Date.parse(this.now()) - context.occurredAtMs),
        completed_at: context.occurredAt
      })
    };
  }

  private commitPreparedCycle(prepared: PreparedConsolidationCycle): void {
    this.dependencies.eventPublisher.appendManyWithMutationAndDetachPropagation(prepared.events, () => {
      for (const mutation of prepared.mutations) {
        this.dependencies.pathRelationRepo.update(mutation.pathId, mutation.updates);
      }
      for (const merge of prepared.merges) {
        this.dependencies.pathRelationRepo.update(merge.survivorPathId, merge.survivorUpdates);
        for (const loserPathId of merge.loserPathIds) {
          this.dependencies.pathRelationRepo.delete(loserPathId);
        }
      }
    });
  }

  private completedCycleResult(context: ConsolidationCycleContext, prepared: PreparedConsolidationCycle): ConsolidationCycleResult {
    return Object.freeze({
      workspace_id: context.plan.workspace_id,
      committed_at: context.occurredAt,
      promotions_committed: context.plan.promotions.length,
      retirements_committed: context.plan.retirements.length,
      governance_changes_committed: context.plan.governance_changes.length,
      direction_changes_committed: context.plan.direction_changes.length,
      merges_committed: prepared.merges.length,
      fuse_outcome: "ok"
    } satisfies ConsolidationCycleResult);
  }

  private async prepareMutations(
    plan: ConsolidationCyclePlan,
    occurredAt: string
  ): Promise<readonly PreparedMutation[]> {
    const mutations: PreparedMutation[] = [];

    for (const promotion of plan.promotions) {
      const path = await this.requirePath(plan.workspace_id, promotion.path_id);
      mutations.push({
        pathId: path.path_id,
        updates: {
          plasticity_state: { ...path.plasticity_state, stability_class: promotion.to_stability },
          updated_at: occurredAt
        }
      });
    }

    for (const change of plan.governance_changes) {
      const path = await this.requirePath(plan.workspace_id, change.path_id);
      mutations.push({
        pathId: path.path_id,
        updates: {
          legitimacy: { ...path.legitimacy, governance_class: change.to_class },
          updated_at: occurredAt
        }
      });
    }

    for (const change of plan.direction_changes) {
      const path = await this.requirePath(plan.workspace_id, change.path_id);
      mutations.push({
        pathId: path.path_id,
        updates: {
          plasticity_state: { ...path.plasticity_state, direction_bias: change.to_bias },
          updated_at: occurredAt
        }
      });
    }

    for (const retirement of plan.retirements) {
      const path = await this.requirePath(plan.workspace_id, retirement.path_id);
      mutations.push({
        pathId: path.path_id,
        updates: {
          lifecycle: { ...path.lifecycle, status: "retired" },
          updated_at: occurredAt
        }
      });
    }

    return Object.freeze(mutations);
  }

  // invariant: a merge keeps the survivor and absorbs every loser's
  // why_this_relation_exists provenance (deduped, bounded), then deletes the
  // losers. The survivor must retain its own evidence first, so the concat is
  // ordered survivor-why ++ losers-why and truncated only past the survivor's
  // own entries — the survivor never loses its provenance to the bound, and the
  // full destroyed loser provenance is recorded in the PATH_RELATION_MERGED
  // event.
  // invariant: defence-in-depth at the deletion authority. The plan is an
  // externally-constructable protocol object with no protection contract, so
  // the executor re-runs the SHARED importance gate at the delete site rather
  // than trusting the plan's survivor/loser split: every survivor must pass
  // isConsolidationSurvivorEligible and every loser must pass
  // isConsolidationDeletable AND still be dormant-at-apply (closing the TOCTOU
  // window where a loser became pinned / strictly_governed / active between
  // plan emission and commit). A violation throws before the budget charge.
  // see also: packages/core/src/manifestation/importance-gate.ts (shared gate).
  private async prepareMerges(
    plan: ConsolidationCyclePlan,
    occurredAt: string
  ): Promise<readonly PreparedMerge[]> {
    const merges: PreparedMerge[] = [];

    for (const merge of plan.merges ?? []) {
      const survivor = await this.requirePath(plan.workspace_id, merge.survivor_path_id);
      if (!isConsolidationSurvivorEligible(survivor)) {
        throw new Error(
          `Consolidation merge survivor ${survivor.path_id} is not survivor-eligible ` +
            `(protected / report_only paths must not absorb other paths).`
        );
      }

      // A survivor that lists itself as a loser is an id overlap, already
      // rejected by assertNoPathIdOverlap before any path is loaded.
      const loserPaths: Readonly<PathRelation>[] = [];
      for (const loserPathId of merge.merged_path_ids) {
        const loser = await this.requirePath(plan.workspace_id, loserPathId);
        if (!isConsolidationDeletable(loser)) {
          throw new Error(
            `Consolidation merge loser ${loser.path_id} is protected from deletion ` +
              `(pinned / strictly_governed / evidence-rich / well-supported paths are never merged away).`
          );
        }
        if (!isDormantAtApply(loser)) {
          throw new Error(
            `Consolidation merge loser ${loser.path_id} is no longer dormant at apply time; refusing to delete.`
          );
        }
        loserPaths.push(loser);
      }

      if (loserPaths.length === 0) {
        continue;
      }

      const mergedWhy = concatMergeWhy(survivor, loserPaths);

      merges.push({
        survivorPathId: survivor.path_id,
        survivorUpdates: {
          constitution: {
            ...survivor.constitution,
            why_this_relation_exists: mergedWhy
          },
          // Absorb the losers' evidence sources too (deduped, bounded) so the
          // survivor honours "durable memory needs source + evidence" after
          // the losers are deleted.
          legitimacy: {
            ...survivor.legitimacy,
            evidence_basis: concatMergeEvidence(survivor, loserPaths)
          },
          updated_at: occurredAt
        },
        loserPathIds: Object.freeze(loserPaths.map((path) => path.path_id)),
        relationKind: survivor.constitution.relation_kind,
        survivorWhyEntryCount: mergedWhy.length,
        mergedLosers: Object.freeze(loserPaths.map(summarizeMergedLoser))
      });
    }

    return Object.freeze(merges);
  }

  private async requirePath(
    workspaceId: string,
    pathId: string
  ): Promise<Readonly<PathRelation>> {
    const path = await this.dependencies.pathRelationRepo.findById(pathId);
    if (path === null) {
      throw new Error(`Consolidation cycle references missing path relation ${pathId}.`);
    }
    if (path.workspace_id !== workspaceId) {
      throw new Error(
        `Consolidation cycle path relation ${pathId} escaped workspace ${workspaceId}.`
      );
    }
    return path;
  }

  private chargeAttempt(
    budget: ConsolidationTriggerBudget | null,
    triggerSource: ConsolidationTriggerSource,
    occurredAtMs: number,
    windowElapsed: boolean
  ): ConsolidationTriggerBudget {
    if (budget === null) {
      return Object.freeze({
        trigger_id: `consolidation-${triggerSource}`,
        trigger_source: triggerSource,
        max_attempts_within_window: CONSOLIDATION_FUSE_MAX_RETRIES,
        attempts_used: 1,
        cooldown_until: new Date(occurredAtMs).toISOString()
      });
    }
    // `max_attempts_within_window` is a rolling cap, not a lifetime cap.
    // When the prior window has elapsed (`windowElapsed`, decided by
    // `runCycle` from `cooldown_until`) the count restarts at 1 instead of
    // incrementing, so a fused trigger source recovers once its window
    // passes. Without this reset the counter only ever climbs and the
    // trigger source wedges permanently after the first window fills.
    return Object.freeze({
      ...budget,
      attempts_used: windowElapsed ? 1 : budget.attempts_used + 1
    });
  }

  private async refuse(params: {
    readonly plan: ConsolidationCyclePlan;
    readonly budget: ConsolidationTriggerBudget | null;
    readonly reason: string;
    readonly occurredAt: string;
    readonly outcome: Exclude<ConsolidationCycleResult["fuse_outcome"], "ok">;
  }): Promise<ConsolidationCycleResult> {
    const retryCount = (params.plan.fuse_state.retry_count ?? 0) + 1;
    const cooldownUntil = new Date(
      Date.parse(params.occurredAt) + CONSOLIDATION_FUSE_COOLDOWN_MS
    ).toISOString();

    // Blowing the fuse persists the cooldown into the budget row so a
    // subsequent cycle for the same trigger source is gated until it lapses.
    if (params.budget !== null) {
      await this.dependencies.budgetStore.upsert(
        Object.freeze({
          ...params.budget,
          cooldown_until: cooldownUntil
        })
      );
    }

    this.dependencies.eventPublisher.appendManyWithMutationAndDetachPropagation(
      [
        {
          event_type: RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED,
          entity_type: "workspace",
          entity_id: params.plan.workspace_id,
          workspace_id: params.plan.workspace_id,
          run_id: null,
          caused_by: "consolidation-executor",
          payload_json: parseRuntimeGovernanceEventPayload(
            RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED,
            {
              workspace_id: params.plan.workspace_id,
              reason: params.reason,
              retry_count: retryCount,
              cooldown_until: cooldownUntil,
              fused_at: params.occurredAt
            }
          )
        }
      ],
      () => undefined
    );

    return Object.freeze({
      workspace_id: params.plan.workspace_id,
      committed_at: params.occurredAt,
      promotions_committed: 0,
      retirements_committed: 0,
      governance_changes_committed: 0,
      direction_changes_committed: 0,
      merges_committed: 0,
      fuse_outcome: params.outcome
    } satisfies ConsolidationCycleResult);
  }

  private parseCooldownUntilMs(
    budget: Readonly<ConsolidationTriggerBudget> | null
  ): number | null {
    if (budget === null) {
      return null;
    }
    const parsed = Date.parse(budget.cooldown_until);
    if (!Number.isFinite(parsed)) {
      throw new Error("Consolidation budget row is missing a valid cooldown_until timestamp.");
    }
    return parsed;
  }
}

// Survivor-first, deduped, bounded concat of why_this_relation_exists. The
// survivor's own entries always lead and are never truncated away (the bound
// only trims absorbed loser provenance once the cap is reached); the schema
// requires non-empty strings, so empty entries are filtered.
