import {
  DYNAMICS_CONSTANTS,
  PathPlasticityStateSchema,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type DirectionBias,
  type EventLogEntry,
  type PathAnchorRef,
  type PathGovernanceClass,
  type PathPlasticityState,
  type PathRelation,
  type StabilityClass,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import { EventPublisher, type EventPublisherInput } from "./event-publisher.js";
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
  STRENGTH_FLOOR: DYNAMICS_CONSTANTS.path_plasticity.strength_floor,
  STRENGTH_CEILING: DYNAMICS_CONSTANTS.path_plasticity.strength_ceiling,
  RETIREMENT_STRENGTH_THRESHOLD: DYNAMICS_CONSTANTS.path_plasticity.retirement_strength_threshold,
  RETIREMENT_INACTIVITY_MS: DYNAMICS_CONSTANTS.path_plasticity.retirement_inactivity_ms
} as const);

export interface UsageProofReaderPort {
  /**
   * Returns recent usage records reported strictly AFTER `sinceIso` and,
   * when supplied, at or before `untilIso`. Scoped to the given workspace.
   * Implementation may join through TrustStateRepo or directly query the
   * EventLog — the service does not care which.
   *
   * Exclusive comparison is intentional (Q4): a tick that processes records
   * up to-and-including `T` then advances its watermark to `T`; the next
   * tick starts strictly after `T` to avoid double-counting the boundary
   * record across two ticks.
   */
  listRecentUsage(
    workspaceId: string,
    sinceIso: string,
    untilIso?: string
  ): Promise<readonly Readonly<UsageProofRecord>[]>;

  /**
   * Returns the delivered_object_ids for the given delivery, used to credit
   * a `skipped` usage receipt against every memory the agent had in hand.
   */
  findDeliveredObjectIds(deliveryId: string): Promise<readonly string[] | null>;
}

export interface PathPlasticityRepoPort {
  findByAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  /** Synchronous variant required by `appendManyWithMutation`'s
   * sync-mutate contract (see #BL-022 closure / event-publisher.ts). The
   * plasticity batch publisher below wraps append + mutation in one SQLite
   * transaction via this port. */
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
 *   - retirement (strength <= threshold + inactivity → emit retired event)
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
        affectedPathIds: [],
        promotions: []
      });
    }

    // B1 dedup: aggregate per-path, not per-object. A single PathRelation P
    // whose source_anchor and target_anchor both appear in one usage
    // receipt R must count as exactly ONE reinforcement of P — not two —
    // because the agent reported one logical use of the path. Naive
    // per-object aggregation followed by anchor lookup double-counts P
    // because findByAnchor returns P under BOTH the source-anchor and the
    // target-anchor object_id keys.
    //
    // We resolve receipts → paths first (deduping P within each receipt),
    // then aggregate counts across receipts.
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
    const mutationPlans: PathPlasticityMutationPlan[] = [];
    const promotions: PathPlasticityPromotionRecord[] = [];

    for (const { path, counts } of pathAggregates.values()) {
      // Retired paths are durable lifecycle state, not a strength heuristic
      // or a per-tick audit-log lookup.
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

    // I8: dedupe receipts by their durable identifier (audit_event_id) so
    // the aggregator stays idempotent within a single call even if the
    // reader returns the same record twice (overlapping ticks, buggy
    // watermark, etc.). Cross-tick dedup must come from the daemon's
    // high-water-mark in `sinceIso`; this in-memory set guards the service
    // boundary.
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
          ...(record.per_anchor_usage ?? []).map((usage) => usage.object_id)
        ]);
      } else if (record.usage_state === "skipped" || record.usage_state === "not_applicable") {
        // skipped / not_applicable receipts weight every memory the agent
        // had in hand — not just the ones cited as used.
        targetObjectIds =
          record.used_object_ids.length > 0
            ? record.used_object_ids
            : (await this.dependencies.usageProofReader.findDeliveredObjectIds(
                record.delivery_id
              )) ?? [];
        throwIfPathPlasticityAborted(abortSignal);
      } else {
        continue;
      }

      // B1 dedup: collect the set of UNIQUE PathRelation rows touched by
      // this receipt. findByAnchor returns the same path twice when both
      // its anchors appear in the receipt; we must count the receipt as a
      // single logical signal against the path, not one per anchor.
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
          skipped: 0,
          notApplicable: 0,
          sourceAnchorUsage: 0,
          targetAnchorUsage: 0,
          lastReportedAt: null
        };
        if (record.usage_state === "used") {
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

  private async resolveDirectionalPathUsage(
    workspaceId: string,
    record: Readonly<UsageProofRecord>,
    abortSignal?: AbortSignal
  ): Promise<ReadonlyMap<string, DirectionalPathUsage>> {
    const perAnchorUsage = record.per_anchor_usage ?? [];
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
    const usedDelta = counts.used * PATH_PLASTICITY_CONSTANTS.USED_DELTA;
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

    // Verification-gap fix: retirement must be re-checked even when
    // netDelta == 0. A path stuck at strength == 0 with skipped receipts
    // arriving (clamped to no further movement) would otherwise never
    // retire under the previous gating. We split the retirement check from
    // the netDelta < 0 branch and run it whenever the path is currently at
    // (or below) the retirement strength threshold AND has been inactive
    // longer than the inactivity window.
    const retirementEligible =
      proposedStrength <= PATH_PLASTICITY_CONSTANTS.RETIREMENT_STRENGTH_THRESHOLD &&
      this.isInactive(path.plasticity_state.last_reinforced_at, occurredAt);

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
      // Retirement: weak path with no recent reinforcement → emit
      // PathRelationRetired instead of PathRelationWeakened.
      if (retirementEligible) {
        const nextPlasticity = parsePlasticityState({
          ...path.plasticity_state,
          strength: nextStrength,
          direction_bias: nextDirectionBias,
          support_events_count: nextSupportEventsCount,
          contradiction_events_count: nextContradictionEventsCount,
          last_weakened_at: occurredAt
        });
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
      // Mixed-receipt fix: include any `used` count in support_events_count
      // even when the tick net-weakens or net-zeros (per D2 reviewer-I2).
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

    // netDelta === 0, no contradiction signal. Verification-gap fix:
    // re-check retirement here too. A path sitting at strength == 0 with
    // a `skipped` receipt that produces no further drop (clamped at the
    // floor) still triggers retirement when inactivity passes the window.
    // D2 codex-fixloop-I1: mixed receipts can also reach this branch with
    // counts.used > 0 (e.g. {used: 1, skipped: 2} = 0.1 - 0.1 = 0). Carry
    // the support tally forward in the retirement nextPlasticity so the
    // last record on the path before retirement reflects every used
    // receipt that contributed.
    if (retirementEligible && counts.skipped > 0) {
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: proposedStrength,
        direction_bias: nextDirectionBias,
        support_events_count: nextSupportEventsCount,
        last_weakened_at: occurredAt
      });
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
    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
      {
        path_id: params.path.path_id,
        retirement_reason: params.reason,
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

type PathPlasticityMutationOutcome = "reinforced" | "weakened" | "retired" | "redirected";

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

function isObjectAnchor(anchor: PathAnchorRef, objectId: string): boolean {
  return anchor.kind === "object" && anchor.object_id === objectId;
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
    ...(legitimacyUpdate ?? {})
  });
}

type PathLifecycleWithStatus = PathRelation["lifecycle"] & {
  readonly status?: "active" | "retired";
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
