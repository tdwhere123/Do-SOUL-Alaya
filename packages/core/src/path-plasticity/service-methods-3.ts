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
type PathPlasticityServiceMethodOwner = {
  now: () => string;
  dependencies: PathPlasticityServiceDependencies;
  [key: string]: any;
};


export function pathPlasticityServiceCreateDormantPlan(owner: PathPlasticityServiceMethodOwner, params: {
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
        ...owner.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_DORMANT,
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
        lifecycleStatus: "dormant",
        promotion: params.promotion,
        occurredAt: params.occurredAt,
        effectVector: withClearedSalience(params.path.effect_vector)
      }),
      promotion: params.promotion
    });
  }

export function pathPlasticityServiceCreateRevivedPlan(owner: PathPlasticityServiceMethodOwner, params: {
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
        ...owner.createRedirectionInputs(params.path, params.redirection),
        {
          event_type: RuntimeGovernanceEventType.PATH_RELATION_REVIVED,
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
        occurredAt: params.occurredAt,
        effectVector: withRestoredSalience(params.path.effect_vector, params.revivedStrength)
      }),
      promotion: params.promotion
    });
  }

export function pathPlasticityServiceCreateRedirectedPlan(owner: PathPlasticityServiceMethodOwner, params: {
    readonly path: Readonly<PathRelation>;
    readonly nextPlasticity: Readonly<PathPlasticityState>;
    readonly redirection: RedirectionPublication;
    readonly promotion: PromotionPlan;
    readonly occurredAt: string;
  }): PathPlasticityMutationPlan {
    return Object.freeze({
      pathId: params.path.path_id,
      outcome: "redirected",
      eventInputs: owner.createRedirectionInputs(params.path, params.redirection),
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

export function pathPlasticityServiceCreateRedirectionInputs(owner: PathPlasticityServiceMethodOwner, path: Readonly<PathRelation>, redirection: RedirectionPublication | undefined): readonly EventPublisherInput[] {
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
        payload_json: { ...payload }
      }
    ];
  }
