import {
  FieldGenerationEventType,
  SoulFieldEffectDecidedPayloadSchema,
  type EffectDecisionReceipt
} from "@do-soul/alaya-protocol";
import type { EventPublisherInput } from "../../runtime/event-publisher.js";
import { CoreError } from "../../shared/errors.js";
import type { ResolveInput } from "./resolution-service-types.js";

export interface ResolutionDeliveryAuthorityPort {
  authorize(input: Readonly<{
    workspaceId: string;
    actorId: string;
    runId: string | null;
    deliveryId: string;
    targetObjectId: string;
  }>): Promise<Readonly<{ deliveredAt: string }> | null>;
}

export interface ResolutionEffectAuthorityPort {
  decide(input: Readonly<{
    workspaceId: string;
    actorId: string;
    runId: string;
    deliveryId: string;
    targetObjectId: string;
    scope: string;
    effectiveAsOf: string;
    action: "activate" | "revoke" | "correct";
    correction?: string;
  }>): Promise<EffectDecisionReceipt>;
}

export interface ResolutionEffectDependencies {
  readonly effectAuthority: ResolutionEffectAuthorityPort;
}

export async function requireDeliveryAuthority(
  authority: ResolutionDeliveryAuthorityPort,
  input: ResolveInput
): Promise<Readonly<{ deliveredAt: string }>> {
  const authorized = await authority.authorize({
    workspaceId: input.workspaceId,
    actorId: input.agentTarget,
    runId: input.runId,
    deliveryId: input.deliveryId,
    targetObjectId: input.targetObjectId
  });
  if (authorized === null || !Number.isFinite(Date.parse(authorized.deliveredAt))) {
    throw new CoreError("VALIDATION", "Delivery authority does not match the resolution context");
  }
  return authorized;
}

export async function decideClaimEffect(
  dependencies: ResolutionEffectDependencies,
  input: ResolveInput,
  action: "activate" | "revoke" | "correct",
  effectiveAsOf: string,
  correction?: string
): Promise<EffectDecisionReceipt> {
  if (input.runId === null) {
    throw new CoreError("VALIDATION", "Governed claim effects require a bound run_id");
  }
  return await dependencies.effectAuthority.decide({
    workspaceId: input.workspaceId,
    actorId: input.agentTarget,
    runId: input.runId,
    deliveryId: input.deliveryId,
    targetObjectId: input.targetObjectId,
    scope: input.workspaceId,
    effectiveAsOf,
    action,
    ...(correction === undefined ? {} : { correction })
  });
}

export function buildEffectAuditEventInput(
  decision: EffectDecisionReceipt
): EventPublisherInput {
  return {
    event_type: FieldGenerationEventType.SOUL_FIELD_EFFECT_DECIDED,
    entity_type: "proof_effect_decision",
    entity_id: decision.request_digest,
    workspace_id: decision.workspace_id,
    run_id: decision.run_id,
    caused_by: decision.actor_id,
    payload_json: SoulFieldEffectDecidedPayloadSchema.parse({
      workspace_id: decision.workspace_id,
      request_digest: decision.request_digest,
      action: decision.action,
      target: decision.target,
      scope: decision.scope,
      effective_as_of: decision.effective_as_of,
      decision: decision.decision,
      occurred_at: decision.recorded_at
    })
  };
}
