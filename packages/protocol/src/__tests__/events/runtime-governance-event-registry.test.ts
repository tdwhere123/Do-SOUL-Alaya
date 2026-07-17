import { describe, expect, it } from "vitest";
import {
  BootstrappingPathsPlantedPayloadSchema,
  CanonicalizationAliasResolvedPayloadSchema,
  CanonicalizationAppliedPayloadSchema,
  ComputeProviderRoutedPayloadSchema,
  ConstitutionalFragmentRegisteredPayloadSchema,
  ExtensionDescriptorRegisteredPayloadSchema,
  ExtensionDescriptorRegistrationCompensationFailedPayloadSchema,
  ExtensionDescriptorRegistrationRevertedPayloadSchema,
  ExtensionGovernanceCheckedPayloadSchema,
  ExtensionToolDiscoveredPayloadSchema,
  OutputCommandCompressedPayloadSchema,
  OutputShapingAppliedPayloadSchema,
  PathConsolidationCompletedPayloadSchema,
  PathConsolidationFusedPayloadSchema,
  PathGraphSnapshotCreatedPayloadSchema,
  PathRelationCreatedPayloadSchema,
  PathRelationLegitimacyUpdatedPayloadSchema,
  PathRelationRedirectedPayloadSchema,
  PathRelationReinforcedPayloadSchema,
  PathRelationRetiredPayloadSchema,
  PathRelationWeakenedPayloadSchema,
  RelationAssertionAdmittedPayloadSchema,
  RelationAssertionResolvedPayloadSchema,
  RuntimeGovernanceEventType,
  RuntimeGovernanceEventTypeSchema,
  RuntimeSideEffectFailedPayloadSchema,
  SecurityPassthroughInitializationFailedPayloadSchema,
  SecurityPassthroughStatusChangedPayloadSchema,
  SurfaceDriftAlertPayloadSchema,
  SurfaceDriftDetectedPayloadSchema,
  SurfaceDriftLeaseAcquiredPayloadSchema,
  SurfaceDriftLeaseReleaseFailedPayloadSchema,
  SurfaceDriftLeaseReleasedPayloadSchema,
  StancePolicyEvaluatedPayloadSchema,
  StanceResolutionChangedPayloadSchema} from "../../events/runtime-governance.js";
import {
  OutputShapingResultSchema,
  OutputShapingRuleSchema
} from "../../soul/output-shaping.js";

import {
  expectedEventTypes,
  canonicalizationAppliedPayload,
  canonicalizationAliasResolvedPayload,
  stancePolicyPayload,
  stanceResolutionPayload,
  relationAssertionAdmittedPayload,
  relationAssertionResolvedPayload,
  pathCreatedPayload,
  reinforcedPayload,
  legitimacyUpdatedPayload,
  weakenedPayload,
  retiredPayload,
  redirectedPayload,
  driftDetectedPayload,
  driftLeaseAcquiredPayload,
  driftLeaseReleasedPayload,
  driftLeaseReleaseFailedPayload,
  driftAlertPayload,
  snapshotCreatedPayload,
  completedPayload,
  fusedPayload,
  outputShapingPayload,
  commandCompressedPayload,
  securityStatusChangedPayload,
  securityInitializationFailedPayload,
  extensionDescriptorRegisteredPayload,
  extensionDescriptorRegistrationRevertedPayload,
  extensionDescriptorRegistrationCompensationFailedPayload,
  extensionToolDiscoveredPayload,
  extensionGovernanceCheckedPayload,
  constitutionalFragmentPayload,
  computeProviderRoutedPayload,
  bootstrappingPathsPlantedPayload,
  runtimeSideEffectFailedPayload
} from "./runtime-governance-event-registry.fixtures.js";

describe("Phase C event registry", () => {
  it("validates registered payload schemas", () => {
    expect(Object.values(RuntimeGovernanceEventType)).toEqual(expectedEventTypes);
    expect(RuntimeGovernanceEventTypeSchema.options).toEqual(expectedEventTypes);
    expect(expectedEventTypes.every((eventType) => eventType.includes("."))).toBe(true);

    expect(CanonicalizationAppliedPayloadSchema.parse(canonicalizationAppliedPayload)).toEqual(
      canonicalizationAppliedPayload
    );
    expect(
      CanonicalizationAliasResolvedPayloadSchema.parse(canonicalizationAliasResolvedPayload)
    ).toEqual(canonicalizationAliasResolvedPayload);
    expect(StancePolicyEvaluatedPayloadSchema.parse(stancePolicyPayload)).toEqual(stancePolicyPayload);
    expect(StanceResolutionChangedPayloadSchema.parse(stanceResolutionPayload)).toEqual(
      stanceResolutionPayload
    );
    expect(
      RelationAssertionAdmittedPayloadSchema.parse(relationAssertionAdmittedPayload)
    ).toEqual(relationAssertionAdmittedPayload);
    expect(
      RelationAssertionResolvedPayloadSchema.parse(relationAssertionResolvedPayload)
    ).toEqual(relationAssertionResolvedPayload);
    expect(ComputeProviderRoutedPayloadSchema.parse(computeProviderRoutedPayload)).toEqual(
      computeProviderRoutedPayload
    );
    expect(BootstrappingPathsPlantedPayloadSchema.parse(bootstrappingPathsPlantedPayload)).toEqual(
      bootstrappingPathsPlantedPayload
    );
    expect(PathRelationCreatedPayloadSchema.parse(pathCreatedPayload)).toEqual(pathCreatedPayload);
    expect(PathRelationLegitimacyUpdatedPayloadSchema.parse(legitimacyUpdatedPayload)).toEqual(
      legitimacyUpdatedPayload
    );
    expect(PathRelationReinforcedPayloadSchema.parse(reinforcedPayload)).toEqual(reinforcedPayload);
    expect(PathRelationWeakenedPayloadSchema.parse(weakenedPayload)).toEqual(weakenedPayload);
    expect(PathRelationRedirectedPayloadSchema.parse(redirectedPayload)).toEqual(redirectedPayload);
    expect(PathRelationRetiredPayloadSchema.parse(retiredPayload)).toEqual(retiredPayload);
    expect(SurfaceDriftDetectedPayloadSchema.parse(driftDetectedPayload)).toEqual(driftDetectedPayload);
    expect(SurfaceDriftLeaseAcquiredPayloadSchema.parse(driftLeaseAcquiredPayload)).toEqual(
      driftLeaseAcquiredPayload
    );
    expect(SurfaceDriftLeaseReleasedPayloadSchema.parse(driftLeaseReleasedPayload)).toEqual(
      driftLeaseReleasedPayload
    );
    expect(
      SurfaceDriftLeaseReleaseFailedPayloadSchema.parse(driftLeaseReleaseFailedPayload)
    ).toEqual(driftLeaseReleaseFailedPayload);
    expect(SurfaceDriftAlertPayloadSchema.parse(driftAlertPayload)).toEqual(driftAlertPayload);
    expect(PathGraphSnapshotCreatedPayloadSchema.parse(snapshotCreatedPayload)).toEqual(
      snapshotCreatedPayload
    );
    expect(PathConsolidationCompletedPayloadSchema.parse(completedPayload)).toEqual(completedPayload);
    expect(PathConsolidationFusedPayloadSchema.parse(fusedPayload)).toEqual(fusedPayload);
    expect(
      OutputShapingRuleSchema.parse({
        command_class: "search",
        min_consecutive: 2,
        compression_mode: "last_only"
      })
    ).toEqual({
      command_class: "search",
      min_consecutive: 2,
      compression_mode: "last_only"
    });
    expect(OutputShapingResultSchema.parse(outputShapingPayload)).toEqual(outputShapingPayload);
    expect(OutputShapingAppliedPayloadSchema.parse(outputShapingPayload)).toEqual(outputShapingPayload);
    expect(OutputCommandCompressedPayloadSchema.parse(commandCompressedPayload)).toEqual(
      commandCompressedPayload
    );
    expect(
      SecurityPassthroughStatusChangedPayloadSchema.parse(securityStatusChangedPayload)
    ).toEqual(securityStatusChangedPayload);
    expect(
      SecurityPassthroughInitializationFailedPayloadSchema.parse(
        securityInitializationFailedPayload
      )
    ).toEqual(securityInitializationFailedPayload);
    expect(
      ExtensionDescriptorRegisteredPayloadSchema.parse(extensionDescriptorRegisteredPayload)
    ).toEqual(extensionDescriptorRegisteredPayload);
    expect(
      ExtensionDescriptorRegistrationRevertedPayloadSchema.parse(
        extensionDescriptorRegistrationRevertedPayload
      )
    ).toEqual(extensionDescriptorRegistrationRevertedPayload);
    expect(
      ExtensionDescriptorRegistrationCompensationFailedPayloadSchema.parse(
        extensionDescriptorRegistrationCompensationFailedPayload
      )
    ).toEqual(extensionDescriptorRegistrationCompensationFailedPayload);
    expect(ExtensionToolDiscoveredPayloadSchema.parse(extensionToolDiscoveredPayload)).toEqual(
      extensionToolDiscoveredPayload
    );
    expect(
      ExtensionGovernanceCheckedPayloadSchema.parse(extensionGovernanceCheckedPayload)
    ).toEqual(extensionGovernanceCheckedPayload);
    expect(RuntimeSideEffectFailedPayloadSchema.parse(runtimeSideEffectFailedPayload)).toEqual(
      runtimeSideEffectFailedPayload
    );
    expect(ConstitutionalFragmentRegisteredPayloadSchema.parse(constitutionalFragmentPayload)).toEqual(
      constitutionalFragmentPayload
    );
  });
});
