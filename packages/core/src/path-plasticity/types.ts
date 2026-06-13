import type {
  DirectionBias,
  EventLogEntry,
  PathAnchorRef,
  PathLifecycleStatus,
  PathPlasticityState,
  PathRelation,
  SoulContextObjectIdentity,
  UsageProofRecord
} from "@do-soul/alaya-protocol";
import type { EventPublisher, EventPublisherInput } from "../runtime/event-publisher.js";
import type { PromotionPlan } from "../path-graph/path-manifestation-policy.js";

export interface UsageProofReaderPort {
  /** invariant: records are listed in `(sinceIso, untilIso]` so watermarks do not double-count. */
  listRecentUsage(
    workspaceId: string,
    sinceIso: string,
    untilIso?: string
  ): Promise<readonly Readonly<UsageProofRecord>[]>;

  /** Delivered identities include object_kind so capsules cannot credit memory-entry paths. */
  findDeliveredObjects?(
    deliveryId: string
  ): Promise<readonly SoulContextObjectIdentity[] | null>;

  /** Legacy fallback for deliveries persisted before object_kind was tracked. */
  findDeliveredObjectIds(deliveryId: string): Promise<readonly string[] | null>;
}

export interface PathPlasticityRepoPort {
  findByAnchor(
    workspaceId: string,
    anchorRef: PathAnchorRef
  ): Promise<readonly Readonly<PathRelation>[]>;
  /** Synchronous variant required by `appendManyWithMutation`'s sync-mutate contract. */
  update(
    pathId: string,
    updates: PathPlasticityRepoUpdate
  ): Readonly<PathRelation>;
}

export type PathPlasticityRepoUpdate = Partial<
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

export interface MutableObjectUsageCounts {
  used: number;
  usedWeight: number;
  skipped: number;
  notApplicable: number;
  sourceAnchorUsage: number;
  targetAnchorUsage: number;
  lastReportedAt: string | null;
}

export interface PathAggregate {
  readonly path: Readonly<PathRelation>;
  readonly counts: MutableObjectUsageCounts;
}

export interface DirectionalPathUsage {
  readonly path: Readonly<PathRelation>;
  readonly sourceUsed: boolean;
  readonly targetUsed: boolean;
}

export type MutableDirectionalPathUsage = DirectionalPathUsage;

export interface RedirectionPublication {
  readonly previousDirectionBias: DirectionBias;
  readonly newDirectionBias: DirectionBias;
  readonly sourceUsageCount: number;
  readonly targetUsageCount: number;
  readonly occurredAt: string;
}

export type PathPlasticityMutationOutcome =
  | "reinforced"
  | "weakened"
  | "retired"
  | "dormant"
  | "revived"
  | "redirected";

export interface PathPlasticityMutationPlan {
  readonly pathId: string;
  readonly outcome: PathPlasticityMutationOutcome;
  readonly eventInputs: readonly EventPublisherInput[];
  readonly updates: Readonly<PathPlasticityRepoUpdate>;
  readonly promotion: PromotionPlan;
}
