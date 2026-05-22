import {
  DYNAMICS_CONSTANTS,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type ConsolidationCyclePlan,
  type ConsolidationCycleResult,
  type ConsolidationTriggerBudget,
  type ConsolidationTriggerSource,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { EventPublisher, type EventPublisherInput } from "./event-publisher.js";

const CONSOLIDATION_FUSE_MAX_RETRIES = DYNAMICS_CONSTANTS.path_plasticity.consolidation_fuse_max_retries;
const CONSOLIDATION_FUSE_COOLDOWN_MS = DYNAMICS_CONSTANTS.path_plasticity.consolidation_fuse_cooldown_ms;

/**
 * Subset of `PathRelationRepo` the executor needs. `update` must be the
 * synchronous variant so the EventLog append and the path-relation mutation
 * commit inside one `appendManyWithMutation` SQLite transaction.
 *
 * see also: packages/storage/src/repos/path-relation-repo.ts
 */
export interface ConsolidationPathRelationPort {
  findById(pathId: string): Promise<Readonly<PathRelation> | null>;
  update(
    pathId: string,
    updates: Partial<
      Pick<PathRelation, "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at">
    >
  ): Readonly<PathRelation>;
}

/**
 * Read/write port for the `consolidation_trigger_budgets` table
 * (migration 035). `attempts_used` is a rolling per-window counter — it
 * climbs per charged cycle and restarts at 1 once the window (bounded by
 * `cooldown_until`) has elapsed. `cooldown_until` gates re-entry per trigger
 * source and also marks the window boundary.
 *
 * see also: packages/storage/src/migrations/035-consolidation-trigger-budgets.sql
 */
export interface ConsolidationBudgetStorePort {
  findByTriggerSource(
    triggerSource: ConsolidationTriggerSource
  ): Promise<ConsolidationTriggerBudget | null>;
  upsert(budget: ConsolidationTriggerBudget): Promise<void>;
}

export interface ConsolidationExecutorDependencies {
  readonly pathRelationRepo: ConsolidationPathRelationPort;
  readonly budgetStore: ConsolidationBudgetStorePort;
  readonly eventPublisher: EventPublisher;
  readonly now?: () => string;
}

export interface ConsolidationCycleInput {
  /**
   * Which budget bucket this cycle is charged against. The five values
   * mirror the `trigger_source` CHECK in migration 035.
   */
  readonly triggerSource: ConsolidationTriggerSource;
  readonly plan: ConsolidationCyclePlan;
}

interface PreparedMutation {
  readonly pathId: string;
  readonly updates: Partial<
    Pick<PathRelation, "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at">
  >;
}

/**
 * ConsolidationExecutor consumes a `ConsolidationCyclePlan` and applies its
 * planned PathRelation structural mutations — stability promotions,
 * retirements, governance-class changes, and direction-bias changes — in a
 * single transactional batch, then emits a `PATH_CONSOLIDATION_COMPLETED`
 * event and returns a `ConsolidationCycleResult`.
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
    const { plan, triggerSource } = input;
    const occurredAt = this.now();
    const occurredAtMs = Date.parse(occurredAt);

    const budget = await this.dependencies.budgetStore.findByTriggerSource(triggerSource);

    const cooldownUntilMs = budget === null ? null : Date.parse(budget.cooldown_until);
    const cooldownActive =
      cooldownUntilMs !== null &&
      Number.isFinite(cooldownUntilMs) &&
      cooldownUntilMs > occurredAtMs;
    if (cooldownActive) {
      return this.refuse({
        plan,
        budget,
        reason: `Consolidation budget cooldown active until ${budget!.cooldown_until}.`,
        occurredAt,
        outcome: "cooldown_active"
      });
    }

    // `cooldown_until` doubles as the rolling-window boundary: once it has
    // lapsed the prior window has elapsed and `attempts_used` no longer gates
    // a new cycle. The exhaustion check below is skipped when the window has
    // elapsed, and `chargeAttempt` restarts the count at 1. Without this the
    // maxed counter behind an expired cooldown would re-trip the fuse forever.
    const windowElapsed =
      budget === null ||
      cooldownUntilMs === null ||
      !Number.isFinite(cooldownUntilMs) ||
      cooldownUntilMs <= occurredAtMs;

    const attemptsUsed = budget?.attempts_used ?? 0;
    const maxAttempts = budget?.max_attempts_within_window ?? CONSOLIDATION_FUSE_MAX_RETRIES;
    if (!windowElapsed && attemptsUsed >= maxAttempts) {
      return this.refuse({
        plan,
        budget,
        reason: `Consolidation budget exhausted: ${attemptsUsed}/${maxAttempts} attempts used.`,
        occurredAt,
        outcome: "tripped"
      });
    }

    // The plan itself may carry an already-blown fuse — honor it without
    // spending an attempt on a cycle the planner has already abandoned.
    if (plan.fuse_state.blown) {
      return this.refuse({
        plan,
        budget,
        reason: plan.fuse_state.reason ?? "Consolidation cycle plan fuse already blown.",
        occurredAt,
        outcome: "tripped"
      });
    }

    const mutations = await this.prepareMutations(plan, occurredAt);

    const consumedBudget = this.chargeAttempt(budget, triggerSource, occurredAtMs, windowElapsed);

    const completedEvent: EventPublisherInput = {
      event_type: RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED,
      entity_type: "workspace",
      entity_id: plan.workspace_id,
      workspace_id: plan.workspace_id,
      run_id: null,
      caused_by: "consolidation-executor",
      payload_json: parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED,
        {
          workspace_id: plan.workspace_id,
          paths_reinforced: 0,
          paths_weakened: 0,
          paths_retired: plan.retirements.length,
          stability_promotions: plan.promotions.length,
          duration_ms: Math.max(0, Date.parse(this.now()) - occurredAtMs),
          completed_at: occurredAt
        }
      )
    };

    this.dependencies.eventPublisher.appendManyWithMutationAndDetachPropagation(
      [completedEvent],
      () => {
        for (const mutation of mutations) {
          this.dependencies.pathRelationRepo.update(mutation.pathId, mutation.updates);
        }
      }
    );

    // The attempt is charged only after the event-log + path-mutation
    // transaction commits. If `prepareMutations` or the transaction throws,
    // this line is unreachable, so a failed cycle never burns budget without
    // a matching PATH_CONSOLIDATION_COMPLETED audit event.
    await this.dependencies.budgetStore.upsert(consumedBudget);

    return Object.freeze({
      workspace_id: plan.workspace_id,
      committed_at: occurredAt,
      promotions_committed: plan.promotions.length,
      retirements_committed: plan.retirements.length,
      governance_changes_committed: plan.governance_changes.length,
      direction_changes_committed: plan.direction_changes.length,
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
      fuse_outcome: params.outcome
    } satisfies ConsolidationCycleResult);
  }
}
