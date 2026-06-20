import {
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type PathPlasticityState,
  type PathRelation} from "@do-soul/alaya-protocol";


import { classifyPathImportance } from "../manifestation/importance-gate.js";

import { planPromotion, type PromotionPlan } from "../path-graph/path-manifestation-policy.js";

import { PATH_PLASTICITY_CONSTANTS } from "./constants.js";

import {
  buildUpdatesWithPromotion,
  clampStrength,
  createRedirectionPublication,
  isDormantPath,
  parsePlasticityState,
  selectDirectionBias,
  shouldRouteToDormant,
  throwIfPathPlasticityAborted} from "./helpers.js";

import type {
  MutableObjectUsageCounts,
  PathPlasticityMutationPlan,
  PathPlasticityServiceDependencies,
  RedirectionPublication
} from "./types.js";
type PathPlasticityServiceMethodOwner = {
  now: () => string;
  dependencies: PathPlasticityServiceDependencies;
  [key: string]: any;
};

interface PathDeltaPlanningContext {
  readonly previousStrength: number;
  readonly proposedStrength: number;
  readonly occurredAt: string;
  readonly nextDirectionBias: PathPlasticityState["direction_bias"];
  readonly redirection?: RedirectionPublication;
  readonly nextSupportEventsCount: number;
  readonly nextContradictionEventsCount: number;
  readonly promotion: PromotionPlan;
  readonly netDelta: number;
  readonly retirementEligible: boolean;
}

interface CreateRetiredPlanParams {
  readonly path: Readonly<PathRelation>;
  readonly finalStrength: number;
  readonly nextPlasticity: Readonly<PathPlasticityState>;
  readonly reason: string;
  readonly redirection?: RedirectionPublication;
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
}

export function pathPlasticityServicePlanDeltasForPath(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, counts: MutableObjectUsageCounts, abortSignal?: AbortSignal): PathPlasticityMutationPlan | null {
    const planning = buildPathDeltaPlanningContext(owner, path, counts, abortSignal);
    return (
      planDormantRevival(owner, path, counts, planning) ??
      planPositiveStrengthDelta(owner, path, planning) ??
      planNegativeStrengthDelta(owner, path, counts, planning) ??
      planNotApplicableRecurrence(owner, path, counts, planning) ??
      planFloorStrengthSkippedLifecycle(owner, path, counts, planning) ??
      planRedirectionOnly(owner, path, planning)
    );
  }

function buildPathDeltaPlanningContext(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, counts: MutableObjectUsageCounts, abortSignal?: AbortSignal): PathDeltaPlanningContext {
    throwIfPathPlasticityAborted(abortSignal);
    const previousStrength = path.plasticity_state.strength;
    const proposedStrength = clampStrength(previousStrength + counts.usedWeight * PATH_PLASTICITY_CONSTANTS.USED_DELTA - counts.skipped * PATH_PLASTICITY_CONSTANTS.SKIPPED_DELTA);
    const occurredAt = owner.now();
    const nextDirectionBias = selectDirectionBias(path.plasticity_state.direction_bias, counts);
    const nextSupportEventsCount = path.plasticity_state.support_events_count + counts.used;
    const nextContradictionEventsCount = path.plasticity_state.contradiction_events_count + counts.notApplicable;
    return Object.freeze({
      previousStrength,
      proposedStrength,
      occurredAt,
      nextDirectionBias,
      redirection: createRedirectionPublication(path.plasticity_state.direction_bias, nextDirectionBias, counts, occurredAt),
      nextSupportEventsCount,
      nextContradictionEventsCount,
      promotion: planPromotion({ path, nextSupportEventsCount, nextContradictionEventsCount }),
      netDelta: proposedStrength - previousStrength,
      retirementEligible: proposedStrength <= PATH_PLASTICITY_CONSTANTS.RETIREMENT_STRENGTH_THRESHOLD && owner.isInactive(path.plasticity_state.last_reinforced_at, occurredAt)
    });
  }

function planDormantRevival(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, counts: MutableObjectUsageCounts, planning: PathDeltaPlanningContext): PathPlasticityMutationPlan | null {
    if (!isDormantPath(path) || counts.used <= 0) {
      return null;
    }
    const revivedStrength = clampStrength(PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH);
    return owner.createRevivedPlan({
      path,
      previousStrength: planning.previousStrength,
      revivedStrength,
      nextPlasticity: buildNextPlasticity(path, planning, {
        strength: revivedStrength,
        last_reinforced_at: planning.occurredAt
      }),
      trigger: "used_receipt",
      ...commonPlanArgs(planning)
    });
  }

function planPositiveStrengthDelta(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, planning: PathDeltaPlanningContext): PathPlasticityMutationPlan | null {
    if (planning.netDelta <= 0) {
      return null;
    }
    return owner.createReinforcedPlan({
      path,
      previousStrength: planning.previousStrength,
      nextStrength: planning.proposedStrength,
      nextPlasticity: buildNextPlasticity(path, planning, {
        strength: planning.proposedStrength,
        last_reinforced_at: planning.occurredAt
      }),
      supportEventsCount: planning.nextSupportEventsCount,
      ...commonPlanArgs(planning)
    });
  }

function planNegativeStrengthDelta(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, counts: MutableObjectUsageCounts, planning: PathDeltaPlanningContext): PathPlasticityMutationPlan | null {
    if (planning.netDelta >= 0) {
      return null;
    }
    const nextPlasticity = buildNextPlasticity(path, planning, {
      strength: planning.proposedStrength,
      last_weakened_at: planning.occurredAt
    });
    if (planning.retirementEligible) {
      return createDormantOrRetiredPlan(owner, path, planning, nextPlasticity, planning.proposedStrength);
    }
    return owner.createWeakenedPlan({
      path,
      previousStrength: planning.previousStrength,
      nextStrength: planning.proposedStrength,
      nextPlasticity,
      contradictionEventsCount: planning.nextContradictionEventsCount,
      reason: counts.skipped > 0 ? "skipped_usage" : "contradiction_only",
      ...commonPlanArgs(planning)
    });
  }

function planNotApplicableRecurrence(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, counts: MutableObjectUsageCounts, planning: PathDeltaPlanningContext): PathPlasticityMutationPlan | null {
    if (counts.notApplicable <= 0) {
      return null;
    }
    return owner.createWeakenedPlan({
      path,
      previousStrength: planning.previousStrength,
      nextStrength: planning.previousStrength,
      nextPlasticity: buildNextPlasticity(path, planning, {
        last_weakened_at: planning.occurredAt
      }),
      contradictionEventsCount: planning.nextContradictionEventsCount,
      reason: "not_applicable_recurrence",
      ...commonPlanArgs(planning)
    });
  }

function planFloorStrengthSkippedLifecycle(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, counts: MutableObjectUsageCounts, planning: PathDeltaPlanningContext): PathPlasticityMutationPlan | null {
    if (!planning.retirementEligible || counts.skipped <= 0) {
      return null;
    }
    return createDormantOrRetiredPlan(
      owner,
      path,
      planning,
      buildNextPlasticity(path, planning, {
        strength: planning.proposedStrength,
        last_weakened_at: planning.occurredAt
      }),
      planning.proposedStrength
    );
  }

function planRedirectionOnly(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, planning: PathDeltaPlanningContext): PathPlasticityMutationPlan | null {
    if (planning.redirection === undefined) {
      return null;
    }
    return owner.createRedirectedPlan({
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

function createDormantOrRetiredPlan(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, planning: PathDeltaPlanningContext, nextPlasticity: Readonly<PathPlasticityState>, nextStrength: number): PathPlasticityMutationPlan {
    if (shouldRouteToDormant(path)) {
      return owner.createDormantPlan({
        path,
        dormantStrength: nextStrength,
        nextPlasticity,
        reason: "strength_below_threshold_and_inactive",
        ...commonPlanArgs(planning)
      });
    }
    return owner.createRetiredPlan({
      path,
      finalStrength: nextStrength,
      nextPlasticity,
      reason: "strength_below_threshold_and_inactive",
      ...commonPlanArgs(planning)
    });
  }

function buildNextPlasticity(path: Readonly<PathRelation>, planning: PathDeltaPlanningContext, overrides: Partial<PathPlasticityState>): Readonly<PathPlasticityState> {
    return parsePlasticityState({
      ...path.plasticity_state,
      direction_bias: planning.nextDirectionBias,
      support_events_count: planning.nextSupportEventsCount,
      contradiction_events_count: planning.nextContradictionEventsCount,
      ...overrides
    });
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

export function pathPlasticityServiceIsInactive(owner: PathPlasticityServiceMethodOwner, lastReinforcedAt: string | undefined, nowIso: string): boolean {
    if (lastReinforcedAt === undefined) {
      return true;
    }
    const elapsedMs = Date.parse(nowIso) - Date.parse(lastReinforcedAt);
    return elapsedMs >= PATH_PLASTICITY_CONSTANTS.RETIREMENT_INACTIVITY_MS;
  }

export function pathPlasticityServiceApplyMutationPlans(owner: PathPlasticityServiceMethodOwner, plans: readonly PathPlasticityMutationPlan[], abortSignal?: AbortSignal, onMutationBoundaryEntered?: () => void): void {
    if (plans.length === 0) {
      return;
    }

    throwIfPathPlasticityAborted(abortSignal);
    onMutationBoundaryEntered?.();
    throwIfPathPlasticityAborted(abortSignal);
    owner.dependencies.eventPublisher.appendManyWithMutationAndDetachPropagation(
      plans.flatMap((plan) => plan.eventInputs),
      () => {
        for (const plan of plans) {
          owner.dependencies.pathRelationRepo.update(plan.pathId, plan.updates);
        }
      }
    );
  }

export function pathPlasticityServiceCreateReinforcedPlan(owner: PathPlasticityServiceMethodOwner, params: {
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
        ...owner.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_REINFORCED,
          entity_type: "path_relation",
          entity_id: params.path.path_id,
          workspace_id: params.path.workspace_id,
          run_id: null,
          caused_by: "system",
          payload_json: { ...payload }
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

export function pathPlasticityServiceCreateWeakenedPlan(owner: PathPlasticityServiceMethodOwner, params: {
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
        ...owner.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_WEAKENED,
          entity_type: "path_relation",
          entity_id: params.path.path_id,
          workspace_id: params.path.workspace_id,
          run_id: null,
          caused_by: "system",
          payload_json: { ...payload }
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

export function pathPlasticityServiceCreateRetiredPlan(owner: PathPlasticityServiceMethodOwner, params: CreateRetiredPlanParams): PathPlasticityMutationPlan {
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
        ...owner.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
          entity_type: "path_relation",
          entity_id: params.path.path_id,
          workspace_id: params.path.workspace_id,
          run_id: null,
          caused_by: "system",
          payload_json: { ...payload }
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
