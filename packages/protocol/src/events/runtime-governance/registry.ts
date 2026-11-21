import { z } from "zod";
import * as Payloads from "./payloads.js";
import { RuntimeGovernanceEventType, runtimeGovernancePayloadSchemas } from "./payloads.js";

type PayloadSchemas = typeof runtimeGovernancePayloadSchemas;
type EventType = keyof PayloadSchemas;

function createEventObjectSchema<T extends EventType>(type: T) {
  return z.object({
    type: z.literal(type),
    payload: runtimeGovernancePayloadSchemas[type]
  });
}

type EventObjectSchemas = { [T in EventType]: ReturnType<typeof createEventObjectSchema<T>> };

// Object.keys and fromEntries erase the key/schema association.
const eventObjects = Object.fromEntries(
  (Object.keys(runtimeGovernancePayloadSchemas) as EventType[]).map((type) => [type, createEventObjectSchema(type)])
) as EventObjectSchemas;

export const CanonicalizationAppliedEventSchema =
  eventObjects[RuntimeGovernanceEventType.CANONICALIZATION_APPLIED].readonly();
export const CanonicalizationAliasResolvedEventSchema =
  eventObjects[RuntimeGovernanceEventType.CANONICALIZATION_ALIAS_RESOLVED].readonly();
export const StancePolicyEvaluatedEventSchema =
  eventObjects[RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED].readonly();
export const StanceResolutionChangedEventSchema =
  eventObjects[RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED].readonly();
export const ComputeProviderRoutedEventSchema =
  eventObjects[RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED].readonly();
export const BootstrappingPathsPlantedEventSchema =
  eventObjects[RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED].readonly();
export const PathRelationCreatedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_CREATED].readonly();
export const PathRelationRejectedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_REJECTED].readonly();
export const PathRelationLegitimacyUpdatedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED].readonly();
export const PathRelationReinforcedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_REINFORCED].readonly();
export const PathRelationWeakenedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_WEAKENED].readonly();
export const PathRelationRedirectedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED].readonly();
export const PathRelationRetiredEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_RETIRED].readonly();
export const PathRelationDormantEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_DORMANT].readonly();
export const PathRelationRevivedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_REVIVED].readonly();
export const PathRelationMergedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_RELATION_MERGED].readonly();
export const SurfaceDriftDetectedEventSchema =
  eventObjects[RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED].readonly();
export const SurfaceDriftLeaseAcquiredEventSchema =
  eventObjects[RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED].readonly();
export const SurfaceDriftLeaseReleasedEventSchema =
  eventObjects[RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED].readonly();
export const SurfaceDriftLeaseReleaseFailedEventSchema =
  eventObjects[RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED].readonly();
export const SurfaceDriftAlertEventSchema =
  eventObjects[RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT].readonly();
export const PathGraphSnapshotCreatedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED].readonly();
export const PathConsolidationCompletedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED].readonly();
export const PathConsolidationFusedEventSchema =
  eventObjects[RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED].readonly();
export const OutputShapingAppliedEventSchema =
  eventObjects[RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED].readonly();
export const OutputCommandCompressedEventSchema =
  eventObjects[RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED].readonly();
export const ManifestationBudgetEvaluatedEventSchema =
  eventObjects[RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED].readonly();
export const ManifestationEscalationDecidedEventSchema =
  eventObjects[RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED].readonly();
export const SecurityPassthroughStatusChangedEventSchema =
  eventObjects[RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED].readonly();
export const SecurityPassthroughInitializationFailedEventSchema =
  eventObjects[RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED].readonly();
export const ExtensionDescriptorRegisteredEventSchema =
  eventObjects[RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED].readonly();
export const ExtensionDescriptorRegistrationRevertedEventSchema =
  eventObjects[RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED].readonly();
export const ExtensionDescriptorRegistrationCompensationFailedEventSchema =
  eventObjects[RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED].readonly();
export const ExtensionToolDiscoveredEventSchema =
  eventObjects[RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED].readonly();
export const ExtensionGovernanceCheckedEventSchema =
  eventObjects[RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED].readonly();
export const RuntimeSideEffectFailedEventSchema =
  eventObjects[RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED].readonly();
export const ConstitutionalFragmentRegisteredEventSchema =
  eventObjects[RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED].readonly();

type EventObject = EventObjectSchemas[EventType];
const eventOptions = Object.values(eventObjects) as [EventObject, ...EventObject[]];

export const RuntimeGovernanceEventUnionSchema = z.discriminatedUnion("type", eventOptions).readonly();

export type RuntimeGovernanceEventPayloadMap = {
  [K in keyof PayloadSchemas]: z.infer<(PayloadSchemas)[K]>;
};

export function parseRuntimeGovernanceEventPayload<T extends keyof PayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): RuntimeGovernanceEventPayloadMap[T] {
  const schema = runtimeGovernancePayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown runtime-governance event type: ${String(type)}`);
  }

  return schema.parse(payload) as RuntimeGovernanceEventPayloadMap[T];
}

export type RuntimeGovernanceEventTypeValue = z.infer<typeof Payloads.RuntimeGovernanceEventTypeSchema>;
export type CanonicalizationAppliedPayload = z.infer<typeof Payloads.CanonicalizationAppliedPayloadSchema>;
export type CanonicalizationAliasResolvedPayload = z.infer<
  typeof Payloads.CanonicalizationAliasResolvedPayloadSchema
>;
export type StancePolicyEvaluatedPayload = z.infer<typeof Payloads.StancePolicyEvaluatedPayloadSchema>;
export type StanceResolutionChangedPayload = z.infer<typeof Payloads.StanceResolutionChangedPayloadSchema>;
export type ComputeProviderRoutedPayload = z.infer<typeof Payloads.ComputeProviderRoutedPayloadSchema>;
export type BootstrappingPathsPlantedPayload = z.infer<
  typeof Payloads.BootstrappingPathsPlantedPayloadSchema
>;
export type PathRelationCreatedPayload = z.infer<typeof Payloads.PathRelationCreatedPayloadSchema>;
export type PathRelationRejectedPayload = z.infer<typeof Payloads.PathRelationRejectedPayloadSchema>;
export type PathRelationLegitimacyUpdatedPayload = z.infer<
  typeof Payloads.PathRelationLegitimacyUpdatedPayloadSchema
>;
export type PathRelationReinforcedPayload = z.infer<typeof Payloads.PathRelationReinforcedPayloadSchema>;
export type PathRelationWeakenedPayload = z.infer<typeof Payloads.PathRelationWeakenedPayloadSchema>;
export type PathRelationRedirectedPayload = z.infer<typeof Payloads.PathRelationRedirectedPayloadSchema>;
export type PathRelationRetiredPayload = z.infer<typeof Payloads.PathRelationRetiredPayloadSchema>;
export type PathRelationDormantPayload = z.infer<typeof Payloads.PathRelationDormantPayloadSchema>;
export type PathRelationRevivedPayload = z.infer<typeof Payloads.PathRelationRevivedPayloadSchema>;
export type MergedLoserRecallBiasSign = z.infer<typeof Payloads.MergedLoserRecallBiasSignSchema>;
export type PathRelationMergedLoser = z.infer<typeof Payloads.PathRelationMergedLoserSchema>;
export type PathRelationMergedPayload = z.infer<typeof Payloads.PathRelationMergedPayloadSchema>;
export type SurfaceDriftDetectedPayload = z.infer<typeof Payloads.SurfaceDriftDetectedPayloadSchema>;
export type SurfaceDriftLeaseAcquiredPayload = z.infer<typeof Payloads.SurfaceDriftLeaseAcquiredPayloadSchema>;
export type SurfaceDriftLeaseReleasedPayload = z.infer<typeof Payloads.SurfaceDriftLeaseReleasedPayloadSchema>;
export type SurfaceDriftLeaseReleaseFailedPayload = z.infer<
  typeof Payloads.SurfaceDriftLeaseReleaseFailedPayloadSchema
>;
export type SurfaceDriftAlertPayload = z.infer<typeof Payloads.SurfaceDriftAlertPayloadSchema>;
export type PathGraphSnapshotCreatedPayload = z.infer<typeof Payloads.PathGraphSnapshotCreatedPayloadSchema>;
export type PathConsolidationCompletedPayload = z.infer<typeof Payloads.PathConsolidationCompletedPayloadSchema>;
export type PathConsolidationFusedPayload = z.infer<typeof Payloads.PathConsolidationFusedPayloadSchema>;
export type OutputShapingAppliedPayload = z.infer<typeof Payloads.OutputShapingAppliedPayloadSchema>;
export type OutputCommandCompressedPayload = z.infer<typeof Payloads.OutputCommandCompressedPayloadSchema>;
export type ManifestationBudgetEvaluatedPayload = z.infer<
  typeof Payloads.ManifestationBudgetEvaluatedPayloadSchema
>;
export type ManifestationEscalationDecidedPayload = z.infer<
  typeof Payloads.ManifestationEscalationDecidedPayloadSchema
>;
export type SecurityPassthroughStatusChangedPayload = z.infer<
  typeof Payloads.SecurityPassthroughStatusChangedPayloadSchema
>;
export type SecurityPassthroughInitializationFailedPayload = z.infer<
  typeof Payloads.SecurityPassthroughInitializationFailedPayloadSchema
>;
export type ExtensionDescriptorRegisteredPayload = z.infer<
  typeof Payloads.ExtensionDescriptorRegisteredPayloadSchema
>;
export type ExtensionDescriptorRegistrationRevertedPayload = z.infer<
  typeof Payloads.ExtensionDescriptorRegistrationRevertedPayloadSchema
>;
export type ExtensionDescriptorRegistrationCompensationFailedPayload = z.infer<
  typeof Payloads.ExtensionDescriptorRegistrationCompensationFailedPayloadSchema
>;
export type ExtensionToolDiscoveredPayload = z.infer<
  typeof Payloads.ExtensionToolDiscoveredPayloadSchema
>;
export type ExtensionGovernanceCheckedPayload = z.infer<
  typeof Payloads.ExtensionGovernanceCheckedPayloadSchema
>;
export type RuntimeSideEffectFailedPayload = z.infer<
  typeof Payloads.RuntimeSideEffectFailedPayloadSchema
>;
export type ConstitutionalFragmentRegisteredPayload = z.infer<
  typeof Payloads.ConstitutionalFragmentRegisteredPayloadSchema
>;
export type RuntimeGovernanceEvent = z.infer<typeof RuntimeGovernanceEventUnionSchema>;
