import { z } from "zod";
import * as Payloads from "./payloads.js";

function createRuntimeGovernanceEventObjectSchema<T extends keyof typeof Payloads.runtimeGovernancePayloadSchemas>(
  type: T,
  payloadSchema: (typeof Payloads.runtimeGovernancePayloadSchemas)[T]
) {
  return z.object({
    type: z.literal(type),
    payload: payloadSchema
  });
}

const CanonicalizationAppliedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.CANONICALIZATION_APPLIED,
  Payloads.CanonicalizationAppliedPayloadSchema
);
const CanonicalizationAliasResolvedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.CANONICALIZATION_ALIAS_RESOLVED,
  Payloads.CanonicalizationAliasResolvedPayloadSchema
);
const StancePolicyEvaluatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED,
  Payloads.StancePolicyEvaluatedPayloadSchema
);
const StanceResolutionChangedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED,
  Payloads.StanceResolutionChangedPayloadSchema
);
const ComputeProviderRoutedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED,
  Payloads.ComputeProviderRoutedPayloadSchema
);
const BootstrappingPathsPlantedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED,
  Payloads.BootstrappingPathsPlantedPayloadSchema
);
const PathRelationCreatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_CREATED,
  Payloads.PathRelationCreatedPayloadSchema
);
const PathRelationRejectedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_REJECTED,
  Payloads.PathRelationRejectedPayloadSchema
);
const PathRelationLegitimacyUpdatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
  Payloads.PathRelationLegitimacyUpdatedPayloadSchema
);
const PathRelationReinforcedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_REINFORCED,
  Payloads.PathRelationReinforcedPayloadSchema
);
const PathRelationWeakenedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_WEAKENED,
  Payloads.PathRelationWeakenedPayloadSchema
);
const PathRelationRedirectedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED,
  Payloads.PathRelationRedirectedPayloadSchema
);
const PathRelationRetiredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
  Payloads.PathRelationRetiredPayloadSchema
);
const PathRelationDormantEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_DORMANT,
  Payloads.PathRelationDormantPayloadSchema
);
const PathRelationRevivedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_REVIVED,
  Payloads.PathRelationRevivedPayloadSchema
);
const PathRelationMergedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_RELATION_MERGED,
  Payloads.PathRelationMergedPayloadSchema
);
const SurfaceDriftDetectedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED,
  Payloads.SurfaceDriftDetectedPayloadSchema
);
const SurfaceDriftLeaseAcquiredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
  Payloads.SurfaceDriftLeaseAcquiredPayloadSchema
);
const SurfaceDriftLeaseReleasedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED,
  Payloads.SurfaceDriftLeaseReleasedPayloadSchema
);
const SurfaceDriftLeaseReleaseFailedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED,
  Payloads.SurfaceDriftLeaseReleaseFailedPayloadSchema
);
const SurfaceDriftAlertEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT,
  Payloads.SurfaceDriftAlertPayloadSchema
);
const PathGraphSnapshotCreatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED,
  Payloads.PathGraphSnapshotCreatedPayloadSchema
);
const PathConsolidationCompletedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED,
  Payloads.PathConsolidationCompletedPayloadSchema
);
const PathConsolidationFusedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED,
  Payloads.PathConsolidationFusedPayloadSchema
);
const OutputShapingAppliedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED,
  Payloads.OutputShapingAppliedPayloadSchema
);
const OutputCommandCompressedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED,
  Payloads.OutputCommandCompressedPayloadSchema
);
const ManifestationBudgetEvaluatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED,
  Payloads.ManifestationBudgetEvaluatedPayloadSchema
);
const ManifestationEscalationDecidedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED,
  Payloads.ManifestationEscalationDecidedPayloadSchema
);
const SecurityPassthroughStatusChangedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
  Payloads.SecurityPassthroughStatusChangedPayloadSchema
);
const SecurityPassthroughInitializationFailedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
  Payloads.SecurityPassthroughInitializationFailedPayloadSchema
);
const ExtensionDescriptorRegisteredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED,
  Payloads.ExtensionDescriptorRegisteredPayloadSchema
);
const ExtensionDescriptorRegistrationRevertedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED,
  Payloads.ExtensionDescriptorRegistrationRevertedPayloadSchema
);
const ExtensionDescriptorRegistrationCompensationFailedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED,
  Payloads.ExtensionDescriptorRegistrationCompensationFailedPayloadSchema
);
const ExtensionToolDiscoveredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED,
  Payloads.ExtensionToolDiscoveredPayloadSchema
);
const ExtensionGovernanceCheckedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED,
  Payloads.ExtensionGovernanceCheckedPayloadSchema
);
const RuntimeSideEffectFailedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
  Payloads.RuntimeSideEffectFailedPayloadSchema
);
const ConstitutionalFragmentRegisteredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  Payloads.RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
  Payloads.ConstitutionalFragmentRegisteredPayloadSchema
);

export const CanonicalizationAppliedEventSchema = CanonicalizationAppliedEventObjectSchema.readonly();
export const CanonicalizationAliasResolvedEventSchema =
  CanonicalizationAliasResolvedEventObjectSchema.readonly();
export const StancePolicyEvaluatedEventSchema = StancePolicyEvaluatedEventObjectSchema.readonly();
export const StanceResolutionChangedEventSchema = StanceResolutionChangedEventObjectSchema.readonly();
export const ComputeProviderRoutedEventSchema = ComputeProviderRoutedEventObjectSchema.readonly();
export const BootstrappingPathsPlantedEventSchema =
  BootstrappingPathsPlantedEventObjectSchema.readonly();
export const PathRelationCreatedEventSchema = PathRelationCreatedEventObjectSchema.readonly();
export const PathRelationRejectedEventSchema = PathRelationRejectedEventObjectSchema.readonly();
export const PathRelationLegitimacyUpdatedEventSchema =
  PathRelationLegitimacyUpdatedEventObjectSchema.readonly();
export const PathRelationReinforcedEventSchema = PathRelationReinforcedEventObjectSchema.readonly();
export const PathRelationWeakenedEventSchema = PathRelationWeakenedEventObjectSchema.readonly();
export const PathRelationRedirectedEventSchema = PathRelationRedirectedEventObjectSchema.readonly();
export const PathRelationRetiredEventSchema = PathRelationRetiredEventObjectSchema.readonly();
export const PathRelationDormantEventSchema = PathRelationDormantEventObjectSchema.readonly();
export const PathRelationRevivedEventSchema = PathRelationRevivedEventObjectSchema.readonly();
export const PathRelationMergedEventSchema = PathRelationMergedEventObjectSchema.readonly();
export const SurfaceDriftDetectedEventSchema = SurfaceDriftDetectedEventObjectSchema.readonly();
export const SurfaceDriftLeaseAcquiredEventSchema =
  SurfaceDriftLeaseAcquiredEventObjectSchema.readonly();
export const SurfaceDriftLeaseReleasedEventSchema =
  SurfaceDriftLeaseReleasedEventObjectSchema.readonly();
export const SurfaceDriftLeaseReleaseFailedEventSchema =
  SurfaceDriftLeaseReleaseFailedEventObjectSchema.readonly();
export const SurfaceDriftAlertEventSchema = SurfaceDriftAlertEventObjectSchema.readonly();
export const PathGraphSnapshotCreatedEventSchema = PathGraphSnapshotCreatedEventObjectSchema.readonly();
export const PathConsolidationCompletedEventSchema =
  PathConsolidationCompletedEventObjectSchema.readonly();
export const PathConsolidationFusedEventSchema = PathConsolidationFusedEventObjectSchema.readonly();
export const OutputShapingAppliedEventSchema = OutputShapingAppliedEventObjectSchema.readonly();
export const OutputCommandCompressedEventSchema = OutputCommandCompressedEventObjectSchema.readonly();
export const ManifestationBudgetEvaluatedEventSchema =
  ManifestationBudgetEvaluatedEventObjectSchema.readonly();
export const ManifestationEscalationDecidedEventSchema =
  ManifestationEscalationDecidedEventObjectSchema.readonly();
export const SecurityPassthroughStatusChangedEventSchema =
  SecurityPassthroughStatusChangedEventObjectSchema.readonly();
export const SecurityPassthroughInitializationFailedEventSchema =
  SecurityPassthroughInitializationFailedEventObjectSchema.readonly();
export const ExtensionDescriptorRegisteredEventSchema =
  ExtensionDescriptorRegisteredEventObjectSchema.readonly();
export const ExtensionDescriptorRegistrationRevertedEventSchema =
  ExtensionDescriptorRegistrationRevertedEventObjectSchema.readonly();
export const ExtensionDescriptorRegistrationCompensationFailedEventSchema =
  ExtensionDescriptorRegistrationCompensationFailedEventObjectSchema.readonly();
export const ExtensionToolDiscoveredEventSchema =
  ExtensionToolDiscoveredEventObjectSchema.readonly();
export const ExtensionGovernanceCheckedEventSchema =
  ExtensionGovernanceCheckedEventObjectSchema.readonly();
export const RuntimeSideEffectFailedEventSchema =
  RuntimeSideEffectFailedEventObjectSchema.readonly();
export const ConstitutionalFragmentRegisteredEventSchema =
  ConstitutionalFragmentRegisteredEventObjectSchema.readonly();

export const RuntimeGovernanceEventUnionSchema = z
  .discriminatedUnion("type", [
    CanonicalizationAppliedEventObjectSchema,
    CanonicalizationAliasResolvedEventObjectSchema,
    StancePolicyEvaluatedEventObjectSchema,
    StanceResolutionChangedEventObjectSchema,
    ComputeProviderRoutedEventObjectSchema,
    BootstrappingPathsPlantedEventObjectSchema,
    PathRelationCreatedEventObjectSchema,
    PathRelationRejectedEventObjectSchema,
    PathRelationLegitimacyUpdatedEventObjectSchema,
    PathRelationReinforcedEventObjectSchema,
    PathRelationWeakenedEventObjectSchema,
    PathRelationRedirectedEventObjectSchema,
    PathRelationRetiredEventObjectSchema,
    PathRelationDormantEventObjectSchema,
    PathRelationRevivedEventObjectSchema,
    PathRelationMergedEventObjectSchema,
    SurfaceDriftDetectedEventObjectSchema,
    SurfaceDriftLeaseAcquiredEventObjectSchema,
    SurfaceDriftLeaseReleasedEventObjectSchema,
    SurfaceDriftLeaseReleaseFailedEventObjectSchema,
    SurfaceDriftAlertEventObjectSchema,
    PathGraphSnapshotCreatedEventObjectSchema,
    PathConsolidationCompletedEventObjectSchema,
    PathConsolidationFusedEventObjectSchema,
    OutputShapingAppliedEventObjectSchema,
    OutputCommandCompressedEventObjectSchema,
    ManifestationBudgetEvaluatedEventObjectSchema,
    ManifestationEscalationDecidedEventObjectSchema,
    SecurityPassthroughStatusChangedEventObjectSchema,
    SecurityPassthroughInitializationFailedEventObjectSchema,
    ExtensionDescriptorRegisteredEventObjectSchema,
    ExtensionDescriptorRegistrationRevertedEventObjectSchema,
    ExtensionDescriptorRegistrationCompensationFailedEventObjectSchema,
    ExtensionToolDiscoveredEventObjectSchema,
    ExtensionGovernanceCheckedEventObjectSchema,
    RuntimeSideEffectFailedEventObjectSchema,
    ConstitutionalFragmentRegisteredEventObjectSchema
  ])
  .readonly();

export type RuntimeGovernanceEventPayloadMap = {
  [K in keyof typeof Payloads.runtimeGovernancePayloadSchemas]: z.infer<(typeof Payloads.runtimeGovernancePayloadSchemas)[K]>;
};

export function parseRuntimeGovernanceEventPayload<T extends keyof typeof Payloads.runtimeGovernancePayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): RuntimeGovernanceEventPayloadMap[T] {
  const schema = Payloads.runtimeGovernancePayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase C event type: ${String(type)}`);
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
