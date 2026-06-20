import { describe, expect, it } from "vitest";
import { EventLogEntrySchema, EventTypeSchema } from "../../events/event-log.js";
import {
  ConstitutionalFragmentRegisteredEventSchema,
  RuntimeGovernanceEventType,
  RuntimeGovernanceEventUnionSchema} from "../../events/runtime-governance.js";

import {
  validTimestamp,
  workerDispatchFragmentId,
  expectedEventTypes,
  canonicalizationAppliedPayload,
  stancePolicyPayload,
  stanceResolutionPayload,
  pathCreatedPayload,
  legitimacyUpdatedPayload,
  redirectedPayload,
  driftDetectedPayload,
  driftLeaseAcquiredPayload,
  driftLeaseReleasedPayload,
  driftLeaseReleaseFailedPayload,
  driftAlertPayload,
  snapshotCreatedPayload,
  outputShapingPayload,
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
  it("validates event unions and EventLog compatibility", () => {
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.CANONICALIZATION_APPLIED,
        payload: canonicalizationAppliedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.CANONICALIZATION_APPLIED,
      payload: canonicalizationAppliedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED,
        payload: stancePolicyPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED,
      payload: stancePolicyPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED,
        payload: stanceResolutionPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED,
      payload: stanceResolutionPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED,
        payload: computeProviderRoutedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED,
      payload: computeProviderRoutedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED,
        payload: bootstrappingPathsPlantedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED,
      payload: bootstrappingPathsPlantedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.PATH_RELATION_CREATED,
        payload: pathCreatedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      payload: pathCreatedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
        payload: legitimacyUpdatedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
      payload: legitimacyUpdatedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED,
        payload: redirectedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED,
      payload: redirectedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED,
        payload: driftLeaseReleasedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED,
      payload: driftLeaseReleasedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED,
        payload: driftLeaseReleaseFailedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED,
      payload: driftLeaseReleaseFailedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED,
        payload: outputShapingPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED,
      payload: outputShapingPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
        payload: securityStatusChangedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
      payload: securityStatusChangedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
        payload: securityInitializationFailedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
      payload: securityInitializationFailedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED,
        payload: extensionDescriptorRegisteredPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED,
      payload: extensionDescriptorRegisteredPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED,
        payload: extensionDescriptorRegistrationRevertedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED,
      payload: extensionDescriptorRegistrationRevertedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED,
        payload: extensionDescriptorRegistrationCompensationFailedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED,
      payload: extensionDescriptorRegistrationCompensationFailedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED,
        payload: extensionToolDiscoveredPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED,
      payload: extensionToolDiscoveredPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED,
        payload: extensionGovernanceCheckedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED,
      payload: extensionGovernanceCheckedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
        payload: runtimeSideEffectFailedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
      payload: runtimeSideEffectFailedPayload
    });
    expect(
      ConstitutionalFragmentRegisteredEventSchema.parse({
        type: RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
        payload: constitutionalFragmentPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
      payload: constitutionalFragmentPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
        payload: constitutionalFragmentPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
      payload: constitutionalFragmentPayload
    });

    expect(EventTypeSchema.parse(RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED)).toBe(
      RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED
    );
    expect(EventTypeSchema.parse(RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED)).toBe(
      RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED
    );
    expect(EventTypeSchema.parse(RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED)).toBe(
      RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED
    );
    expect(EventTypeSchema.parse(RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED)).toBe(
      RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED
    );
    expect(EventTypeSchema.parse(RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED)).toBe(
      RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED
    );
    expect(EventTypeSchema.parse(RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED)).toBe(
      RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED
    );
    expect(EventTypeSchema.parse(RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED)).toBe(
      RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED
    );
    expect(EventTypeSchema.parse(RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED)).toBe(
      RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED
    );
    expect(
      EventLogEntrySchema.parse({
        event_id: "event-shape-1",
        event_type: RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED,
        entity_type: "output_shaping",
        entity_id: "shape-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        caused_by: "engine",
        revision: 0,
        payload_json: outputShapingPayload,
        created_at: validTimestamp
      })
    ).toMatchObject({
      event_type: RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED,
      payload_json: outputShapingPayload
    });
    expect(
      EventLogEntrySchema.parse({
        event_id: "event-constitutional-1",
        event_type: RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
        entity_type: "constitutional_fragment",
        entity_id: workerDispatchFragmentId,
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "system",
        revision: 0,
        payload_json: constitutionalFragmentPayload,
        created_at: validTimestamp
      })
    ).toMatchObject({
      event_type: RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
      payload_json: constitutionalFragmentPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED,
        payload: driftDetectedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED,
      payload: driftDetectedPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
        payload: driftLeaseAcquiredPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
      payload: driftLeaseAcquiredPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT,
        payload: driftAlertPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT,
      payload: driftAlertPayload
    });
    expect(
      RuntimeGovernanceEventUnionSchema.parse({
        type: RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED,
        payload: snapshotCreatedPayload
      })
    ).toEqual({
      type: RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED,
      payload: snapshotCreatedPayload
    });

    for (const eventType of expectedEventTypes) {
      expect(EventTypeSchema.parse(eventType)).toBe(eventType);
    }
  });
});
