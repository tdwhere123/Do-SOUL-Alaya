import { z } from "zod";
import {
  BoundedLabelSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../shared/schema-primitives.js";
import { GovernanceResolutionPolicyClassificationSchema } from "../soul/governance-policy-classification.js";
import { SoulResolutionKindSchema } from "../soul/resolution.js";

// see also: packages/protocol/src/soul/governance-policy-classification.ts
export { GovernanceResolutionPolicyClassificationSchema };

// invariant: one event type per resolution kind so EventLog consumers
// can index by event_type without re-parsing the payload. The kind is
// also carried in the payload so a single-type consumer can branch on
// it, but the per-kind event types are the routing primitive.
// see also: packages/core/src/resolution-service.ts (producer)
const governanceResolutionEventTypeValues = [
  "soul.resolution.confirm_applied",
  "soul.resolution.reject_applied",
  "soul.resolution.correct_applied",
  "soul.resolution.stale_applied",
  "soul.resolution.defer_applied",
  "soul.resolution.not_relevant_applied"
] as const;

export const GovernanceResolutionEventType = {
  SOUL_RESOLUTION_CONFIRM_APPLIED: "soul.resolution.confirm_applied",
  SOUL_RESOLUTION_REJECT_APPLIED: "soul.resolution.reject_applied",
  SOUL_RESOLUTION_CORRECT_APPLIED: "soul.resolution.correct_applied",
  SOUL_RESOLUTION_STALE_APPLIED: "soul.resolution.stale_applied",
  SOUL_RESOLUTION_DEFER_APPLIED: "soul.resolution.defer_applied",
  SOUL_RESOLUTION_NOT_RELEVANT_APPLIED: "soul.resolution.not_relevant_applied"
} as const;

export const GovernanceResolutionEventTypeSchema = z.enum(
  governanceResolutionEventTypeValues
);

// invariant: resolution-kind → event-type mapping. Single source of
// truth so callers cannot drift.
export const RESOLUTION_KIND_TO_EVENT_TYPE: Readonly<
  Record<z.infer<typeof SoulResolutionKindSchema>, z.infer<typeof GovernanceResolutionEventTypeSchema>>
> = Object.freeze({
  confirm: GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED,
  reject: GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED,
  correct: GovernanceResolutionEventType.SOUL_RESOLUTION_CORRECT_APPLIED,
  stale: GovernanceResolutionEventType.SOUL_RESOLUTION_STALE_APPLIED,
  defer: GovernanceResolutionEventType.SOUL_RESOLUTION_DEFER_APPLIED,
  not_relevant: GovernanceResolutionEventType.SOUL_RESOLUTION_NOT_RELEVANT_APPLIED
});

// invariant: shared payload shape across all six resolution events.
// `policy_classification` is the GovernancePolicy outcome that routed
// the warning to the agent (ask_now / apply_silently / track_only /
// inspect_later); the resolve handler echoes it so EventLog readers
// can correlate the resolution with the policy decision.

const GovernanceResolutionPayloadObjectSchema = z.object({
  target_object_id: NonEmptyStringSchema,
  resolution: SoulResolutionKindSchema,
  workspace_id: NonEmptyStringSchema,
  run_id: NonEmptyStringSchema.nullable(),
  agent_target: NonEmptyStringSchema,
  delivery_id: NonEmptyStringSchema,
  policy: BoundedLabelSchema.nullable(),
  policy_classification: GovernanceResolutionPolicyClassificationSchema.nullable(),
  reason: BoundedReasonSchema.nullable(),
  obligation_id: NonEmptyStringSchema.nullable(),
  activated_claim_id: NonEmptyStringSchema.nullable(),
  occurred_at: IsoDatetimeStringSchema
});

export const GovernanceResolutionPayloadSchema =
  GovernanceResolutionPayloadObjectSchema.readonly();

const governanceResolutionPayloadSchemas = {
  [GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED]:
    GovernanceResolutionPayloadSchema,
  [GovernanceResolutionEventType.SOUL_RESOLUTION_REJECT_APPLIED]:
    GovernanceResolutionPayloadSchema,
  [GovernanceResolutionEventType.SOUL_RESOLUTION_CORRECT_APPLIED]:
    GovernanceResolutionPayloadSchema,
  [GovernanceResolutionEventType.SOUL_RESOLUTION_STALE_APPLIED]:
    GovernanceResolutionPayloadSchema,
  [GovernanceResolutionEventType.SOUL_RESOLUTION_DEFER_APPLIED]:
    GovernanceResolutionPayloadSchema,
  [GovernanceResolutionEventType.SOUL_RESOLUTION_NOT_RELEVANT_APPLIED]:
    GovernanceResolutionPayloadSchema
} as const;

export type GovernanceResolutionEventPayloadMap = {
  [K in keyof typeof governanceResolutionPayloadSchemas]: z.infer<
    (typeof governanceResolutionPayloadSchemas)[K]
  >;
};

export function parseGovernanceResolutionEventPayload<
  T extends keyof typeof governanceResolutionPayloadSchemas
>(
  eventType: T,
  payload: Record<string, unknown>
): GovernanceResolutionEventPayloadMap[T] {
  const schema = governanceResolutionPayloadSchemas[eventType];
  return schema.parse(payload) as GovernanceResolutionEventPayloadMap[T];
}

export type GovernanceResolutionEventType = z.infer<
  typeof GovernanceResolutionEventTypeSchema
>;
export type GovernanceResolutionPolicyClassification = z.infer<
  typeof GovernanceResolutionPolicyClassificationSchema
>;
export type GovernanceResolutionPayload = z.infer<
  typeof GovernanceResolutionPayloadSchema
>;
