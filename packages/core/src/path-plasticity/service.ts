import {
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type PathAnchorRef,
  type PathPlasticityState,
  type PathRelation,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type { EventPublisherInput } from "../runtime/event-publisher.js";
import { classifyPathImportance } from "../manifestation/importance-gate.js";
import { planPromotion, type PromotionPlan } from "../path-graph/path-manifestation-policy.js";
import { PATH_PLASTICITY_CONSTANTS } from "./constants.js";
import {
  buildUpdatesWithPromotion,
  clampStrength,
  computeUsedSignalWeight,
  createRedirectionPublication,
  isDormantPath,
  isMemoryEntryAnchorUsage,
  isObjectAnchor,
  isRetiredPath,
  maxIsoNullable,
  parsePlasticityState,
  selectDirectionBias,
  shouldRouteToDormant,
  throwIfPathPlasticityAborted,
  uniqueStrings,
  withClearedSalience,
  withRestoredSalience
} from "./helpers.js";
import type {
  DirectionalPathUsage,
  MutableDirectionalPathUsage,
  MutableObjectUsageCounts,
  PathAggregate,
  PathPlasticityComputeResult,
  PathPlasticityMutationPlan,
  PathPlasticityPromotionRecord,
  PathPlasticityServiceDependencies,
  RedirectionPublication
} from "./types.js";

// invariant: usage proofs mutate PathRelation plasticity only through audited Garden background work.
// invariant: positive paths decay to dormancy; mergeable negative/neutral paths retire.
// invariant: negative paths never promote governance through usage receipts.
// see also: packages/core/src/path-graph/path-manifestation-policy.ts:planPromotion
export class PathPlasticityService {
  private readonly now: () => string;

  public constructor(private readonly dependencies: PathPlasticityServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

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
      // invariant: retired paths never reactivate; dormant paths can revive on fresh use.
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

    const netDelta = proposedStrength - previousStrength;

    // invariant: retirement is re-checked even when clamped strength yields
    // zero net movement. A low-strength inactive path with fresh skipped
    // receipts still needs a retirement audit row.
    const retirementEligible =
      proposedStrength <= PATH_PLASTICITY_CONSTANTS.RETIREMENT_STRENGTH_THRESHOLD &&
      this.isInactive(path.plasticity_state.last_reinforced_at, occurredAt);

    // invariant: only fresh used receipts revive dormant paths.
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
      // invariant: non-mergeable or positive-associative weak paths go dormant, not retired.
      if (retirementEligible) {
        const nextPlasticity = parsePlasticityState({
          ...path.plasticity_state,
          strength: nextStrength,
          direction_bias: nextDirectionBias,
          support_events_count: nextSupportEventsCount,
          contradiction_events_count: nextContradictionEventsCount,
          last_weakened_at: occurredAt
        });
        if (shouldRouteToDormant(path)) {
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

    // invariant: floor-strength skipped receipts still trigger inactive-path lifecycle changes.
    if (retirementEligible && counts.skipped > 0) {
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: proposedStrength,
        direction_bias: nextDirectionBias,
        support_events_count: nextSupportEventsCount,
        last_weakened_at: occurredAt
      });
      if (shouldRouteToDormant(path)) {
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
    // invariant: terminal retirement stamps the mechanical importance-gate verdict.
    // see also: packages/core/src/manifestation/importance-gate.ts:classifyPathImportance
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

  // invariant: dormancy clears salience but preserves strength for revival and importance checks.
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

  // invariant: revival restores salience to the revived strength.
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
