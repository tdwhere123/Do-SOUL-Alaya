import {
  type PathPlasticityState,
  type PathRelation,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type { EventPublisherInput } from "../runtime/event-publisher.js";
import { type PromotionPlan } from "../path-graph/path-manifestation-policy.js";
import type {
  DirectionalPathUsage,
  MutableObjectUsageCounts,
  PathAggregate,
  PathPlasticityComputeResult,
  PathPlasticityMutationPlan,
  PathPlasticityServiceDependencies,
  RedirectionPublication
} from "./types.js";

import { pathPlasticityServiceComputeAndApplyPlasticity, pathPlasticityServiceAggregatePathUsage, pathPlasticityServiceResolveDeliveredMemoryObjectIds, pathPlasticityServiceResolveDirectionalPathUsage } from "./service-methods-1.js";
import { pathPlasticityServicePlanDeltasForPath, pathPlasticityServiceIsInactive, pathPlasticityServiceApplyMutationPlans, pathPlasticityServiceCreateReinforcedPlan, pathPlasticityServiceCreateWeakenedPlan, pathPlasticityServiceCreateRetiredPlan } from "./service-methods-2.js";
import { pathPlasticityServiceCreateDormantPlan, pathPlasticityServiceCreateRevivedPlan, pathPlasticityServiceCreateRedirectedPlan, pathPlasticityServiceCreateRedirectionInputs } from "./service-methods-3.js";

export class PathPlasticityService {
public readonly now: () => string;

public constructor(public readonly dependencies: PathPlasticityServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async computeAndApplyPlasticity(params: {
    readonly workspaceId: string;
    readonly sinceIso: string;
    readonly untilIso?: string;
    readonly abortSignal?: AbortSignal;
    readonly onMutationBoundaryEntered?: () => void;
  }): Promise<PathPlasticityComputeResult> {
    return pathPlasticityServiceComputeAndApplyPlasticity(this, params);
  }

  private async aggregatePathUsage(workspaceId: string, usageRecords: readonly Readonly<UsageProofRecord>[], abortSignal?: AbortSignal): Promise<ReadonlyMap<string, PathAggregate>> {
    return pathPlasticityServiceAggregatePathUsage(this, workspaceId, usageRecords, abortSignal);
  }

  private async resolveDeliveredMemoryObjectIds(deliveryId: string): Promise<readonly string[]> {
    return pathPlasticityServiceResolveDeliveredMemoryObjectIds(this, deliveryId);
  }

  private async resolveDirectionalPathUsage(workspaceId: string, record: Readonly<UsageProofRecord>, abortSignal?: AbortSignal): Promise<ReadonlyMap<string, DirectionalPathUsage>> {
    return pathPlasticityServiceResolveDirectionalPathUsage(this, workspaceId, record, abortSignal);
  }

  private planDeltasForPath(path: Readonly<PathRelation>, counts: MutableObjectUsageCounts, abortSignal?: AbortSignal): PathPlasticityMutationPlan | null {
    return pathPlasticityServicePlanDeltasForPath(this, path, counts, abortSignal);
  }

  private isInactive(lastReinforcedAt: string | undefined, nowIso: string): boolean {
    return pathPlasticityServiceIsInactive(this, lastReinforcedAt, nowIso);
  }

  private applyMutationPlans(plans: readonly PathPlasticityMutationPlan[], abortSignal?: AbortSignal, onMutationBoundaryEntered?: () => void): void {
    return pathPlasticityServiceApplyMutationPlans(this, plans, abortSignal, onMutationBoundaryEntered);
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
    return pathPlasticityServiceCreateReinforcedPlan(this, params);
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
    return pathPlasticityServiceCreateWeakenedPlan(this, params);
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
    return pathPlasticityServiceCreateRetiredPlan(this, params);
  }

  private createDormantPlan(params: {
    readonly path: Readonly<PathRelation>;
    readonly dormantStrength: number;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly reason: string;
    readonly redirection?: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    return pathPlasticityServiceCreateDormantPlan(this, params);
  }

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
    return pathPlasticityServiceCreateRevivedPlan(this, params);
  }

  private createRedirectedPlan(params: {
    readonly path: Readonly<PathRelation>;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly redirection: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    return pathPlasticityServiceCreateRedirectedPlan(this, params);
  }

  private createRedirectionInputs(path: Readonly<PathRelation>, redirection: RedirectionPublication | undefined): readonly EventPublisherInput[] {
    return pathPlasticityServiceCreateRedirectionInputs(this, path, redirection);
  }
}
