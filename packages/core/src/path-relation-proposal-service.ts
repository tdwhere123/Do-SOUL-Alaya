import { randomUUID } from "node:crypto";
import {
  PathRelationSchema,
  type PathRelation
} from "@do-soul/alaya-protocol";

// invariant: PathRelationProposalService is the producer of PathRelation
// entities. When K co-usage events arrive for the same memory pair, this
// service writes a new PathRelation with default plasticity. The plasticity
// strength is later evolved by PathPlasticityService. Counter state is
// in-memory per daemon process (suitable for K small, e.g. 3).
// invariant: counter Map is unbounded. Long-running daemons should
// periodically clear stale counters (no current eviction policy).
// O(pairs_co_used²) memory. Acceptable for v0.3.8 because K=3 means
// once a pair is promoted, the counter is dropped; the only growth is
// pairs that co-occurred ≤ 2 times. v0.3.9 should add TTL-based eviction
// once production traces inform the right bound.
// see also: crossLinkRecalledMemories — caller hook
// see also: PathPlasticityService — strength evolution
// see also: PathRelationRepo — durable write side

export const PATH_RELATION_PROPOSE_THRESHOLD = 3;

export interface PathRelationProposalRepoPort {
  create(relation: PathRelation): Promise<Readonly<PathRelation>> | Readonly<PathRelation>;
  findByAnchorMemoryId?(
    memoryId: string,
    workspaceId: string
  ): Promise<readonly Readonly<PathRelation>[]>;
}

export interface PathRelationProposalServiceDeps {
  readonly repo: PathRelationProposalRepoPort;
  readonly threshold?: number;
  readonly now?: () => string;
  readonly generateId?: () => string;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

interface PairCounterKey {
  readonly workspaceId: string;
  readonly low: string;
  readonly high: string;
}

export class PathRelationProposalService {
  private readonly counters = new Map<string, number>();
  private readonly proposed = new Set<string>();
  private readonly threshold: number;
  private readonly now: () => string;
  private readonly generateId: () => string;

  public constructor(private readonly deps: PathRelationProposalServiceDeps) {
    this.threshold = deps.threshold ?? PATH_RELATION_PROPOSE_THRESHOLD;
    this.now = deps.now ?? (() => new Date().toISOString());
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
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const left = unique[i]!;
        const right = unique[j]!;
        const key = this.keyFor({ workspaceId, low: left, high: right });
        if (this.proposed.has(key)) {
          continue;
        }
        const next = (this.counters.get(key) ?? 0) + 1;
        this.counters.set(key, next);
        if (next < this.threshold) {
          continue;
        }
        try {
          await this.propose(workspaceId, left, right);
          this.proposed.add(key);
          this.counters.delete(key);
        } catch (err) {
          this.warn("PathRelation propose failed", {
            workspace_id: workspaceId,
            source_object_id: left,
            target_object_id: right,
            error: errorMessage(err)
          });
        }
      }
    }
  }

  private keyFor(key: PairCounterKey): string {
    return `${key.workspaceId}|${key.low}|${key.high}`;
  }

  private async propose(
    workspaceId: string,
    sourceMemoryId: string,
    targetMemoryId: string
  ): Promise<void> {
    if (this.deps.repo.findByAnchorMemoryId !== undefined) {
      const existing = await this.deps.repo.findByAnchorMemoryId(sourceMemoryId, workspaceId);
      const alreadyLinked = existing.some((relation) =>
        anchorPointsAt(relation, sourceMemoryId, targetMemoryId)
      );
      if (alreadyLinked) {
        return;
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
        governance_class: "recall_allowed"
      },
      created_at: occurredAt,
      updated_at: occurredAt
    });

    await this.deps.repo.create(relation);
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
