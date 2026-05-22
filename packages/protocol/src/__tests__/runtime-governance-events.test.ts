import { describe, expect, it } from "vitest";
import { EventLogEntrySchema, EventTypeSchema } from "../event-log.js";
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
} from "../events/runtime-governance.js";
import {
  OutputShapingResultSchema,
  OutputShapingRuleSchema
} from "../soul/output-shaping.js";

const validTimestamp = "2026-04-17T08:00:00.000Z";
const workerDispatchFragmentId =
  "constitutional://workspace-1/hard_constraint/system.worker_dispatch-9c5ea45891f0";

describe("Phase C event registry", () => {
  it("registers combined C-1/C-2/C-3/C-5/C-6/C-8/C-11/C-13 payload contracts", () => {
    const expectedEventTypes = [
      "canonicalization.applied",
      "canonicalization.alias_resolved",
      "stance.policy_evaluated",
      "stance.resolution_changed",
      "path.relation_created",
      "path.relation_legitimacy_updated",
      "path.relation_reinforced",
      "path.relation_weakened",
      "path.relation_redirected",
      "path.relation_retired",
      "path.consolidation_completed",
      "path.consolidation_fused",
      "surface.drift_detected",
      "surface.drift_lease_acquired",
      "surface.drift_lease_released",
      "surface.drift_lease_release_failed",
      "surface.drift_alert",
      "path.graph.snapshot_created",
      "output.shaping_applied",
      "output.command_compressed",
      "manifestation.budget_evaluated",
      "manifestation.escalation_decided",
      "security.passthrough_status_changed",
      "security.passthrough_initialization_failed",
      "extension.descriptor_registered",
      "extension.descriptor_registration_reverted",
      "extension.descriptor_registration_compensation_failed",
      "extension.tool_discovered",
      "extension.governance_checked",
      "compute.provider_routed",
      "bootstrapping.paths_planted",
      "constitutional.fragment_registered"
    ] as const;

    const canonicalizationAppliedPayload = {
      input: "用户偏好",
      canonical: "user_preference",
      domain: "governance_subject.domain",
      was_alias_resolved: true,
      applied_at: validTimestamp
    } as const;
    const canonicalizationAliasResolvedPayload = {
      alias: "用户偏好",
      canonical: "user_preference",
      domain: "governance_subject.domain",
      language: "zh",
      resolved_at: validTimestamp
    } as const;
    const stancePolicyPayload = {
      workspace_id: "workspace-1",
      policy_id: "policy-1",
      default_verification_attention: "standard",
      default_conservatism: "balanced",
      evaluated_at: validTimestamp
    } as const;
    const stanceResolutionPayload = {
      resolution_id: "resolution-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      verification_attention: "elevated",
      conservatism: "conservative",
      contributing_candidate_count: 2,
      has_model_ref: true,
      resolved_at: validTimestamp
    } as const;
    const pathCreatedPayload = {
      path_id: "path-1",
      workspace_id: "workspace-1",
      relation_kind: "supports",
      source_anchor_kind: "object",
      target_anchor_kind: "object_facet",
      initial_strength: 0.3,
      governance_class: "hint_only",
      created_at: validTimestamp
    } as const;
    const reinforcedPayload = {
      path_id: "path-1",
      previous_strength: 0.3,
      new_strength: 0.4,
      support_events_count: 4,
      reinforced_at: validTimestamp
    } as const;
    const legitimacyUpdatedPayload = {
      path_id: "path-1",
      workspace_id: "workspace-1",
      previous_governance_class: "hint_only",
      new_governance_class: "strictly_governed",
      previous_evidence_basis: ["proposal:old"],
      new_evidence_basis: ["proposal:new"],
      updated_at: validTimestamp
    } as const;
    const weakenedPayload = {
      path_id: "path-1",
      previous_strength: 0.4,
      new_strength: 0.35,
      reason: "contradiction_detected",
      weakened_at: validTimestamp
    } as const;
    const retiredPayload = {
      path_id: "path-1",
      retirement_reason: "cooldown_expired",
      final_strength: 0.05,
      retired_at: validTimestamp
    } as const;
    const redirectedPayload = {
      path_id: "path-1",
      previous_direction_bias: "target_to_source",
      new_direction_bias: "source_to_target",
      source_usage_count: 0,
      target_usage_count: 2,
      redirected_at: validTimestamp
    } as const;
    const driftDetectedPayload = {
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      drift_type: "scope_change",
      severity: "governance_critical",
      affected_subject: "surface_binding",
      detected_at: validTimestamp
    } as const;
    const driftLeaseAcquiredPayload = {
      lease_id: "lease-1",
      workspace_id: "workspace-1",
      operation_type: "surface.bind_object",
      granted_to: "user",
      expires_at: "2026-04-17T08:05:00.000Z",
      granted_at: validTimestamp
    } as const;
    const driftLeaseReleasedPayload = {
      lease_id: "lease-1",
      workspace_id: "workspace-1",
      operation_type: "surface.rename_object",
      granted_to: "user",
      released_by: "user",
      released_at: validTimestamp
    } as const;
    const driftLeaseReleaseFailedPayload = {
      lease_id: "lease-1",
      workspace_id: "workspace-1",
      operation_type: "surface.transition_binding_state",
      granted_to: "user",
      released_by: "user",
      failed_at: validTimestamp
    } as const;
    const driftAlertPayload = {
      alert_id: "alert-1",
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      severity: "governance_critical",
      message: "Surface governance-critical drift detected.",
      alerted_at: validTimestamp
    } as const;
    const snapshotCreatedPayload = {
      snapshot_id: "snapshot-1",
      workspace_id: "workspace-1",
      total_active_paths: 4,
      snapshot_at: validTimestamp
    } as const;
    const completedPayload = {
      workspace_id: "workspace-1",
      paths_reinforced: 2,
      paths_weakened: 1,
      paths_retired: 1,
      stability_promotions: 1,
      duration_ms: 42,
      completed_at: validTimestamp
    } as const;
    const fusedPayload = {
      workspace_id: "workspace-1",
      reason: "planner_failed",
      retry_count: 3,
      cooldown_until: "2026-04-17T08:01:00.000Z",
      fused_at: validTimestamp
    } as const;
    const outputShapingPayload = {
      shaping_id: "shape-1",
      command_class: "search",
      original_count: 3,
      compressed_to: 1,
      compression_mode: "last_only",
      original_event_ids: ["evt-1", "evt-2", "evt-3"],
      shaped_at: validTimestamp
    } as const;
    const commandCompressedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      total_original: 3,
      total_after_shaping: 1,
      compression_ratio: 1 / 3,
      compressed_at: validTimestamp
    } as const;
    const securityStatusChangedPayload = {
      workspace_id: "workspace-1",
      posture: "baseline",
      zero_day_active: true,
      active_security_locks: 0,
      reason: "workspace_initialized",
      changed_at: validTimestamp
    } as const;
    const securityInitializationFailedPayload = {
      workspace_id: "workspace-1",
      operation: "create",
      failed_at: validTimestamp
    } as const;
    const extensionDescriptorRegisteredPayload = {
      descriptor_type: "tool_provider",
      descriptor_id: "provider.mcp.filesystem",
      name: "Filesystem MCP Provider",
      source: "mcp_external",
      registered_at: validTimestamp
    } as const;
    const extensionDescriptorRegistrationRevertedPayload = {
      descriptor_type: "tool_provider",
      descriptor_id: "provider.mcp.filesystem",
      original_event_id: "event-1",
      reverted_at: validTimestamp
    } as const;
    const extensionDescriptorRegistrationCompensationFailedPayload = {
      descriptor_type: "tool_provider",
      descriptor_id: "provider.mcp.filesystem",
      original_event_id: "event-1",
      failed_at: validTimestamp
    } as const;
    const extensionToolDiscoveredPayload = {
      provider_id: "provider.mcp.filesystem",
      tool_id: "mcp__filesystem__read_file",
      tool_name: "filesystem.read_file",
      source: "mcp_external",
      discovered_at: validTimestamp
    } as const;
    const extensionGovernanceCheckedPayload = {
      tool_id: "mcp__filesystem__read_file",
      provider_id: "provider.mcp.filesystem",
      permission_checked: true,
      execution_recorded: true,
      checked_at: validTimestamp
    } as const;
    const constitutionalFragmentPayload = {
      fragment_id: workerDispatchFragmentId,
      workspace_id: "workspace-1",
      category: "hard_constraint",
      authority_source: "system.worker_dispatch",
      registered_at: validTimestamp,
      content_sha256: "9c5ea45891f09690b8d37bc9f1d21e1fd6d883198445846376e925f93edc4ae4"
    } as const;
    const computeProviderRoutedPayload = {
      decision_id: "decision-1",
      workspace_id: "workspace-1",
      selected_provider: "stub",
      model_id: "local-heuristics",
      selection_reason: "stub selected as configured fallback compute provider",
      decided_at: validTimestamp
    } as const;
    const bootstrappingPathsPlantedPayload = {
      record_id: "bootstrap-record-1",
      workspace_id: "workspace-1",
      paths_planted: 1,
      template_ids: ["workspace.bootstrap.explicit-test"],
      planted_at: validTimestamp
    } as const;

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
    expect(ConstitutionalFragmentRegisteredPayloadSchema.parse(constitutionalFragmentPayload)).toEqual(
      constitutionalFragmentPayload
    );

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

  it("parses security initialization failures with optional diagnostics while keeping strict keys", () => {
    const basePayload = {
      workspace_id: "workspace-1",
      operation: "create",
      failed_at: validTimestamp
    } as const;

    expect(SecurityPassthroughInitializationFailedPayloadSchema.parse(basePayload)).toEqual(
      basePayload
    );
    expect(
      SecurityPassthroughInitializationFailedPayloadSchema.parse({
        ...basePayload,
        reason: null,
        error_code: null
      })
    ).toEqual({
      ...basePayload,
      reason: null,
      error_code: null
    });

    const populatedPayload = {
      ...basePayload,
      reason: "Zero-day policy store is offline",
      error_code: "SyntaxError"
    } as const;

    expect(
      SecurityPassthroughInitializationFailedPayloadSchema.parse(populatedPayload)
    ).toEqual(populatedPayload);
    expect(
      parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
        populatedPayload
      )
    ).toEqual(populatedPayload);
    expect(() =>
      SecurityPassthroughInitializationFailedPayloadSchema.parse({
        ...populatedPayload,
        detail: "extra"
      })
    ).toThrow();
  });

  it("rejects unknown names and malformed combined payloads", () => {
    expect(() => RuntimeGovernanceEventTypeSchema.parse("path.relation_mutated")).toThrow();
    expect(() => RuntimeGovernanceEventTypeSchema.parse("constitutional.fragment.mutated")).toThrow();
    expect(() => EventTypeSchema.parse("output.shaping")).toThrow();
    expect(() => EventTypeSchema.parse("constitutional_fragment_registered")).toThrow();

    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.CANONICALIZATION_APPLIED, {
        input: "用户偏好",
        canonical: "",
        domain: "governance_subject.domain",
        was_alias_resolved: true,
        applied_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED, {
        workspace_id: "workspace-1",
        policy_id: "policy-1",
        default_verification_attention: "medium",
        default_conservatism: "balanced",
        evaluated_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED, {
        resolution_id: "resolution-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        verification_attention: "elevated",
        conservatism: "conservative",
        contributing_candidate_count: -1,
        has_model_ref: true,
        resolved_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED, {
        decision_id: "decision-1",
        workspace_id: "workspace-1",
        selected_provider: "experimental_api",
        model_id: "model-1",
        selection_reason: "bad provider",
        decided_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_CREATED, {
        path_id: "path-1",
        workspace_id: "workspace-1",
        relation_kind: "",
        source_anchor_kind: "object",
        target_anchor_kind: "object_facet",
        initial_strength: 0.3,
        governance_class: "hint_only",
        created_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_RELATION_REINFORCED, {
        path_id: "path-1",
        previous_strength: 0.3,
        new_strength: 0.4,
        support_events_count: -1,
        reinforced_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED, {
        snapshot_id: "snapshot-1",
        workspace_id: "workspace-1",
        total_active_paths: -1,
        snapshot_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED, {
        drift_id: "drift-1",
        workspace_id: "workspace-1",
        drift_type: "scope_change",
        severity: "critical",
        affected_subject: "surface_binding",
        detected_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED, {
        lease_id: "lease-1",
        workspace_id: "workspace-1",
        operation_type: "surface.delete_object",
        granted_to: "user",
        expires_at: "2026-04-17T08:05:00.000Z",
        granted_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT, {
        alert_id: "alert-1",
        drift_id: "drift-1",
        workspace_id: "workspace-1",
        severity: "ordinary",
        message: "unexpected severity",
        alerted_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED, {
        lease_id: "lease-1",
        workspace_id: "workspace-1",
        operation_type: "surface.bind_object",
        granted_to: "",
        released_by: "user",
        failed_at: validTimestamp
      })
    ).toThrow();

    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED, {
        workspace_id: "workspace-1",
        reason: "planner_failed",
        retry_count: 3,
        fused_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED, {
        shaping_id: "shape-1",
        command_class: "search",
        original_count: 2,
        compressed_to: 1,
        compression_mode: "last_only",
        original_event_ids: ["evt-1", "evt-2"]
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED, {
        workspace_id: "workspace-1",
        run_id: "run-1",
        total_original: 2,
        total_after_shaping: 1,
        compression_ratio: Number.POSITIVE_INFINITY,
        compressed_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED, {
        workspace_id: "workspace-1",
        posture: "impossible",
        zero_day_active: true,
        active_security_locks: 0,
        reason: "workspace_initialized",
        changed_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED, {
        workspace_id: "workspace-1",
        operation: "bootstrap",
        failed_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED, {
        descriptor_type: "tool_provider",
        descriptor_id: "",
        name: "Invalid provider",
        source: "mcp_external",
        registered_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED, {
        provider_id: "provider.mcp.filesystem",
        tool_id: "",
        tool_name: "filesystem.read_file",
        source: "mcp_external",
        discovered_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED, {
        tool_id: "mcp__filesystem__read_file",
        provider_id: "provider.mcp.filesystem",
        permission_checked: true,
        execution_recorded: "yes",
        checked_at: validTimestamp
      })
    ).toThrow();
    expect(() =>
      parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED, {
        fragment_id: workerDispatchFragmentId,
        workspace_id: "workspace-1",
        category: "hard_constraint",
        authority_source: "",
        registered_at: validTimestamp,
        content_sha256: "not-a-sha256"
      })
    ).toThrow();
    expect(() =>
      OutputShapingRuleSchema.parse({
        command_class: "search",
        min_consecutive: -1,
        compression_mode: "last_only"
      })
    ).toThrow();
    expect(() =>
      OutputShapingResultSchema.parse({
        shaping_id: "shape-1",
        command_class: "search",
        original_count: 2,
        compressed_to: 1,
        compression_mode: "last_only",
        original_event_ids: [],
        shaped_at: validTimestamp
      })
    ).toThrow();
  });
});

describe("PathGraphSnapshotCreatedPayload legacy compatibility", () => {
  // invariant: total_retired_paths is deprecated but rows persisted
  // before its retirement still carry it; the strict payload schema
  // MUST tolerate the optional field so EventLog replay does not throw.
  it("parses a legacy payload carrying total_retired_paths: 0", () => {
    const legacyPayload = {
      snapshot_id: "snap-legacy-1",
      workspace_id: "workspace-1",
      total_active_paths: 12,
      total_retired_paths: 0,
      snapshot_at: validTimestamp
    };
    const parsed = PathGraphSnapshotCreatedPayloadSchema.parse(legacyPayload);
    expect(parsed).toEqual(legacyPayload);
  });

  it("parses a fresh payload omitting total_retired_paths", () => {
    const freshPayload = {
      snapshot_id: "snap-fresh-1",
      workspace_id: "workspace-1",
      total_active_paths: 7,
      snapshot_at: validTimestamp
    };
    const parsed = PathGraphSnapshotCreatedPayloadSchema.parse(freshPayload);
    expect(parsed).toEqual(freshPayload);
    expect("total_retired_paths" in parsed).toBe(false);
  });
});
