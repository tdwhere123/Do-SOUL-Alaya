import { describe, expect, it } from "vitest";
import { EventLogEntrySchema, EventTypeSchema } from "../../events/event-log.js";
import {
  BootstrappingPathsPlantedPayloadSchema,
  CanonicalizationAliasResolvedPayloadSchema,
  CanonicalizationAppliedPayloadSchema,
  ComputeProviderRoutedPayloadSchema,
  ConstitutionalFragmentRegisteredEventSchema,
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
  RuntimeGovernanceEventType,
  RuntimeGovernanceEventTypeSchema,
  RuntimeGovernanceEventUnionSchema,
  RuntimeSideEffectFailedPayloadSchema,
  SecurityPassthroughInitializationFailedPayloadSchema,
  SecurityPassthroughStatusChangedPayloadSchema,
  SurfaceDriftAlertPayloadSchema,
  SurfaceDriftDetectedPayloadSchema,
  SurfaceDriftLeaseAcquiredPayloadSchema,
  SurfaceDriftLeaseReleaseFailedPayloadSchema,
  SurfaceDriftLeaseReleasedPayloadSchema,
  StancePolicyEvaluatedPayloadSchema,
  StanceResolutionChangedPayloadSchema,
  parseRuntimeGovernanceEventPayload
} from "../../events/runtime-governance.js";
import {
  OutputShapingResultSchema,
  OutputShapingRuleSchema
} from "../../soul/output-shaping.js";

import {
  validTimestamp,
  workerDispatchFragmentId,
  expectedEventTypes,
  canonicalizationAppliedPayload,
  canonicalizationAliasResolvedPayload,
  stancePolicyPayload,
  stanceResolutionPayload,
  pathCreatedPayload,
  pathRejectedPayload,
  reinforcedPayload,
  legitimacyUpdatedPayload,
  weakenedPayload,
  retiredPayload,
  mergedPayload,
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
  it("validates parseRuntimeGovernanceEventPayload coverage", () => {
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.CANONICALIZATION_APPLIED, canonicalizationAppliedPayload)
    ).toEqual(canonicalizationAppliedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.CANONICALIZATION_ALIAS_RESOLVED,
        canonicalizationAliasResolvedPayload
      )
    ).toEqual(canonicalizationAliasResolvedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED, stancePolicyPayload)
    ).toEqual(stancePolicyPayload);
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED, stanceResolutionPayload)
    ).toEqual(stanceResolutionPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED,
        computeProviderRoutedPayload
      )
    ).toEqual(computeProviderRoutedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED,
        bootstrappingPathsPlantedPayload
      )
    ).toEqual(bootstrappingPathsPlantedPayload);
    expect(parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_CREATED, pathCreatedPayload)).toEqual(
      pathCreatedPayload
    );
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_REJECTED, pathRejectedPayload)
    ).toEqual(pathRejectedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
        legitimacyUpdatedPayload
      )
    ).toEqual(legitimacyUpdatedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_REINFORCED, reinforcedPayload)
    ).toEqual(reinforcedPayload);
    expect(parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_WEAKENED, weakenedPayload)).toEqual(
      weakenedPayload
    );
    expect(parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED, redirectedPayload)).toEqual(
      redirectedPayload
    );
    expect(parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_RETIRED, retiredPayload)).toEqual(
      retiredPayload
    );
    expect(parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_MERGED, mergedPayload)).toEqual(
      mergedPayload
    );
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED, driftDetectedPayload)
    ).toEqual(driftDetectedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
        driftLeaseAcquiredPayload
      )
    ).toEqual(driftLeaseAcquiredPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED,
        driftLeaseReleasedPayload
      )
    ).toEqual(driftLeaseReleasedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED,
        driftLeaseReleaseFailedPayload
      )
    ).toEqual(driftLeaseReleaseFailedPayload);
    expect(parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT, driftAlertPayload)).toEqual(
      driftAlertPayload
    );
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED,
        snapshotCreatedPayload
      )
    ).toEqual(snapshotCreatedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED, completedPayload)
    ).toEqual(completedPayload);
    expect(parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED, fusedPayload)).toEqual(
      fusedPayload
    );
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED, outputShapingPayload)
    ).toEqual(outputShapingPayload);
    expect(
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED, commandCompressedPayload)
    ).toEqual(commandCompressedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
        securityStatusChangedPayload
      )
    ).toEqual(securityStatusChangedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
        securityInitializationFailedPayload
      )
    ).toEqual(securityInitializationFailedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED,
        extensionDescriptorRegisteredPayload
      )
    ).toEqual(extensionDescriptorRegisteredPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED,
        extensionDescriptorRegistrationRevertedPayload
      )
    ).toEqual(extensionDescriptorRegistrationRevertedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED,
        extensionDescriptorRegistrationCompensationFailedPayload
      )
    ).toEqual(extensionDescriptorRegistrationCompensationFailedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED,
        extensionToolDiscoveredPayload
      )
    ).toEqual(extensionToolDiscoveredPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED,
        extensionGovernanceCheckedPayload
      )
    ).toEqual(extensionGovernanceCheckedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
        constitutionalFragmentPayload
      )
    ).toEqual(constitutionalFragmentPayload);
  });
});
