import {
  DYNAMICS_CONSTANTS,
  PathPlasticityStateSchema,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type DirectionBias,
  type EventLogEntry,
  type PathAnchorRef,
  type PathGovernanceClass,
  type PathLifecycleStatus,
  type PathPlasticityState,
  type PathRelation,
  type SoulContextObjectIdentity,
  type StabilityClass,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import { EventPublisher, type EventPublisherInput } from "./event-publisher.js";
import { classifyPathImportance } from "./importance-gate.js";
import { planPromotion, type PromotionPlan } from "./path-manifestation-policy.js";

/**
 * Plasticity tuning constants. Derived authoritatively from
 * `DYNAMICS_CONSTANTS.path_plasticity` in `@do-soul/alaya-protocol` so that
 * a future tuner only has to edit one location. The asymmetric magnitudes
 * (used > skipped) reflect the domain rationale: a `used` receipt is rarer
 * evidence than a `skipped` non-use, so each used signal weighs more.
 *
 * Note: PathPlasticityService converts `weakening_decrement` (which is
 * negative in the dynamics constants) into a positive magnitude here so the
 * delta math reads naturally as `previous + used*UsedDelta - skipped*SkippedDelta`.
 */
export const PATH_PLASTICITY_CONSTANTS = Object.freeze({
  USED_DELTA: DYNAMICS_CONSTANTS.path_plasticity.reinforcement_increment,
  SKIPPED_DELTA: Math.abs(DYNAMICS_CONSTANTS.path_plasticity.weakening_decrement),
  REPEATED_USED_DECAY_FACTOR: 0.5,
  AUTOMATIC_TRUST_USED_MULTIPLIER: 0.5,
  STRENGTH_FLOOR: DYNAMICS_CONSTANTS.path_plasticity.strength_floor,
  STRENGTH_CEILING: DYNAMICS_CONSTANTS.path_plasticity.strength_ceiling,
  RETIREMENT_STRENGTH_THRESHOLD: DYNAMICS_CONSTANTS.path_plasticity.retirement_strength_threshold,
  RETIREMENT_INACTIVITY_MS: DYNAMICS_CONSTANTS.path_plasticity.retirement_inactivity_ms,
  REVIVE_STRENGTH: DYNAMICS_CONSTANTS.path_plasticity.revive_strength
} as const);

export interface UsageProofReaderPort {
  /**
   * Returns recent usage records reported strictly AFTER `sinceIso` and,
   * when supplied, at or before `untilIso`. Scoped to the given workspace.
   * Implementation may join through TrustStateRepo or directly query the
   * EventLog — the service does not care which.
   *
   * invariant: a tick that processes records up to-and-including `T` then
   * advances its watermark to `T`; the next tick starts strictly after `T`
   * to avoid double-counting the boundary record across two ticks.
   */
  listRecentUsage(
    workspaceId: string,
    sinceIso: string,
    untilIso?: string
  ): Promise<readonly Readonly<UsageProofRecord>[]>;

  /**
   * Returns delivered object identities for the given delivery. Modern
   * callers use this so object-kind collisions cannot credit synthesis
   * capsules as memory-entry path anchors.
   */
  findDeliveredObjects?(
    deliveryId: string
  ): Promise<readonly SoulContextObjectIdentity[] | null>;

  /**
   * Legacy fallback for deliveries persisted before object_kind was tracked.
   * The service treats these bare ids as memory_entry ids only when
   * findDeliveredObjects is unavailable or returns null.
   */
  findDeliveredObjectIds(deliveryId: string): Promise<readonly string[] | null>;
}

export interface PathPlasticityRepoPort {
  findByAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  /** Synchronous variant required by `appendManyWithMutation`'s
   * sync-mutate contract. The plasticity batch publisher below wraps append
   * and mutation in one SQLite transaction through this port. */
  update(
    pathId: string,
    updates: PathPlasticityRepoUpdate
  ): Readonly<PathRelation>;
}

type PathPlasticityRepoUpdate = Partial<
  Pick<PathRelation, "effect_vector" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at">
>;

export interface PathPlasticityServiceDependencies {
  readonly usageProofReader: UsageProofReaderPort;
  readonly pathRelationRepo: PathPlasticityRepoPort;
  readonly eventPublisher: EventPublisher;
  readonly eventLogRepo: {
    queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  };
  readonly now?: () => string;
}

export interface PathPlasticityPromotionRecord {
  readonly path_id: string;
  readonly governance_promoted: PromotionPlan["governance"];
  readonly stability_promoted: PromotionPlan["stability"];
}

export interface PathPlasticityComputeResult {
  readonly reinforced: number;
  readonly weakened: number;
  readonly retired: number;
  readonly dormant: number;
  readonly revived: number;
  readonly affectedPathIds: readonly string[];
  readonly promotions: readonly PathPlasticityPromotionRecord[];
}

/**
 * PathPlasticityService translates recent UsageProofRecord rows into
 * PathRelation strength deltas. Each delta is published through the
 * EventPublisher boundary as a runtime-governance path-relation reinforcement,
 * weakening, or retirement event (see
 * `packages/protocol/src/events/runtime-governance.ts`) so that the audit
 * log records every change
 * and the durable PathRelation row reflects the new plasticity_state only
 * after the audit event has been appended.
 *
 * The service is invoked from a Garden role (background tier). It MUST NOT
 * be called on the recall request path.
 *
 * Plasticity ops covered by this service:
 *   - reinforcement (used → +USED_DELTA strength)
 *   - weakening (skipped → -SKIPPED_DELTA strength)
 *   - redirection (source/target anchor usage → direction_bias)
 *   - retirement (negative/neutral family, strength <= threshold + inactivity
 *     → emit retired event, terminal)
 *   - dormancy (positive associative family, strength <= threshold +
 *     inactivity → emit dormant event, salience cleared, reversible)
 *   - revival (dormant path receives a used receipt → emit revived event,
 *     strength reset to REVIVE_STRENGTH, status back to active)
 *
 * Family discriminator: a path is positive-associative when
 * effect_vector.recall_bias > 0 (supports / derives_from / co_recalled /
 * shares_entity seeds). recall_bias <= 0 (negative lifecycle family such as
 * supersedes / contradicts, plus neutral exception_to / unset) keeps the
 * existing retirement behaviour. This coexistence keeps negative-family
 * retirement and the legacy neutral-default retire tests intact while the
 * positive family decays into reversible dormancy. Endpoint-following for
 * the negative family is intentionally not implemented here: this service
 * mutates only strength/lifecycle, never recall_bias, so family membership
 * stays stable across plasticity passes.
 *
 * Governance asymmetry: for negative paths (recall_bias < 0) this service
 * never mutates governance_class either — only strength/lifecycle/stability
 * evolve. Positive paths (recall_bias >= 0) still promote governance via the
 * support_events ladder (planPromotion → evolveGovernanceClass). This blocks
 * an agent from pumping a negative path's governance up through co-usage
 * receipts to clear the suppression governance gate. see also:
 * path-manifestation-policy.ts planPromotion (sign-guarded governance ladder).
 */
export class PathPlasticityService {
  private readonly now: () => string;

  public constructor(private readonly dependencies: PathPlasticityServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /**
   * Reads UsageProofRecord rows reported inside `(sinceIso, untilIso]`,
   * computes per-path deltas, and publishes runtime-governance events that
   * mutate the PathRelation rows.
   *
   * Returns counts for observability.
   */
  public async computeAndApplyPlasticity(params: {
    readonly workspaceId: string;
    readonly sinceIso: string;
    readonly untilIso?: string;
    readonly abortSignal?: AbortSignal;
    readonly onMutationBoundaryEntered?: () => void;
  }): Promise<PathPlasticityComputeResult> {
    throwIfPathPlasticityAborted(params.abortSignal);
    const usageRecords = await this.dependencies.usageProofReader.listRecentUsage(
      params.workspaceId,
      params.sinceIso,
      params.untilIso
    );
    throwIfPathPlasticityAborted(params.abortSignal);

    if (usageRecords.length === 0) {
      return Object.freeze({
        reinforced: 0,
        weakened: 0,
        retired: 0,
        dormant: 0,
        revived: 0,
        affectedPathIds: [],
        promotions: []
      });
    }

    // invariant: aggregate per path, not per object. If both anchors of the
    // same PathRelation appear in one usage receipt, that receipt still
    // counts as one logical reinforcement of the path.
    const pathAggregates = await this.aggregatePathUsage(
      params.workspaceId,
      usageRecords,
      params.abortSignal
    );
    throwIfPathPlasticityAborted(params.abortSignal);

    const affected = new Set<string>();
    let reinforced = 0;
    let weakened = 0;
    let retired = 0;
    let dormant = 0;
    let revived = 0;
    const mutationPlans: PathPlasticityMutationPlan[] = [];
    const promotions: PathPlasticityPromotionRecord[] = [];

    for (const { path, counts } of pathAggregates.values()) {
      // Retired paths are terminal durable lifecycle state and never reactivate
      // from a strength heuristic. Dormant paths, by contrast, stay reachable
      // here so a fresh used receipt can revive them.
      if (isRetiredPath(path)) {
        continue;
      }

      const plan = this.planDeltasForPath(
        path,
        counts,
        params.abortSignal
      );
      if (plan === null) {
        continue;
      }

      mutationPlans.push(plan);
      if (plan.outcome === "reinforced") {
        reinforced += 1;
        affected.add(plan.pathId);
      } else if (plan.outcome === "weakened") {
        weakened += 1;
        affected.add(plan.pathId);
      } else if (plan.outcome === "retired") {
        retired += 1;
        affected.add(plan.pathId);
      } else if (plan.outcome === "dormant") {
        dormant += 1;
        affected.add(plan.pathId);
      } else if (plan.outcome === "revived") {
        revived += 1;
        affected.add(plan.pathId);
      } else if (plan.outcome === "redirected") {
        affected.add(plan.pathId);
      }
      if (plan.promotion.governance !== null || plan.promotion.stability !== null) {
        promotions.push(
          Object.freeze({
            path_id: plan.pathId,
            governance_promoted: plan.promotion.governance,
            stability_promoted: plan.promotion.stability
          })
        );
      }
    }

    this.applyMutationPlans(
      mutationPlans,
      params.abortSignal,
      params.onMutationBoundaryEntered
    );

    return Object.freeze({
      reinforced,
      weakened,
      retired,
      dormant,
      revived,
      affectedPathIds: Object.freeze([...affected]),
      promotions: Object.freeze(promotions)
    });
  }

  private async aggregatePathUsage(
    workspaceId: string,
    usageRecords: readonly Readonly<UsageProofRecord>[],
    abortSignal?: AbortSignal
  ): Promise<ReadonlyMap<string, PathAggregate>> {
    const pathAggregates = new Map<string, PathAggregate>();

    // invariant: dedupe receipts by their durable identifier so aggregation
    // stays idempotent inside one call even if the reader repeats a record.
    // Cross-tick dedupe comes from the daemon's high-water mark.
    const seenAuditEventIds = new Set<string>();

    for (const record of usageRecords) {
      throwIfPathPlasticityAborted(abortSignal);
      if (seenAuditEventIds.has(record.audit_event_id)) {
        continue;
      }
      seenAuditEventIds.add(record.audit_event_id);

      // Resolve which object_ids this receipt counts against.
      let targetObjectIds: readonly string[];
      if (record.usage_state === "used") {
        targetObjectIds = uniqueStrings([
          ...record.used_object_ids,
          ...(record.per_anchor_usage ?? [])
            .filter(isMemoryEntryAnchorUsage)
            .map((usage) => usage.object_id)
        ]);
      } else if (record.usage_state === "skipped" || record.usage_state === "not_applicable") {
        // skipped / not_applicable receipts weight every memory the agent
        // had in hand — not just the ones cited as used.
        targetObjectIds =
          record.used_object_ids.length > 0
            ? record.used_object_ids
            : await this.resolveDeliveredMemoryObjectIds(record.delivery_id);
        throwIfPathPlasticityAborted(abortSignal);
      } else {
        continue;
      }

      // invariant: collect the unique PathRelation rows touched by this
      // receipt before applying the signal, so a path matched by both
      // anchors is reinforced once.
      const pathsTouchedByReceipt = new Map<string, Readonly<PathRelation>>();
      for (const objectId of targetObjectIds) {
        throwIfPathPlasticityAborted(abortSignal);
        const anchorRef: PathAnchorRef = Object.freeze({
          kind: "object",
          object_id: objectId
        });
        const paths = await this.dependencies.pathRelationRepo.findByAnchor(
          workspaceId,
          anchorRef
        );
        throwIfPathPlasticityAborted(abortSignal);
        for (const path of paths) {
          if (!pathsTouchedByReceipt.has(path.path_id)) {
            pathsTouchedByReceipt.set(path.path_id, path);
          }
        }
      }

      // Apply the receipt's signal once per unique path.
      for (const [pathId, path] of pathsTouchedByReceipt.entries()) {
        const existing = pathAggregates.get(pathId);
        const counts: MutableObjectUsageCounts = existing?.counts ?? {
          used: 0,
          usedWeight: 0,
          skipped: 0,
          notApplicable: 0,
          sourceAnchorUsage: 0,
          targetAnchorUsage: 0,
          lastReportedAt: null
        };
        if (record.usage_state === "used") {
          counts.usedWeight += computeUsedSignalWeight(record, counts.used);
          counts.used += 1;
        } else if (record.usage_state === "skipped") {
          counts.skipped += 1;
        } else if (record.usage_state === "not_applicable") {
          counts.notApplicable += 1;
        }
        counts.lastReportedAt = maxIsoNullable(counts.lastReportedAt, record.reported_at);
        if (existing === undefined) {
          pathAggregates.set(pathId, { path, counts });
        }
      }

      const directionalUsage = await this.resolveDirectionalPathUsage(
        workspaceId,
        record,
        abortSignal
      );
      for (const [pathId, usage] of directionalUsage.entries()) {
        const existing = pathAggregates.get(pathId);
        const counts: MutableObjectUsageCounts = existing?.counts ?? {
          used: 0,
          usedWeight: 0,
          skipped: 0,
          notApplicable: 0,
          sourceAnchorUsage: 0,
          targetAnchorUsage: 0,
          lastReportedAt: null
        };
        if (usage.sourceUsed) {
          counts.sourceAnchorUsage += 1;
        }
        if (usage.targetUsed) {
          counts.targetAnchorUsage += 1;
        }
        counts.lastReportedAt = maxIsoNullable(counts.lastReportedAt, record.reported_at);
        if (existing === undefined) {
          pathAggregates.set(pathId, { path: usage.path, counts });
        }
      }
    }

    return pathAggregates;
  }

  private async resolveDeliveredMemoryObjectIds(deliveryId: string): Promise<readonly string[]> {
    const deliveredObjects =
      await this.dependencies.usageProofReader.findDeliveredObjects?.(deliveryId);
    if (deliveredObjects !== undefined && deliveredObjects !== null) {
      return uniqueStrings(
        deliveredObjects
          .filter((object) => object.object_kind === "memory_entry")
          .map((object) => object.object_id)
      );
    }

    return (await this.dependencies.usageProofReader.findDeliveredObjectIds(deliveryId)) ?? [];
  }

  private async resolveDirectionalPathUsage(
    workspaceId: string,
    record: Readonly<UsageProofRecord>,
    abortSignal?: AbortSignal
  ): Promise<ReadonlyMap<string, DirectionalPathUsage>> {
    // invariant: only memory_entry anchors drive PathRelation direction bias.
    // A synthesis_capsule shares the delivered-objects scope with memory and
    // could collide with a path anchor object_id, so it is filtered here too,
    // not only on the used/skipped strength-crediting paths above.
    const perAnchorUsage = (record.per_anchor_usage ?? []).filter(isMemoryEntryAnchorUsage);
    if (record.usage_state !== "used" || perAnchorUsage.length === 0) {
      return new Map();
    }

    const directionalUsage = new Map<string, MutableDirectionalPathUsage>();
    for (const usage of perAnchorUsage) {
      throwIfPathPlasticityAborted(abortSignal);
      const paths = await this.dependencies.pathRelationRepo.findByAnchor(
        workspaceId,
        Object.freeze({ kind: "object", object_id: usage.object_id })
      );
      throwIfPathPlasticityAborted(abortSignal);
      for (const path of paths) {
        const matchesSource =
          usage.anchor_role === "source" &&
          isObjectAnchor(path.anchors.source_anchor, usage.object_id);
        const matchesTarget =
          usage.anchor_role === "target" &&
          isObjectAnchor(path.anchors.target_anchor, usage.object_id);
        if (!matchesSource && !matchesTarget) {
          continue;
        }
        const existing = directionalUsage.get(path.path_id) ?? {
          path,
          sourceUsed: false,
          targetUsed: false
        };
        directionalUsage.set(path.path_id, {
          path,
          sourceUsed: existing.sourceUsed || matchesSource,
          targetUsed: existing.targetUsed || matchesTarget
        });
      }
    }

    return directionalUsage;
  }

  private planDeltasForPath(
    path: Readonly<PathRelation>,
    counts: MutableObjectUsageCounts,
    abortSignal?: AbortSignal
  ): PathPlasticityMutationPlan | null {
    throwIfPathPlasticityAborted(abortSignal);
    const previousStrength = path.plasticity_state.strength;
    const usedDelta = counts.usedWeight * PATH_PLASTICITY_CONSTANTS.USED_DELTA;
    const skippedDelta = counts.skipped * PATH_PLASTICITY_CONSTANTS.SKIPPED_DELTA;
    const proposedStrength = clampStrength(previousStrength + usedDelta - skippedDelta);
    const occurredAt = this.now();
    const nextDirectionBias = selectDirectionBias(
      path.plasticity_state.direction_bias,
      counts
    );
    const redirection = createRedirectionPublication(
      path.plasticity_state.direction_bias,
      nextDirectionBias,
      counts,
      occurredAt
    );

    const nextSupportEventsCount =
      path.plasticity_state.support_events_count + counts.used;
    const nextContradictionEventsCount =
      path.plasticity_state.contradiction_events_count + counts.notApplicable;
    const promotion = planPromotion({
      path,
      nextSupportEventsCount,
      nextContradictionEventsCount
    });

    // Determine whether this aggregate net-reinforces or net-weakens. If the
    // net delta is zero AND there is a contradiction signal, we still want to
    // record the contradiction, but classify the publication as "weakened" so
    // it shows up in the audit log under the correct phase-C type.
    const netDelta = proposedStrength - previousStrength;

    // invariant: retirement is re-checked even when clamped strength yields
    // zero net movement. A low-strength inactive path with fresh skipped
    // receipts still needs a retirement audit row.
    const retirementEligible =
      proposedStrength <= PATH_PLASTICITY_CONSTANTS.RETIREMENT_STRENGTH_THRESHOLD &&
      this.isInactive(path.plasticity_state.last_reinforced_at, occurredAt);

    // Revival: a dormant path that earns a fresh used receipt returns to
    // active. This is the Hebbian "used → reinforced" reactivation: strength
    // is reset to REVIVE_STRENGTH (not just the small reinforcement delta) so
    // the path re-enters recall with meaningful pressure. Skipped-only signals
    // never revive a dormant path.
    if (isDormantPath(path) && counts.used > 0) {
      const revivedStrength = clampStrength(PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH);
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: revivedStrength,
        direction_bias: nextDirectionBias,
        support_events_count: nextSupportEventsCount,
        contradiction_events_count: nextContradictionEventsCount,
        last_reinforced_at: occurredAt
      });
      return this.createRevivedPlan({
        path,
        previousStrength,
        revivedStrength,
        nextPlasticity,
        trigger: "used_receipt",
        promotion,
        occurredAt,
        ...(redirection === undefined ? {} : { redirection })
      });
    }

    if (netDelta > 0) {
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: proposedStrength,
        direction_bias: nextDirectionBias,
        support_events_count: nextSupportEventsCount,
        contradiction_events_count: nextContradictionEventsCount,
        last_reinforced_at: occurredAt
      });
      return this.createReinforcedPlan({
        path,
        previousStrength,
        nextStrength: proposedStrength,
        nextPlasticity,
        supportEventsCount: nextSupportEventsCount,
        promotion,
        occurredAt,
        ...(redirection === undefined ? {} : { redirection })
      });
    }

    if (netDelta < 0) {
      const nextStrength = proposedStrength;
      // Weak path with no recent reinforcement. Positive associative family
      // goes dormant (reversible); negative/neutral family retires (terminal).
      if (retirementEligible) {
        const nextPlasticity = parsePlasticityState({
          ...path.plasticity_state,
          strength: nextStrength,
          direction_bias: nextDirectionBias,
          support_events_count: nextSupportEventsCount,
          contradiction_events_count: nextContradictionEventsCount,
          last_weakened_at: occurredAt
        });
        if (isPositiveAssociativeFamily(path)) {
          return this.createDormantPlan({
            path,
            dormantStrength: nextStrength,
            nextPlasticity,
            reason: "strength_below_threshold_and_inactive",
            promotion,
            occurredAt,
            ...(redirection === undefined ? {} : { redirection })
          });
        }
        return this.createRetiredPlan({
          path,
          finalStrength: nextStrength,
          nextPlasticity,
          reason: "strength_below_threshold_and_inactive",
          promotion,
          occurredAt,
          ...(redirection === undefined ? {} : { redirection })
        });
      }

      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: nextStrength,
        direction_bias: nextDirectionBias,
        support_events_count: nextSupportEventsCount,
        contradiction_events_count: nextContradictionEventsCount,
        last_weakened_at: occurredAt
      });
      return this.createWeakenedPlan({
        path,
        previousStrength,
        nextStrength,
        nextPlasticity,
        contradictionEventsCount: nextContradictionEventsCount,
        reason: counts.skipped > 0 ? "skipped_usage" : "contradiction_only",
        promotion,
        occurredAt,
        ...(redirection === undefined ? {} : { redirection })
      });
    }

    if (counts.notApplicable > 0) {
      // Pure not_applicable signal — record the contradiction increment via a
      // weakened event with zero strength delta so the audit log carries a
      // trace, even though strength itself does not change.
      // invariant: support_events_count records every used receipt even when
      // the weighted strength delta net-weakens or net-zeros.
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        direction_bias: nextDirectionBias,
        support_events_count: nextSupportEventsCount,
        contradiction_events_count: nextContradictionEventsCount,
        last_weakened_at: occurredAt
      });
      return this.createWeakenedPlan({
        path,
        previousStrength,
        nextStrength: previousStrength,
        nextPlasticity,
        contradictionEventsCount: nextContradictionEventsCount,
        reason: "not_applicable_recurrence",
        promotion,
        occurredAt,
        ...(redirection === undefined ? {} : { redirection })
      });
    }

    // netDelta === 0, no contradiction signal. A path at the strength floor
    // with skipped receipts still leaves active after the inactivity window.
    // Mixed receipts can also reach this branch; preserve the support tally
    // before the path goes dormant (positive family) or retires (otherwise).
    if (retirementEligible && counts.skipped > 0) {
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: proposedStrength,
        direction_bias: nextDirectionBias,
        support_events_count: nextSupportEventsCount,
        last_weakened_at: occurredAt
      });
      if (isPositiveAssociativeFamily(path)) {
        return this.createDormantPlan({
          path,
          dormantStrength: proposedStrength,
          nextPlasticity,
          reason: "strength_below_threshold_and_inactive",
          promotion,
          occurredAt,
          ...(redirection === undefined ? {} : { redirection })
        });
      }
      return this.createRetiredPlan({
        path,
        finalStrength: proposedStrength,
        nextPlasticity,
        reason: "strength_below_threshold_and_inactive",
        promotion,
        occurredAt,
        ...(redirection === undefined ? {} : { redirection })
      });
    }

    if (redirection !== undefined) {
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        direction_bias: nextDirectionBias
      });
      return this.createRedirectedPlan({
        path,
        nextPlasticity,
        redirection,
        promotion,
        occurredAt
      });
    }

    return null;
  }

  private isInactive(lastReinforcedAt: string | undefined, nowIso: string): boolean {
    if (lastReinforcedAt === undefined) {
      return true;
    }
    const elapsedMs = Date.parse(nowIso) - Date.parse(lastReinforcedAt);
    return elapsedMs >= PATH_PLASTICITY_CONSTANTS.RETIREMENT_INACTIVITY_MS;
  }

  private applyMutationPlans(
    plans: readonly PathPlasticityMutationPlan[],
    abortSignal?: AbortSignal,
    onMutationBoundaryEntered?: () => void
  ): void {
    if (plans.length === 0) {
      return;
    }

    throwIfPathPlasticityAborted(abortSignal);
    onMutationBoundaryEntered?.();
    throwIfPathPlasticityAborted(abortSignal);
    this.dependencies.eventPublisher.appendManyWithMutationAndDetachPropagation(
      plans.flatMap((plan) => plan.eventInputs),
      () => {
        for (const plan of plans) {
          this.dependencies.pathRelationRepo.update(plan.pathId, plan.updates);
        }
      }
    );
  }

  private createReinforcedPlan(params: {
    readonly path: Readonly<PathRelation>;
    readonly previousStrength: number;
    readonly nextStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly supportEventsCount: number;
    readonly redirection?: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_REINFORCED,
      {
        path_id: params.path.path_id,
        previous_strength: params.previousStrength,
        new_strength: params.nextStrength,
        support_events_count: params.supportEventsCount,
        reinforced_at: params.occurredAt
      }
    );

    return Object.freeze({
      pathId: params.path.path_id,
      outcome: "reinforced",
      eventInputs: Object.freeze([
        ...this.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_REINFORCED,
          entity_type: "path_relation",
          entity_id: params.path.path_id,
          workspace_id: params.path.workspace_id,
          run_id: null,
          caused_by: "system",
          payload_json: payload as unknown as Record<string, unknown>
        }
      ]),
      updates: buildUpdatesWithPromotion({
        path: params.path,
        nextPlasticity: params.nextPlasticity,
        lifecycleStatus: "active",
        promotion: params.promotion,
        occurredAt: params.occurredAt
      }),
      promotion: params.promotion
    });
  }

  private createWeakenedPlan(params: {
    readonly path: Readonly<PathRelation>;
    readonly previousStrength: number;
    readonly nextStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly contradictionEventsCount: number;
    readonly reason: string;
    readonly redirection?: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_WEAKENED,
      {
        path_id: params.path.path_id,
        previous_strength: params.previousStrength,
        new_strength: params.nextStrength,
        contradiction_events_count: params.contradictionEventsCount,
        reason: params.reason,
        weakened_at: params.occurredAt
      }
    );

    return Object.freeze({
      pathId: params.path.path_id,
      outcome: "weakened",
      eventInputs: Object.freeze([
        ...this.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_WEAKENED,
          entity_type: "path_relation",
          entity_id: params.path.path_id,
          workspace_id: params.path.workspace_id,
          run_id: null,
          caused_by: "system",
          payload_json: payload as unknown as Record<string, unknown>
        }
      ]),
      updates: buildUpdatesWithPromotion({
        path: params.path,
        nextPlasticity: params.nextPlasticity,
        lifecycleStatus: "active",
        promotion: params.promotion,
        occurredAt: params.occurredAt
      }),
      promotion: params.promotion
    });
  }

  private createRetiredPlan(params: {
    readonly path: Readonly<PathRelation>;
    readonly finalStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly reason: string;
    readonly redirection?: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    // invariant (R3d acceptance #5): negative/neutral terminal retirement passes
    // the same mechanical importance gate the path consolidation plane uses. A
    // mechanically-deletable (mergeable) path retires cleanly; a NON-deletable
    // path (protected / report_only / keep — pinned, strictly-governed, evidence-
    // rich, or well-supported) is NEVER silently retired: the gate verdict is
    // stamped into retirement_reason so the PATH_RELATION_RETIRED EventLog row
    // records the explicit audit-provenance rationale for terminalizing it.
    // see also: packages/core/src/importance-gate.ts classifyPathImportance.
    const gate = classifyPathImportance(params.path);
    const gatedReason =
      gate.disposition === "mergeable"
        ? `${params.reason}; gate=mergeable`
        : `${params.reason}; gate=${gate.disposition}:${gate.reason}:retained_provenance`;
    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
      {
        path_id: params.path.path_id,
        retirement_reason: gatedReason,
        final_strength: params.finalStrength,
        retired_at: params.occurredAt
      }
    );

    return Object.freeze({
      pathId: params.path.path_id,
      outcome: "retired",
      eventInputs: Object.freeze([
        ...this.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
          entity_type: "path_relation",
          entity_id: params.path.path_id,
          workspace_id: params.path.workspace_id,
          run_id: null,
          caused_by: "system",
          payload_json: payload as unknown as Record<string, unknown>
        }
      ]),
      updates: buildUpdatesWithPromotion({
        path: params.path,
        nextPlasticity: params.nextPlasticity,
        lifecycleStatus: "retired",
        promotion: params.promotion,
        occurredAt: params.occurredAt
      }),
      promotion: params.promotion
    });
  }

  // Active -> dormant. The path stays in the DB but leaves recall: status is
  // set to "dormant" and effect_vector.salience is cleared to 0. Strength is
  // preserved (not zeroed) so a future revive has a baseline to lift from and
  // the importance gate can still read evidence/strength.
  private createDormantPlan(params: {
    readonly path: Readonly<PathRelation>;
    readonly dormantStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly reason: string;
    readonly redirection?: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_DORMANT,
      {
        path_id: params.path.path_id,
        dormancy_reason: params.reason,
        dormant_strength: params.dormantStrength,
        dormant_at: params.occurredAt
      }
    );

    return Object.freeze({
      pathId: params.path.path_id,
      outcome: "dormant",
      eventInputs: Object.freeze([
        ...this.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_DORMANT,
          entity_type: "path_relation",
          entity_id: params.path.path_id,
          workspace_id: params.path.workspace_id,
          run_id: null,
          caused_by: "system",
          payload_json: payload as unknown as Record<string, unknown>
        }
      ]),
      updates: buildUpdatesWithPromotion({
        path: params.path,
        nextPlasticity: params.nextPlasticity,
        lifecycleStatus: "dormant",
        promotion: params.promotion,
        occurredAt: params.occurredAt,
        effectVector: withClearedSalience(params.path.effect_vector)
      }),
      promotion: params.promotion
    });
  }

  // Dormant -> active. Strength is reset to REVIVE_STRENGTH and salience is
  // restored to that same level so the revived path re-enters recall with
  // meaningful pressure rather than the cleared-to-0 dormant value.
  private createRevivedPlan(params: {
    readonly path: Readonly<PathRelation>;
    readonly previousStrength: number;
    readonly revivedStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly trigger: string;
    readonly redirection?: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_REVIVED,
      {
        path_id: params.path.path_id,
        revive_trigger: params.trigger,
        previous_strength: params.previousStrength,
        new_strength: params.revivedStrength,
        revived_at: params.occurredAt
      }
    );

    return Object.freeze({
      pathId: params.path.path_id,
      outcome: "revived",
      eventInputs: Object.freeze([
        ...this.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_REVIVED,
          entity_type: "path_relation",
          entity_id: params.path.path_id,
          workspace_id: params.path.workspace_id,
          run_id: null,
          caused_by: "system",
          payload_json: payload as unknown as Record<string, unknown>
        }
      ]),
      updates: buildUpdatesWithPromotion({
        path: params.path,
        nextPlasticity: params.nextPlasticity,
        lifecycleStatus: "active",
        promotion: params.promotion,
        occurredAt: params.occurredAt,
        effectVector: withRestoredSalience(params.path.effect_vector, params.revivedStrength)
      }),
      promotion: params.promotion
    });
  }

  private createRedirectedPlan(params: {
    readonly path: Readonly<PathRelation>;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly redirection: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    return Object.freeze({
      pathId: params.path.path_id,
      outcome: "redirected",
      eventInputs: this.createRedirectionInputs(params.path, params.redirection),
      updates: buildUpdatesWithPromotion({
        path: params.path,
        nextPlasticity: params.nextPlasticity,
        lifecycleStatus: "active",
        promotion: params.promotion,
        occurredAt: params.occurredAt
      }),
      promotion: params.promotion
    });
  }

  private createRedirectionInputs(
    path: Readonly<PathRelation>,
    redirection: RedirectionPublication | undefined
  ): readonly EventPublisherInput[] {
    if (redirection === undefined) {
      return [];
    }

    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED,
      {
        path_id: path.path_id,
        previous_direction_bias: redirection.previousDirectionBias,
        new_direction_bias: redirection.newDirectionBias,
        source_usage_count: redirection.sourceUsageCount,
        target_usage_count: redirection.targetUsageCount,
        redirected_at: redirection.occurredAt
      }
    );

    return [
      {
        event_type: RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED,
        entity_type: "path_relation",
        entity_id: path.path_id,
        workspace_id: path.workspace_id,
        run_id: null,
        caused_by: "system",
        payload_json: payload as unknown as Record<string, unknown>
      }
    ];
  }
}

interface MutableObjectUsageCounts {
  used: number;
  usedWeight: number;
  skipped: number;
  notApplicable: number;
  sourceAnchorUsage: number;
  targetAnchorUsage: number;
  lastReportedAt: string | null;
}

interface PathAggregate {
  readonly path: Readonly<PathRelation>;
  readonly counts: MutableObjectUsageCounts;
}

interface DirectionalPathUsage {
  readonly path: Readonly<PathRelation>;
  readonly sourceUsed: boolean;
  readonly targetUsed: boolean;
}

type MutableDirectionalPathUsage = DirectionalPathUsage;

interface RedirectionPublication {
  readonly previousDirectionBias: DirectionBias;
  readonly newDirectionBias: DirectionBias;
  readonly sourceUsageCount: number;
  readonly targetUsageCount: number;
  readonly occurredAt: string;
}

type PathPlasticityMutationOutcome =
  | "reinforced"
  | "weakened"
  | "retired"
  | "dormant"
  | "revived"
  | "redirected";

interface PathPlasticityMutationPlan {
  readonly pathId: string;
  readonly outcome: PathPlasticityMutationOutcome;
  readonly eventInputs: readonly EventPublisherInput[];
  readonly updates: Readonly<PathPlasticityRepoUpdate>;
  readonly promotion: PromotionPlan;
}

function clampStrength(value: number): number {
  return Math.min(
    PATH_PLASTICITY_CONSTANTS.STRENGTH_CEILING,
    Math.max(PATH_PLASTICITY_CONSTANTS.STRENGTH_FLOOR, value)
  );
}

function maxIsoNullable(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function computeUsedSignalWeight(
  record: Readonly<UsageProofRecord>,
  priorUsedCountForPath: number
): number {
  const repeatWeight = Math.pow(
    PATH_PLASTICITY_CONSTANTS.REPEATED_USED_DECAY_FACTOR,
    priorUsedCountForPath
  );
  const trustWeight =
    record.trust_mode === "automatic"
      ? PATH_PLASTICITY_CONSTANTS.AUTOMATIC_TRUST_USED_MULTIPLIER
      : 1;
  return repeatWeight * trustWeight;
}

function parsePlasticityState(value: PathPlasticityState): Readonly<PathPlasticityState> {
  return PathPlasticityStateSchema.parse(value);
}

function selectDirectionBias(
  current: DirectionBias,
  counts: Readonly<MutableObjectUsageCounts>
): DirectionBias {
  if (counts.sourceAnchorUsage > 0 && counts.targetAnchorUsage > 0) {
    return "bidirectional_asymmetric";
  }
  if (counts.targetAnchorUsage > 0) {
    return "source_to_target";
  }
  if (counts.sourceAnchorUsage > 0) {
    return "target_to_source";
  }
  return current;
}

function createRedirectionPublication(
  previousDirectionBias: DirectionBias,
  newDirectionBias: DirectionBias,
  counts: Readonly<MutableObjectUsageCounts>,
  occurredAt: string
): RedirectionPublication | undefined {
  if (previousDirectionBias === newDirectionBias) {
    return undefined;
  }
  return {
    previousDirectionBias,
    newDirectionBias,
    sourceUsageCount: counts.sourceAnchorUsage,
    targetUsageCount: counts.targetAnchorUsage,
    occurredAt
  };
}

function isRetiredPath(path: Readonly<PathRelation>): boolean {
  return (path.lifecycle as PathLifecycleWithStatus).status === "retired";
}

function isDormantPath(path: Readonly<PathRelation>): boolean {
  return (path.lifecycle as PathLifecycleWithStatus).status === "dormant";
}

// Family discriminator: positive-associative paths carry a strictly positive
// recall_bias (supports / derives_from / co_recalled / shares_entity seeds).
// recall_bias <= 0 covers the negative lifecycle family (supersedes /
// contradicts, born with negative bias) and the neutral default (exception_to
// / unset, recall_bias === 0). Only the positive family decays into dormancy;
// the rest keep the existing terminal-retire behaviour.
// see also: path-relation-proposal-service.ts (recall_bias sign = family).
function isPositiveAssociativeFamily(path: Readonly<PathRelation>): boolean {
  return path.effect_vector.recall_bias > 0;
}

function withClearedSalience(
  effectVector: PathRelation["effect_vector"]
): PathRelation["effect_vector"] {
  return Object.freeze({
    ...effectVector,
    salience: 0
  });
}

function withRestoredSalience(
  effectVector: PathRelation["effect_vector"],
  salience: number
): PathRelation["effect_vector"] {
  return Object.freeze({
    ...effectVector,
    salience
  });
}

function isObjectAnchor(anchor: PathAnchorRef, objectId: string): boolean {
  return anchor.kind === "object" && anchor.object_id === objectId;
}

function isMemoryEntryAnchorUsage(
  usage: NonNullable<UsageProofRecord["per_anchor_usage"]>[number]
): boolean {
  return (usage.object_kind ?? "memory_entry") === "memory_entry";
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function withLifecycleStatus(
  lifecycle: PathRelation["lifecycle"],
  status: NonNullable<PathLifecycleWithStatus["status"]>
): PathRelation["lifecycle"] {
  return {
    ...lifecycle,
    status
  } as PathRelation["lifecycle"];
}

// Applies a PromotionPlan to the durable update payload. When the plan carries
// a stability promotion we rewrite plasticity_state.stability_class; when the
// plan carries a governance promotion we rewrite legitimacy.governance_class.
// see also: path-manifestation-policy.ts (PromotionPlan producer).
function buildUpdatesWithPromotion(params: {
  readonly path: Readonly<PathRelation>;
  readonly nextPlasticity: Readonly<PathPlasticityState>;
  readonly lifecycleStatus: NonNullable<PathLifecycleWithStatus["status"]>;
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
  // Optional effect_vector rewrite. Dormancy clears salience to 0; revival
  // restores it. Other outcomes leave effect_vector untouched.
  readonly effectVector?: PathRelation["effect_vector"];
}): PathPlasticityRepoUpdate {
  const plasticityWithPromotion =
    params.promotion.stability === null
      ? params.nextPlasticity
      : PathPlasticityStateSchema.parse({
          ...params.nextPlasticity,
          stability_class: params.promotion.stability.next as StabilityClass
        });

  const legitimacyUpdate =
    params.promotion.governance === null
      ? null
      : {
          legitimacy: {
            ...params.path.legitimacy,
            governance_class: params.promotion.governance.next as PathGovernanceClass
          }
        };

  return Object.freeze({
    plasticity_state: plasticityWithPromotion,
    lifecycle: withLifecycleStatus(params.path.lifecycle, params.lifecycleStatus),
    updated_at: params.occurredAt,
    ...(legitimacyUpdate ?? {}),
    ...(params.effectVector === undefined ? {} : { effect_vector: params.effectVector })
  });
}

type PathLifecycleWithStatus = PathRelation["lifecycle"] & {
  readonly status?: PathLifecycleStatus;
};

function throwIfPathPlasticityAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }

  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  const error = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "Path plasticity compute aborted."
  );
  error.name = "AbortError";
  throw error;
}
