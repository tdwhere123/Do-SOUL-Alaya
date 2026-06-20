import {
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type PathPlasticityState,
  type PathRelation
} from "@do-soul/alaya-protocol";

import type { EventPublisherInput } from "../runtime/event-publisher.js";
import { classifyPathImportance } from "../manifestation/importance-gate.js";
import { type PromotionPlan } from "../path-graph/path-manifestation-policy.js";

import {
  buildUpdatesWithPromotion,
  withClearedSalience,
  withRestoredSalience
} from "./helpers.js";
import type {
  PathPlasticityMutationPlan,
  RedirectionPublication
} from "./types.js";

interface CreateReinforcedPlanParams {
  readonly path: Readonly<PathRelation>;
  readonly previousStrength: number;
  readonly nextStrength: number;
  readonly nextPlasticity: Readonly<PathPlasticityState>;
  readonly supportEventsCount: number;
  readonly redirection?: RedirectionPublication;
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
}

interface CreateWeakenedPlanParams {
  readonly path: Readonly<PathRelation>;
  readonly previousStrength: number;
  readonly nextStrength: number;
  readonly nextPlasticity: Readonly<PathPlasticityState>;
  readonly contradictionEventsCount: number;
  readonly reason: string;
  readonly redirection?: RedirectionPublication;
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
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

interface CreateDormantPlanParams {
  readonly path: Readonly<PathRelation>;
  readonly dormantStrength: number;
  readonly nextPlasticity: Readonly<PathPlasticityState>;
  readonly reason: string;
  readonly redirection?: RedirectionPublication;
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
}

interface CreateRevivedPlanParams {
  readonly path: Readonly<PathRelation>;
  readonly previousStrength: number;
  readonly revivedStrength: number;
  readonly nextPlasticity: Readonly<PathPlasticityState>;
  readonly trigger: string;
  readonly redirection?: RedirectionPublication;
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
}

interface CreateRedirectedPlanParams {
  readonly path: Readonly<PathRelation>;
  readonly nextPlasticity: Readonly<PathPlasticityState>;
  readonly redirection: RedirectionPublication;
  readonly promotion: PromotionPlan;
  readonly occurredAt: string;
}

// Pure: no IO, no clock; payloads come from the params.
export class MutationPlanFactory {
  public createReinforcedPlan(params: CreateReinforcedPlanParams): PathPlasticityMutationPlan {
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

  public createWeakenedPlan(params: CreateWeakenedPlanParams): PathPlasticityMutationPlan {
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

  public createRetiredPlan(params: CreateRetiredPlanParams): PathPlasticityMutationPlan {
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

  public createDormantPlan(params: CreateDormantPlanParams): PathPlasticityMutationPlan {
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

  public createRevivedPlan(params: CreateRevivedPlanParams): PathPlasticityMutationPlan {
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

  public createRedirectedPlan(params: CreateRedirectedPlanParams): PathPlasticityMutationPlan {
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

  public createRedirectionInputs(
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
        payload_json: { ...payload }
      }
    ];
  }
}
