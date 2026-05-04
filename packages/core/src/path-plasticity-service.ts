import {
  DYNAMICS_CONSTANTS,
  PathPlasticityStateSchema,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type EventLogEntry,
  type PathAnchorRef,
  type PathPlasticityState,
  type PathRelation,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import { EventPublisher } from "./event-publisher.js";
import { getNextRevision } from "./shared/event-utils.js";

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
   * Returns recent usage records reported strictly AFTER `sinceIso` (i.e.
   * `record.reported_at > sinceIso`, exclusive). Scoped to the given
   * workspace. Implementation may join through TrustStateRepo or directly
   * query the EventLog — the service does not care which.
   *
   * Exclusive comparison is intentional (Q4): a tick that processes records
   * up to-and-including `T` then advances its watermark to `T`; the next
   * tick starts strictly after `T` to avoid double-counting the boundary
   * record across two ticks.
   */
  listRecentUsage(
    workspaceId: string,
    sinceIso: string
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
  update(
    pathId: string,
    updates: Partial<
      Pick<PathRelation, "effect_vector" | "plasticity_state" | "lifecycle" | "legitimacy" | "updated_at">
    >
  ): Promise<Readonly<PathRelation>>;
}

export interface PathPlasticityServiceDependencies {
  readonly usageProofReader: UsageProofReaderPort;
  readonly pathRelationRepo: PathPlasticityRepoPort;
  readonly eventPublisher: EventPublisher;
  readonly eventLogRepo: {
    queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
  };
  readonly now?: () => string;
}

export interface PathPlasticityComputeResult {
  readonly reinforced: number;
  readonly weakened: number;
  readonly retired: number;
  readonly affectedPathIds: readonly string[];
}

/**
 * PathPlasticityService translates recent UsageProofRecord rows into
 * PathRelation strength deltas. Each delta is published through the
 * EventPublisher boundary as a Phase-C path-relation reinforcement,
 * weakening, or retirement event so that the audit log records every change
 * and the durable PathRelation row reflects the new plasticity_state only
 * after the audit event has been appended.
 *
 * The service is invoked from a Garden role (background tier). It MUST NOT
 * be called on the recall request path.
 *
 * Plasticity ops covered by this v0.1 service (3/4):
 *   - reinforcement (used → +USED_DELTA strength)
 *   - weakening (skipped → -SKIPPED_DELTA strength)
 *   - retirement (strength <= threshold + inactivity → emit retired event)
 *
 * TODO(v0.2): direction_bias plasticity (redirection op) — needs an
 * asymmetric usage signal between source/target anchors so the service can
 * decide whether to flip `source_to_target` ↔ `target_to_source` or move to
 * `bidirectional`. Deferred per A3 review I5.
 */
export class PathPlasticityService {
  private readonly now: () => string;

  public constructor(private readonly dependencies: PathPlasticityServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /**
   * Reads UsageProofRecord rows reported strictly after `sinceIso`,
   * computes per-path deltas, and publishes Phase-C events that mutate the
   * PathRelation rows.
   *
   * Returns counts for observability.
   */
  public async computeAndApplyPlasticity(params: {
    readonly workspaceId: string;
    readonly sinceIso: string;
  }): Promise<PathPlasticityComputeResult> {
    const usageRecords = await this.dependencies.usageProofReader.listRecentUsage(
      params.workspaceId,
      params.sinceIso
    );

    if (usageRecords.length === 0) {
      return Object.freeze({ reinforced: 0, weakened: 0, retired: 0, affectedPathIds: [] });
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
      usageRecords
    );

    const affected = new Set<string>();
    let reinforced = 0;
    let weakened = 0;
    let retired = 0;

    for (const { path, counts } of pathAggregates.values()) {
      // I7: skip paths that have already been retired in a prior tick. The
      // schema does not encode "retired" as a status enum, so we infer
      // retirement from the audit log (any prior PATH_RELATION_RETIRED
      // event for this entity). A retired path should not re-emit further
      // plasticity events; otherwise the audit log would carry duplicate
      // retirement noise and the durable strength would keep being
      // re-clamped at zero.
      if (await this.isAlreadyRetired(path.path_id)) {
        continue;
      }

      const outcome = await this.applyDeltasForPath(path, counts);
      if (outcome === "reinforced") {
        reinforced += 1;
        affected.add(path.path_id);
      } else if (outcome === "weakened") {
        weakened += 1;
        affected.add(path.path_id);
      } else if (outcome === "retired") {
        retired += 1;
        affected.add(path.path_id);
      }
    }

    return Object.freeze({
      reinforced,
      weakened,
      retired,
      affectedPathIds: Object.freeze([...affected])
    });
  }

  private async aggregatePathUsage(
    workspaceId: string,
    usageRecords: readonly Readonly<UsageProofRecord>[]
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
      if (seenAuditEventIds.has(record.audit_event_id)) {
        continue;
      }
      seenAuditEventIds.add(record.audit_event_id);

      // Resolve which object_ids this receipt counts against.
      let targetObjectIds: readonly string[];
      if (record.usage_state === "used") {
        targetObjectIds = record.used_object_ids;
      } else if (record.usage_state === "skipped" || record.usage_state === "not_applicable") {
        // skipped / not_applicable receipts weight every memory the agent
        // had in hand — not just the ones cited as used.
        targetObjectIds =
          record.used_object_ids.length > 0
            ? record.used_object_ids
            : (await this.dependencies.usageProofReader.findDeliveredObjectIds(
                record.delivery_id
              )) ?? [];
      } else {
        continue;
      }

      // B1 dedup: collect the set of UNIQUE PathRelation rows touched by
      // this receipt. findByAnchor returns the same path twice when both
      // its anchors appear in the receipt; we must count the receipt as a
      // single logical signal against the path, not one per anchor.
      const pathsTouchedByReceipt = new Map<string, Readonly<PathRelation>>();
      for (const objectId of targetObjectIds) {
        const anchorRef: PathAnchorRef = Object.freeze({
          kind: "object",
          object_id: objectId
        });
        const paths = await this.dependencies.pathRelationRepo.findByAnchor(
          workspaceId,
          anchorRef
        );
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
    }

    return pathAggregates;
  }

  private async isAlreadyRetired(pathId: string): Promise<boolean> {
    const events = await this.dependencies.eventLogRepo.queryByEntity(
      "path_relation",
      pathId
    );
    return events.some(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_RETIRED
    );
  }

  private async applyDeltasForPath(
    path: Readonly<PathRelation>,
    counts: MutableObjectUsageCounts
  ): Promise<"reinforced" | "weakened" | "retired" | "none"> {
    const previousStrength = path.plasticity_state.strength;
    const usedDelta = counts.used * PATH_PLASTICITY_CONSTANTS.USED_DELTA;
    const skippedDelta = counts.skipped * PATH_PLASTICITY_CONSTANTS.SKIPPED_DELTA;
    const proposedStrength = clampStrength(previousStrength + usedDelta - skippedDelta);
    const occurredAt = this.now();

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
      const nextSupportCount =
        path.plasticity_state.support_events_count + counts.used;
      const nextContradictionCount =
        path.plasticity_state.contradiction_events_count + counts.notApplicable;
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: proposedStrength,
        support_events_count: nextSupportCount,
        contradiction_events_count: nextContradictionCount,
        last_reinforced_at: occurredAt
      });
      await this.publishReinforced({
        path,
        previousStrength,
        nextStrength: proposedStrength,
        nextPlasticity,
        supportEventsCount: nextSupportCount,
        occurredAt
      });
      return "reinforced";
    }

    if (netDelta < 0) {
      const nextStrength = proposedStrength;
      const nextContradictionCount =
        path.plasticity_state.contradiction_events_count + counts.notApplicable;
      // Retirement: weak path with no recent reinforcement → emit
      // PathRelationRetired instead of PathRelationWeakened.
      if (retirementEligible) {
        const nextPlasticity = parsePlasticityState({
          ...path.plasticity_state,
          strength: nextStrength,
          contradiction_events_count: nextContradictionCount,
          last_weakened_at: occurredAt
        });
        await this.publishRetired({
          path,
          finalStrength: nextStrength,
          nextPlasticity,
          reason: "strength_below_threshold_and_inactive",
          occurredAt
        });
        return "retired";
      }

      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: nextStrength,
        contradiction_events_count: nextContradictionCount,
        last_weakened_at: occurredAt
      });
      await this.publishWeakened({
        path,
        previousStrength,
        nextStrength,
        nextPlasticity,
        contradictionEventsCount: nextContradictionCount,
        reason: counts.skipped > 0 ? "skipped_usage" : "contradiction_only",
        occurredAt
      });
      return "weakened";
    }

    if (counts.notApplicable > 0) {
      // Pure not_applicable signal — record the contradiction increment via a
      // weakened event with zero strength delta so the audit log carries a
      // trace, even though strength itself does not change.
      const nextContradictionCount =
        path.plasticity_state.contradiction_events_count + counts.notApplicable;
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        contradiction_events_count: nextContradictionCount,
        last_weakened_at: occurredAt
      });
      await this.publishWeakened({
        path,
        previousStrength,
        nextStrength: previousStrength,
        nextPlasticity,
        contradictionEventsCount: nextContradictionCount,
        reason: "not_applicable_recurrence",
        occurredAt
      });
      return "weakened";
    }

    // netDelta === 0, no contradiction signal. Verification-gap fix:
    // re-check retirement here too. A path sitting at strength == 0 with
    // a `skipped` receipt that produces no further drop (clamped at the
    // floor) still triggers retirement when inactivity passes the window.
    if (retirementEligible && counts.skipped > 0) {
      const nextPlasticity = parsePlasticityState({
        ...path.plasticity_state,
        strength: proposedStrength,
        last_weakened_at: occurredAt
      });
      await this.publishRetired({
        path,
        finalStrength: proposedStrength,
        nextPlasticity,
        reason: "strength_below_threshold_and_inactive",
        occurredAt
      });
      return "retired";
    }

    return "none";
  }

  private isInactive(lastReinforcedAt: string | undefined, nowIso: string): boolean {
    if (lastReinforcedAt === undefined) {
      return true;
    }
    const elapsedMs = Date.parse(nowIso) - Date.parse(lastReinforcedAt);
    return elapsedMs >= PATH_PLASTICITY_CONSTANTS.RETIREMENT_INACTIVITY_MS;
  }

  private async publishReinforced(params: {
    readonly path: Readonly<PathRelation>;
    readonly previousStrength: number;
    readonly nextStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly supportEventsCount: number;
    readonly occurredAt: string;
  }): Promise<void> {
    const revision = await getNextRevision(
      this.dependencies.eventLogRepo,
      "path_relation",
      params.path.path_id
    );
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

    await this.dependencies.eventPublisher.publishWithMutation(
      {
        event_type: RuntimeGovernanceEventType.PATH_RELATION_REINFORCED,
        entity_type: "path_relation",
        entity_id: params.path.path_id,
        workspace_id: params.path.workspace_id,
        run_id: null,
        caused_by: "system",
        revision,
        payload_json: payload as unknown as Record<string, unknown>
      },
      async () => {
        await this.dependencies.pathRelationRepo.update(params.path.path_id, {
          plasticity_state: params.nextPlasticity,
          updated_at: params.occurredAt
        });
      }
    );
  }

  private async publishWeakened(params: {
    readonly path: Readonly<PathRelation>;
    readonly previousStrength: number;
    readonly nextStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly contradictionEventsCount: number;
    readonly reason: string;
    readonly occurredAt: string;
  }): Promise<void> {
    const revision = await getNextRevision(
      this.dependencies.eventLogRepo,
      "path_relation",
      params.path.path_id
    );
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

    await this.dependencies.eventPublisher.publishWithMutation(
      {
        event_type: RuntimeGovernanceEventType.PATH_RELATION_WEAKENED,
        entity_type: "path_relation",
        entity_id: params.path.path_id,
        workspace_id: params.path.workspace_id,
        run_id: null,
        caused_by: "system",
        revision,
        payload_json: payload as unknown as Record<string, unknown>
      },
      async () => {
        await this.dependencies.pathRelationRepo.update(params.path.path_id, {
          plasticity_state: params.nextPlasticity,
          updated_at: params.occurredAt
        });
      }
    );
  }

  private async publishRetired(params: {
    readonly path: Readonly<PathRelation>;
    readonly finalStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly reason: string;
    readonly occurredAt: string;
  }): Promise<void> {
    const revision = await getNextRevision(
      this.dependencies.eventLogRepo,
      "path_relation",
      params.path.path_id
    );
    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
      {
        path_id: params.path.path_id,
        retirement_reason: params.reason,
        final_strength: params.finalStrength,
        retired_at: params.occurredAt
      }
    );

    await this.dependencies.eventPublisher.publishWithMutation(
      {
        event_type: RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
        entity_type: "path_relation",
        entity_id: params.path.path_id,
        workspace_id: params.path.workspace_id,
        run_id: null,
        caused_by: "system",
        revision,
        payload_json: payload as unknown as Record<string, unknown>
      },
      async () => {
        await this.dependencies.pathRelationRepo.update(params.path.path_id, {
          plasticity_state: params.nextPlasticity,
          updated_at: params.occurredAt
        });
      }
    );
  }
}

interface MutableObjectUsageCounts {
  used: number;
  skipped: number;
  notApplicable: number;
  lastReportedAt: string | null;
}

interface PathAggregate {
  readonly path: Readonly<PathRelation>;
  readonly counts: MutableObjectUsageCounts;
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
