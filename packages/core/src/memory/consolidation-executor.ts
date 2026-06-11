import {
  DYNAMICS_CONSTANTS,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type ConsolidationCyclePlan,
  type ConsolidationCycleResult,
  type ConsolidationTriggerBudget,
  type ConsolidationTriggerSource,
  type MergedLoserRecallBiasSign,
  type PathRelation,
  type PathRelationMergedLoser
} from "@do-soul/alaya-protocol";
import { EventPublisher, type EventPublisherInput } from "../event-publisher.js";
import {
  isConsolidationDeletable,
  isConsolidationSurvivorEligible
} from "../manifestation/importance-gate.js";

const CONSOLIDATION_FUSE_MAX_RETRIES = DYNAMICS_CONSTANTS.path_plasticity.consolidation_fuse_max_retries;
const CONSOLIDATION_FUSE_COOLDOWN_MS = DYNAMICS_CONSTANTS.path_plasticity.consolidation_fuse_cooldown_ms;
const CONSOLIDATION_MERGE_WHY_MAX_ENTRIES =
  DYNAMICS_CONSTANTS.path_plasticity.consolidation_merge_why_max_entries;

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
      Pick<
        PathRelation,
        "constitution" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at"
      >
    >
  ): Readonly<PathRelation>;
  /**
   * Synchronous delete (the merge transaction deletes loser paths inside the
   * `appendManyWithMutation` sync-mutate callback). The SqlitePathRelationRepo
   * delete runs its statement synchronously; its Promise-typed signature is
   * assignable here and resolves after the sync body has already run.
   * see also: packages/storage/src/repos/path-relation-repo.ts delete.
   */
  delete(pathId: string): void;
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
    Pick<
      PathRelation,
      "constitution" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at"
    >
  >;
}

interface PreparedMerge {
  readonly survivorPathId: string;
  readonly survivorUpdates: Partial<
    Pick<PathRelation, "constitution" | "legitimacy" | "updated_at">
  >;
  readonly loserPathIds: readonly string[];
  readonly relationKind: string;
  readonly survivorWhyEntryCount: number;
  // invariant: full destroyed provenance of each deleted loser, recorded into
  // the PATH_RELATION_MERGED event so the deletion stays reconstructable past
  // the bounded survivor-row absorption.
  readonly mergedLosers: readonly PathRelationMergedLoser[];
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

    // Reject any path id that appears in more than one mutation lane (e.g. a
    // survivor that is also a loser, a loser shared by two merges, or a path in
    // both a merge and the retirements/promotions lists) before touching the
    // repo, so the transaction can never double-delete a path or apply a
    // survivor absorption update to an already-deleted row. Throwing here burns
    // no budget — the charge is strictly post-commit.
    assertNoPathIdOverlap(plan);

    const mutations = await this.prepareMutations(plan, occurredAt);
    const merges = await this.prepareMerges(plan, occurredAt);
    const mergedLoserCount = merges.reduce((total, merge) => total + merge.loserPathIds.length, 0);

    const consumedBudget = this.chargeAttempt(budget, triggerSource, occurredAtMs, windowElapsed);

    const mergeEvents: EventPublisherInput[] = merges.map((merge) => ({
      event_type: RuntimeGovernanceEventType.PATH_RELATION_MERGED,
      entity_type: "path_relation",
      entity_id: merge.survivorPathId,
      workspace_id: plan.workspace_id,
      run_id: null,
      caused_by: "consolidation-executor",
      payload_json: parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.PATH_RELATION_MERGED,
        {
          survivor_path_id: merge.survivorPathId,
          merged_path_ids: merge.loserPathIds,
          relation_kind: merge.relationKind,
          survivor_why_entry_count: merge.survivorWhyEntryCount,
          merged_losers: merge.mergedLosers,
          merged_at: occurredAt
        }
      )
    }));

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
          // Merge losers are retired-by-deletion, so they count toward the
          // retired tally alongside explicit retirements for the audit summary.
          paths_retired: plan.retirements.length + mergedLoserCount,
          stability_promotions: plan.promotions.length,
          duration_ms: Math.max(0, Date.parse(this.now()) - occurredAtMs),
          completed_at: occurredAt
        }
      )
    };

    this.dependencies.eventPublisher.appendManyWithMutationAndDetachPropagation(
      [...mergeEvents, completedEvent],
      () => {
        for (const mutation of mutations) {
          this.dependencies.pathRelationRepo.update(mutation.pathId, mutation.updates);
        }
        for (const merge of merges) {
          this.dependencies.pathRelationRepo.update(merge.survivorPathId, merge.survivorUpdates);
          for (const loserPathId of merge.loserPathIds) {
            this.dependencies.pathRelationRepo.delete(loserPathId);
          }
        }
      }
    );

    // The attempt is charged only after the event-log + path-mutation
    // transaction commits. If `prepareMutations`/`prepareMerges` or the
    // transaction throws, this line is unreachable, so a failed cycle never
    // burns budget without a matching PATH_CONSOLIDATION_COMPLETED audit event.
    await this.dependencies.budgetStore.upsert(consumedBudget);

    return Object.freeze({
      workspace_id: plan.workspace_id,
      committed_at: occurredAt,
      promotions_committed: plan.promotions.length,
      retirements_committed: plan.retirements.length,
      governance_changes_committed: plan.governance_changes.length,
      direction_changes_committed: plan.direction_changes.length,
      merges_committed: merges.length,
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
}

// Survivor-first, deduped, bounded concat of why_this_relation_exists. The
// survivor's own entries always lead and are never truncated away (the bound
// only trims absorbed loser provenance once the cap is reached); the schema
// requires non-empty strings, so empty entries are filtered.
function concatMergeWhy(
  survivor: Readonly<PathRelation>,
  losers: readonly Readonly<PathRelation>[]
): readonly string[] {
  return dedupeBounded(
    survivor.constitution.why_this_relation_exists,
    losers.flatMap((loser) => loser.constitution.why_this_relation_exists)
  );
}

// Survivor-first, deduped, bounded union of evidence_basis. Same bound as the
// why-concat so an unbounded merge chain cannot grow either field without limit.
function concatMergeEvidence(
  survivor: Readonly<PathRelation>,
  losers: readonly Readonly<PathRelation>[]
): readonly string[] {
  return dedupeBounded(
    survivor.legitimacy.evidence_basis,
    losers.flatMap((loser) => loser.legitimacy.evidence_basis)
  );
}

// invariant: survivor entries are kept in full (never trimmed by the bound);
// only absorbed loser entries are capped. The result therefore always retains
// at least the survivor's own provenance even when the survivor alone already
// holds more than CONSOLIDATION_MERGE_WHY_MAX_ENTRIES entries.
function dedupeBounded(
  survivorEntries: readonly string[],
  absorbedEntries: readonly string[]
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of survivorEntries) {
    if (entry.length === 0 || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  for (const entry of absorbedEntries) {
    if (result.length >= CONSOLIDATION_MERGE_WHY_MAX_ENTRIES) {
      break;
    }
    if (entry.length === 0 || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return Object.freeze(result);
}

// invariant: the dormant-at-apply predicate mirrors the storage repo's dormant
// filter exactly — a path counts as dormant only when its lifecycle.status is
// explicitly "dormant" (no unset-defaults-to-dormant fallback). Re-checked at
// the delete site so a loser that revived to active (or was pinned / governed)
// between plan emission and commit is refused.
// see also: packages/storage/src/repos/path-relation-repo.ts findDormant.
function isDormantAtApply(path: Readonly<PathRelation>): boolean {
  return path.lifecycle.status === "dormant";
}

// invariant: a deleted loser's FULL why/evidence is recorded here untrimmed
// (only the survivor ROW is bounded), plus a recall_bias sign+magnitude and
// direction_bias effect summary so a negative-family loser's suppression stays
// auditable after deletion.
function summarizeMergedLoser(loser: Readonly<PathRelation>): PathRelationMergedLoser {
  return Object.freeze({
    path_id: loser.path_id,
    why_this_relation_exists: Object.freeze([...loser.constitution.why_this_relation_exists]),
    evidence_basis: Object.freeze([...loser.legitimacy.evidence_basis]),
    recall_bias_sign: recallBiasSign(loser.effect_vector.recall_bias),
    recall_bias_magnitude: Math.abs(loser.effect_vector.recall_bias),
    direction_bias: loser.plasticity_state.direction_bias
  });
}

function recallBiasSign(recallBias: number): MergedLoserRecallBiasSign {
  if (recallBias > 0) {
    return "positive";
  }
  if (recallBias < 0) {
    return "negative";
  }
  return "zero";
}

// invariant: a single path id may take part in at most ONE structural mutation
// per cycle. Overlap across merges (survivor-also-loser, a loser shared by two
// merges) or across a merge and the promotion/retirement/governance/direction
// lanes would double-delete a row or apply an absorption update to an already
// deleted path. The whole plan is an externally-constructable protocol object,
// so the executor rejects any overlap before mutating the repo.
function assertNoPathIdOverlap(plan: ConsolidationCyclePlan): void {
  const seen = new Set<string>();
  const claim = (pathId: string, lane: string): void => {
    if (seen.has(pathId)) {
      throw new Error(
        `Consolidation cycle path relation ${pathId} appears in more than one mutation (overlap at ${lane}).`
      );
    }
    seen.add(pathId);
  };

  for (const promotion of plan.promotions) {
    claim(promotion.path_id, "promotions");
  }
  for (const change of plan.governance_changes) {
    claim(change.path_id, "governance_changes");
  }
  for (const change of plan.direction_changes) {
    claim(change.path_id, "direction_changes");
  }
  for (const retirement of plan.retirements) {
    claim(retirement.path_id, "retirements");
  }
  for (const merge of plan.merges ?? []) {
    claim(merge.survivor_path_id, "merges.survivor");
    for (const loserPathId of merge.merged_path_ids) {
      claim(loserPathId, "merges.loser");
    }
  }
}
