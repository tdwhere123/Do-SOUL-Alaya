import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  PathRelationSchema,
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type EventLogEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type { EventPublisher, EventPublisherInput } from "./event-publisher.js";

// invariant: PathRelationProposalService is the producer of PathRelation
// entities. When K co-usage events arrive for the same memory pair, this
// service writes a new PathRelation with default plasticity. The plasticity
// strength is later evolved by PathPlasticityService. invariant: counter
// state is durable via CoUsageCounterPort; counts toward the threshold are
// persisted, not held in process memory.
// invariant: a co-usage path is born at governance_class=attention_only,
// not recall_allowed. attention_only authorises only the lens_entry
// manifestation level and earns no recall-expansion governance boost — the
// path is auditable but cannot silently bias agent dialogue. Agents
// propose; Alaya decides durable recall topology. A co-usage path reaches
// recall_allowed only by accruing support_events_count >= 8 through the
// legitimate path-manifestation-policy ladder, which PathPlasticityService
// drives from anchor-matched usage receipts independently of this
// service's co-usage counter.
// invariant: counter rows carry updated_at timestamps so the daemon can
// periodically call evictExpired(now, ttlMs) to discard stale pairs that
// never reached the threshold. A pair that reaches the threshold has its
// counter row dropped once its PathRelation is written; durable double-propose
// protection comes from findByAnchorMemoryId against persisted PathRelations.
// invariant: row insert and `path.relation_created` EventLog row are
// emitted in one SQLite transaction via EventPublisher.appendManyWithMutation,
// matching the PathPlasticityService pattern. Crash-mid-write cannot leave
// a path_relations row without its audit event or vice versa.
// see also: crossLinkRecalledMemories — caller hook
// see also: PathPlasticityService — strength evolution
// see also: PathRelationRepo — durable write side
// see also: SqliteCoUsageCounterRepo — durable counter backing

export const PATH_RELATION_PROPOSE_THRESHOLD =
  DYNAMICS_CONSTANTS.path_plasticity.co_usage_threshold;
export const PATH_RELATION_COUNTER_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PathRelationProposalRepoPort {
  create(relation: PathRelation): Readonly<PathRelation>;
  findByAnchorMemoryId?(
    memoryId: string,
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
}

// invariant: durable counter backing. The daemon wires this to the SQLite
// co-usage counter repo; tests may supply an in-memory fake. Memory ids are
// already ordered low <= high by the service before reaching this port.
export interface CoUsageCounterPort {
  increment(input: {
    readonly workspaceId: string;
    readonly lowMemoryId: string;
    readonly highMemoryId: string;
    readonly seenAt: string;
  }): number | Promise<number>;
  delete(workspaceId: string, lowMemoryId: string, highMemoryId: string): void | Promise<void>;
  evictExpired(cutoff: string): number | Promise<number>;
  size(): number | Promise<number>;
}

export type PathRelationProposalEventPublisherPort = Pick<
  EventPublisher,
  "appendManyWithMutation"
>;

export interface PathRelationProposalServiceDeps {
  readonly repo: PathRelationProposalRepoPort;
  readonly counterStore: CoUsageCounterPort;
  readonly eventPublisher: PathRelationProposalEventPublisherPort;
  readonly threshold?: number;
  readonly now?: () => string;
  readonly nowMs?: () => number;
  readonly counterTtlMs?: number;
  readonly generateId?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export class PathRelationProposalService {
  private readonly counterStore: CoUsageCounterPort;
  private readonly threshold: number;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly counterTtlMs: number;
  private readonly generateId: () => string;

  public constructor(private readonly deps: PathRelationProposalServiceDeps) {
    this.counterStore = deps.counterStore;
    this.threshold = deps.threshold ?? PATH_RELATION_PROPOSE_THRESHOLD;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.counterTtlMs = deps.counterTtlMs ?? PATH_RELATION_COUNTER_DEFAULT_TTL_MS;
    this.generateId = deps.generateId ?? (() => randomUUID());
  }

  public async onCoUsage(
    usedObjectIds: readonly string[],
    workspaceId: string
  ): Promise<void> {
    if (usedObjectIds.length < 2) {
      return;
    }
    const unique = [...new Set(usedObjectIds)].sort();
    const seenAt = this.now();
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const low = unique[i]!;
        const high = unique[j]!;
        const count = await this.counterStore.increment({
          workspaceId,
          lowMemoryId: low,
          highMemoryId: high,
          seenAt
        });
        if (count < this.threshold) {
          continue;
        }
        try {
          const proposed = await this.propose(workspaceId, low, high);
          if (proposed) {
            await this.counterStore.delete(workspaceId, low, high);
          }
        } catch (err) {
          this.warn("PathRelation propose failed", {
            workspace_id: workspaceId,
            source_object_id: low,
            target_object_id: high,
            error: errorMessage(err)
          });
        }
      }
    }
  }

  public async evictExpired(nowMs?: number, ttlMs?: number): Promise<number> {
    const cutoffMs = (nowMs ?? this.nowMs()) - (ttlMs ?? this.counterTtlMs);
    return await this.counterStore.evictExpired(new Date(cutoffMs).toISOString());
  }

  public async counterSize(): Promise<number> {
    return await this.counterStore.size();
  }

  private async propose(
    workspaceId: string,
    sourceMemoryId: string,
    targetMemoryId: string
  ): Promise<boolean> {
    if (this.deps.repo.findByAnchorMemoryId !== undefined) {
      const existing = await this.deps.repo.findByAnchorMemoryId(sourceMemoryId, workspaceId);
      const alreadyLinked = existing.some((relation) =>
        anchorPointsAt(relation, sourceMemoryId, targetMemoryId)
      );
      if (alreadyLinked) {
        // Counter row is stale once a durable path exists; drop it so the
        // pair stops re-querying on every future co-usage.
        return true;
      }
    }

    const occurredAt = this.now();
    const relation: PathRelation = PathRelationSchema.parse({
      path_id: this.generateId(),
      workspace_id: workspaceId,
      anchors: {
        source_anchor: { kind: "object", object_id: sourceMemoryId },
        target_anchor: { kind: "object", object_id: targetMemoryId }
      },
      constitution: {
        relation_kind: "supports_recall",
        why_this_relation_exists: [
          `co-recalled-used >= ${this.threshold} times`
        ]
      },
      effect_vector: {
        salience: 0.5,
        recall_bias: 0.5,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "lens_entry"
      },
      plasticity_state: {
        strength: 0.3,
        direction_bias: "bidirectional_asymmetric",
        stability_class: "stable",
        support_events_count: this.threshold,
        contradiction_events_count: 0
      },
      lifecycle: {
        status: "active",
        retirement_rule: "manual"
      },
      legitimacy: {
        evidence_basis: ["recalls_edge_co_usage"],
        // see also: path-manifestation-policy.ts GOVERNANCE_PROMOTION_THRESHOLDS
        governance_class: "attention_only"
      },
      created_at: occurredAt,
      updated_at: occurredAt
    });

    const payload = parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      {
        path_id: relation.path_id,
        workspace_id: relation.workspace_id,
        relation_kind: relation.constitution.relation_kind,
        source_anchor_kind: relation.anchors.source_anchor.kind,
        target_anchor_kind: relation.anchors.target_anchor.kind,
        initial_strength: relation.plasticity_state.strength,
        governance_class: relation.legitimacy.governance_class,
        created_at: relation.created_at
      }
    );

    const eventInput: EventPublisherInput = {
      event_type: RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      entity_type: "path_relation",
      entity_id: relation.path_id,
      workspace_id: relation.workspace_id,
      run_id: null,
      caused_by: "system",
      payload_json: payload as unknown as Record<string, unknown>
    };

    await this.deps.eventPublisher.appendManyWithMutation(
      [eventInput],
      (_entries: readonly EventLogEntry[]) => {
        this.deps.repo.create(relation);
      }
    );
    return true;
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    if (this.deps.warn !== undefined) {
      this.deps.warn(message, meta);
    }
  }
}

function anchorPointsAt(
  relation: Readonly<PathRelation>,
  memoryA: string,
  memoryB: string
): boolean {
  const source = anchorObjectId(relation.anchors.source_anchor);
  const target = anchorObjectId(relation.anchors.target_anchor);
  if (source === undefined || target === undefined) {
    return false;
  }
  return (
    (source === memoryA && target === memoryB) ||
    (source === memoryB && target === memoryA)
  );
}

function anchorObjectId(anchor: PathRelation["anchors"]["source_anchor"]): string | undefined {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
    default:
      return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
