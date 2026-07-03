import {
  type PathPlasticityState,
  type PathRelation
} from "@do-soul/alaya-protocol";

import { type PromotionPlan, planPromotion } from "../path-graph/path-manifestation-policy.js";

import { PATH_PLASTICITY_CONSTANTS } from "./constants.js";
import {
  clampStrength,
  createRedirectionPublication,
  getContradictionExposureCount,
  getSupportExposureCount,
  isDormantPath,
  parsePlasticityState,
  selectDirectionBias,
  shouldRouteToDormant,
  throwIfPathPlasticityAborted
} from "./helpers.js";
import type { MutationPlanFactory } from "./mutation-plan-factory.js";
import type {
  MutableObjectUsageCounts,
  PathPlasticityMutationPlan,
  RedirectionPublication
} from "./types.js";

interface PathDeltaPlanningContext {
  readonly previousStrength: number;
  readonly proposedStrength: number;
  readonly occurredAt: string;
  readonly nextDirectionBias: PathPlasticityState["direction_bias"];
  readonly redirection?: RedirectionPublication;
  readonly nextSupportEventsCount: number;
  readonly nextContradictionEventsCount: number;
  readonly nextSupportExposureCount: number;
  readonly nextContradictionExposureCount: number;
  readonly promotion: PromotionPlan;
  readonly netDelta: number;
  readonly retirementEligible: boolean;
}

export interface PathDeltaPlannerDependencies {
  readonly factory: MutationPlanFactory;
  readonly now: () => string;
}

// Pure strength/lifecycle state machine: turns aggregated usage counts for one
// path into a mutation plan (reinforce / weaken / retire / dormant / revive /
// redirect) or null.
export class PathDeltaPlanner {
  private readonly factory: MutationPlanFactory;
  private readonly now: () => string;

  public constructor(deps: PathDeltaPlannerDependencies) {
    this.factory = deps.factory;
    this.now = deps.now;
  }

  public planDeltasForPath(
    path: Readonly<PathRelation>,
    counts: MutableObjectUsageCounts,
    abortSignal?: AbortSignal
  ): PathPlasticityMutationPlan | null {
    const planning = this.buildPathDeltaPlanningContext(path, counts, abortSignal);
    return (
      this.planDormantRevival(path, counts, planning) ??
      this.planPositiveStrengthDelta(path, planning) ??
      this.planNegativeStrengthDelta(path, counts, planning) ??
      this.planNotApplicableRecurrence(path, counts, planning) ??
      this.planFloorStrengthSkippedLifecycle(path, counts, planning) ??
      this.planRedirectionOnly(path, planning)
    );
  }

  public isInactive(lastReinforcedAt: string | undefined, nowIso: string): boolean {
    if (lastReinforcedAt === undefined) {
      return true;
    }
    const elapsedMs = Date.parse(nowIso) - Date.parse(lastReinforcedAt);
    return elapsedMs >= PATH_PLASTICITY_CONSTANTS.RETIREMENT_INACTIVITY_MS;
  }

  private buildPathDeltaPlanningContext(
    path: Readonly<PathRelation>,
    counts: MutableObjectUsageCounts,
    abortSignal?: AbortSignal
  ): PathDeltaPlanningContext {
    throwIfPathPlasticityAborted(abortSignal);
    const previousStrength = path.plasticity_state.strength;
    const proposedStrength = clampStrength(previousStrength + counts.usedWeight * PATH_PLASTICITY_CONSTANTS.USED_DELTA - counts.skipped * PATH_PLASTICITY_CONSTANTS.SKIPPED_DELTA);
    const occurredAt = this.now();
    const nextDirectionBias = selectDirectionBias(path.plasticity_state.direction_bias, counts);
    const nextSupportEventsCount = path.plasticity_state.support_events_count + counts.used;
    const nextContradictionEventsCount = path.plasticity_state.contradiction_events_count + counts.notApplicable;
    const nextSupportExposureCount = getSupportExposureCount(path.plasticity_state) + counts.usedWeight;
    const nextContradictionExposureCount =
      getContradictionExposureCount(path.plasticity_state) +
      counts.skipped +
      counts.notApplicable;
    return Object.freeze({
      previousStrength,
      proposedStrength,
      occurredAt,
      nextDirectionBias,
      redirection: createRedirectionPublication(path.plasticity_state.direction_bias, nextDirectionBias, counts, occurredAt),
      nextSupportEventsCount,
      nextContradictionEventsCount,
      nextSupportExposureCount,
      nextContradictionExposureCount,
      promotion: planPromotion({
        path,
        nextSupportEventsCount,
        nextContradictionEventsCount,
        nextSupportExposureCount,
        nextContradictionExposureCount
      }),
      netDelta: proposedStrength - previousStrength,
      retirementEligible: proposedStrength <= PATH_PLASTICITY_CONSTANTS.RETIREMENT_STRENGTH_THRESHOLD && this.isInactive(path.plasticity_state.last_reinforced_at, occurredAt)
    });
  }

  private planDormantRevival(
    path: Readonly<PathRelation>,
    counts: MutableObjectUsageCounts,
    planning: PathDeltaPlanningContext
  ): PathPlasticityMutationPlan | null {
    if (!isDormantPath(path) || counts.used <= 0) {
      return null;
    }
    const revivedStrength = clampStrength(PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH);
    return this.factory.createRevivedPlan({
      path,
      previousStrength: planning.previousStrength,
      revivedStrength,
      nextPlasticity: this.buildNextPlasticity(path, planning, {
        strength: revivedStrength,
        last_reinforced_at: planning.occurredAt
      }),
      trigger: "used_receipt",
      ...commonPlanArgs(planning)
    });
  }

  private planPositiveStrengthDelta(
    path: Readonly<PathRelation>,
    planning: PathDeltaPlanningContext
  ): PathPlasticityMutationPlan | null {
    if (planning.netDelta <= 0) {
      return null;
    }
    return this.factory.createReinforcedPlan({
      path,
      previousStrength: planning.previousStrength,
      nextStrength: planning.proposedStrength,
      nextPlasticity: this.buildNextPlasticity(path, planning, {
        strength: planning.proposedStrength,
        last_reinforced_at: planning.occurredAt
      }),
      supportEventsCount: planning.nextSupportEventsCount,
      ...commonPlanArgs(planning)
    });
  }

  private planNegativeStrengthDelta(
    path: Readonly<PathRelation>,
    counts: MutableObjectUsageCounts,
    planning: PathDeltaPlanningContext
  ): PathPlasticityMutationPlan | null {
    if (planning.netDelta >= 0) {
      return null;
    }
    const nextPlasticity = this.buildNextPlasticity(path, planning, {
      strength: planning.proposedStrength,
      last_weakened_at: planning.occurredAt
    });
    if (planning.retirementEligible) {
      return this.createDormantOrRetiredPlan(path, planning, nextPlasticity, planning.proposedStrength);
    }
    return this.factory.createWeakenedPlan({
      path,
      previousStrength: planning.previousStrength,
      nextStrength: planning.proposedStrength,
      nextPlasticity,
      contradictionEventsCount: planning.nextContradictionEventsCount,
      reason: counts.skipped > 0 ? "skipped_usage" : "contradiction_only",
      ...commonPlanArgs(planning)
    });
  }

  private planNotApplicableRecurrence(
    path: Readonly<PathRelation>,
    counts: MutableObjectUsageCounts,
    planning: PathDeltaPlanningContext
  ): PathPlasticityMutationPlan | null {
    if (counts.notApplicable <= 0) {
      return null;
    }
    return this.factory.createWeakenedPlan({
      path,
      previousStrength: planning.previousStrength,
      nextStrength: planning.previousStrength,
      nextPlasticity: this.buildNextPlasticity(path, planning, {
        last_weakened_at: planning.occurredAt
      }),
      contradictionEventsCount: planning.nextContradictionEventsCount,
      reason: "not_applicable_recurrence",
      ...commonPlanArgs(planning)
    });
  }

  private planFloorStrengthSkippedLifecycle(
    path: Readonly<PathRelation>,
    counts: MutableObjectUsageCounts,
    planning: PathDeltaPlanningContext
  ): PathPlasticityMutationPlan | null {
    if (!planning.retirementEligible || counts.skipped <= 0) {
      return null;
    }
    return this.createDormantOrRetiredPlan(
      path,
      planning,
      this.buildNextPlasticity(path, planning, {
        strength: planning.proposedStrength,
        last_weakened_at: planning.occurredAt
      }),
      planning.proposedStrength
    );
  }

  private planRedirectionOnly(
    path: Readonly<PathRelation>,
    planning: PathDeltaPlanningContext
  ): PathPlasticityMutationPlan | null {
    if (planning.redirection === undefined) {
      return null;
    }
    return this.factory.createRedirectedPlan({
      path,
      nextPlasticity: parsePlasticityState({
        ...path.plasticity_state,
        direction_bias: planning.nextDirectionBias
      }),
      redirection: planning.redirection,
      promotion: planning.promotion,
      occurredAt: planning.occurredAt
    });
  }

  private createDormantOrRetiredPlan(
    path: Readonly<PathRelation>,
    planning: PathDeltaPlanningContext,
    nextPlasticity: Readonly<PathPlasticityState>,
    nextStrength: number
  ): PathPlasticityMutationPlan {
    if (shouldRouteToDormant(path)) {
      return this.factory.createDormantPlan({
        path,
        dormantStrength: nextStrength,
        nextPlasticity,
        reason: "strength_below_threshold_and_inactive",
        ...commonPlanArgs(planning)
      });
    }
    return this.factory.createRetiredPlan({
      path,
      finalStrength: nextStrength,
      nextPlasticity,
      reason: "strength_below_threshold_and_inactive",
      ...commonPlanArgs(planning)
    });
  }

  private buildNextPlasticity(
    path: Readonly<PathRelation>,
    planning: PathDeltaPlanningContext,
    overrides: Partial<PathPlasticityState>
  ): Readonly<PathPlasticityState> {
    return parsePlasticityState({
      ...path.plasticity_state,
      direction_bias: planning.nextDirectionBias,
      support_events_count: planning.nextSupportEventsCount,
      contradiction_events_count: planning.nextContradictionEventsCount,
      support_exposure_count: planning.nextSupportExposureCount,
      contradiction_exposure_count: planning.nextContradictionExposureCount,
      ...overrides
    });
  }
}

function commonPlanArgs(planning: PathDeltaPlanningContext): Readonly<{
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
  readonly redirection?: RedirectionPublication;
}> {
  return Object.freeze({
    promotion: planning.promotion,
    occurredAt: planning.occurredAt,
    ...(planning.redirection === undefined ? {} : { redirection: planning.redirection })
  });
}
