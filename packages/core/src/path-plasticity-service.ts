import {
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
 * Plasticity tuning constants. These are intentionally simple in v0.1 — the
 * goal is "measurable, audited delta" rather than tuned reinforcement curves.
 */
export const PATH_PLASTICITY_CONSTANTS = {
  USED_DELTA: 0.05,
  SKIPPED_DELTA: 0.05,
  STRENGTH_FLOOR: 0,
  STRENGTH_CEILING: 1,
  RETIREMENT_STRENGTH_THRESHOLD: 0.05,
  RETIREMENT_INACTIVITY_MS: 30 * 86_400_000
} as const;

export interface UsageProofReaderPort {
  /**
   * Returns recent usage records reported on or after `sinceIso`, scoped to
   * the given workspace. Implementation may join through TrustStateRepo or
   * directly query the EventLog — the service does not care which.
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
 */
export class PathPlasticityService {
  private readonly now: () => string;

  public constructor(private readonly dependencies: PathPlasticityServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  /**
   * Reads UsageProofRecord rows reported since `sinceIso`, computes per-path
   * deltas, and publishes Phase-C events that mutate the PathRelation rows.
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

    // Aggregate {used | skipped | not_applicable} counts per object_id so a
    // single path with multiple receipts in this window receives a single,
    // bounded delta rather than N separate audit events.
    const objectAggregates = await this.aggregateObjectUsage(usageRecords);

    const affected = new Set<string>();
    let reinforced = 0;
    let weakened = 0;
    let retired = 0;

    for (const [objectId, counts] of objectAggregates.entries()) {
      const anchorRef: PathAnchorRef = Object.freeze({
        kind: "object",
        object_id: objectId
      });
      const paths = await this.dependencies.pathRelationRepo.findByAnchor(
        params.workspaceId,
        anchorRef
      );

      for (const path of paths) {
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
    }

    return Object.freeze({
      reinforced,
      weakened,
      retired,
      affectedPathIds: Object.freeze([...affected])
    });
  }

  private async aggregateObjectUsage(
    usageRecords: readonly Readonly<UsageProofRecord>[]
  ): Promise<ReadonlyMap<string, ObjectUsageCounts>> {
    const aggregates = new Map<string, ObjectUsageCounts>();

    for (const record of usageRecords) {
      if (record.usage_state === "used") {
        for (const objectId of record.used_object_ids) {
          const counts = aggregates.get(objectId) ?? blankCounts();
          aggregates.set(objectId, { ...counts, used: counts.used + 1, lastReportedAt: maxIso(counts.lastReportedAt, record.reported_at) });
        }
      } else if (record.usage_state === "skipped") {
        // A skipped delivery weakens every object the agent had in hand —
        // not just the ones the agent cited as used. used_object_ids is
        // expected to be empty for skipped, so we resolve through delivery.
        const targets = record.used_object_ids.length > 0
          ? record.used_object_ids
          : (await this.dependencies.usageProofReader.findDeliveredObjectIds(record.delivery_id)) ?? [];
        for (const objectId of targets) {
          const counts = aggregates.get(objectId) ?? blankCounts();
          aggregates.set(objectId, { ...counts, skipped: counts.skipped + 1, lastReportedAt: maxIso(counts.lastReportedAt, record.reported_at) });
        }
      } else if (record.usage_state === "not_applicable") {
        // not_applicable does not move strength but it counts as a
        // contradiction signal against every targeted object.
        const targets = record.used_object_ids.length > 0
          ? record.used_object_ids
          : (await this.dependencies.usageProofReader.findDeliveredObjectIds(record.delivery_id)) ?? [];
        for (const objectId of targets) {
          const counts = aggregates.get(objectId) ?? blankCounts();
          aggregates.set(objectId, {
            ...counts,
            notApplicable: counts.notApplicable + 1,
            lastReportedAt: maxIso(counts.lastReportedAt, record.reported_at)
          });
        }
      }
    }

    return aggregates;
  }

  private async applyDeltasForPath(
    path: Readonly<PathRelation>,
    counts: ObjectUsageCounts
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
      if (
        nextStrength <= PATH_PLASTICITY_CONSTANTS.RETIREMENT_STRENGTH_THRESHOLD &&
        this.isInactive(path.plasticity_state.last_reinforced_at, occurredAt)
      ) {
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
        reason: "not_applicable_recurrence",
        occurredAt
      });
      return "weakened";
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

interface ObjectUsageCounts {
  readonly used: number;
  readonly skipped: number;
  readonly notApplicable: number;
  readonly lastReportedAt: string | null;
}

function blankCounts(): ObjectUsageCounts {
  return { used: 0, skipped: 0, notApplicable: 0, lastReportedAt: null };
}

function clampStrength(value: number): number {
  return Math.min(
    PATH_PLASTICITY_CONSTANTS.STRENGTH_CEILING,
    Math.max(PATH_PLASTICITY_CONSTANTS.STRENGTH_FLOOR, value)
  );
}

function maxIso(current: string | null, next: string): string {
  if (current === null) {
    return next;
  }
  return Date.parse(next) > Date.parse(current) ? next : current;
}

function parsePlasticityState(value: PathPlasticityState): Readonly<PathPlasticityState> {
  return PathPlasticityStateSchema.parse(value);
}
