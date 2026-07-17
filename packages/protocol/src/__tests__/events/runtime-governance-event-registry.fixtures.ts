export const validTimestamp = "2026-04-17T08:00:00.000Z";
export const workerDispatchFragmentId =
  "constitutional://workspace-1/hard_constraint/system.worker_dispatch-9c5ea45891f0";

export const expectedEventTypes = [
      "canonicalization.applied",
      "canonicalization.alias_resolved",
      "stance.policy_evaluated",
      "stance.resolution_changed",
      "relation.assertion_admitted",
      "relation.assertion_resolved",
      "path.relation_created",
      "path.relation_rejected",
      "path.relation_legitimacy_updated",
      "path.relation_reinforced",
      "path.relation_weakened",
      "path.relation_redirected",
      "path.relation_retired",
      "path.relation_dormant",
      "path.relation_revived",
      "path.relation_merged",
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
      "runtime.side_effect_failed",
      "constitutional.fragment_registered"
    ] as const;

export const canonicalizationAppliedPayload = {
      input: "用户偏好",
      canonical: "user_preference",
      domain: "governance_subject.domain",
      was_alias_resolved: true,
      applied_at: validTimestamp
    } as const;
export const canonicalizationAliasResolvedPayload = {
      alias: "用户偏好",
      canonical: "user_preference",
      domain: "governance_subject.domain",
      language: "zh",
      resolved_at: validTimestamp
    } as const;
export const stancePolicyPayload = {
      workspace_id: "workspace-1",
      policy_id: "policy-1",
      default_verification_attention: "standard",
      default_conservatism: "balanced",
      evaluated_at: validTimestamp
    } as const;
export const stanceResolutionPayload = {
      resolution_id: "resolution-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      verification_attention: "elevated",
      conservatism: "conservative",
      contributing_candidate_count: 2,
      has_model_ref: true,
      resolved_at: validTimestamp
    } as const;
export const relationAssertionAdmittedPayload = {
      assertion_id: "assertion-1",
      workspace_id: "workspace-1",
      evidence_ids: ["evidence-1"],
      anchors: {
        source_anchor: { kind: "object", object_id: "object-1" },
        target_anchor: { kind: "object", object_id: "object-2" }
      },
      relation_kind: "supports",
      validity: {
        kind: "open",
        valid_from: validTimestamp
      },
      admitted_at: validTimestamp
    } as const;
export const relationAssertionResolvedPayload = {
      resolution_id: "resolution-1",
      assertion_id: "assertion-1",
      workspace_id: "workspace-1",
      resolution_kind: "contradicted",
      resolved_at: validTimestamp,
      reason: "contradicting evidence admitted"
    } as const;
export const pathCreatedPayload = {
      path_id: "path-1",
      workspace_id: "workspace-1",
      relation_kind: "supports",
      source_anchor_kind: "object",
      target_anchor_kind: "object_facet",
      initial_strength: 0.3,
      governance_class: "hint_only",
      created_at: validTimestamp
    } as const;
export const pathRejectedPayload = {
      workspace_id: "workspace-1",
      relation_kind: "supports",
      anchor_role: "target",
      rejected_object_id: "mem-foreign-1",
      rejection_reason: "object_foreign_workspace",
      rejected_at: validTimestamp
    } as const;
export const reinforcedPayload = {
      path_id: "path-1",
      previous_strength: 0.3,
      new_strength: 0.4,
      support_events_count: 4,
      reinforced_at: validTimestamp
    } as const;
export const legitimacyUpdatedPayload = {
      path_id: "path-1",
      workspace_id: "workspace-1",
      previous_governance_class: "hint_only",
      new_governance_class: "strictly_governed",
      previous_evidence_basis: ["proposal:old"],
      new_evidence_basis: ["proposal:new"],
      updated_at: validTimestamp
    } as const;
export const weakenedPayload = {
      path_id: "path-1",
      previous_strength: 0.4,
      new_strength: 0.35,
      reason: "contradiction_detected",
      weakened_at: validTimestamp
    } as const;
export const retiredPayload = {
      path_id: "path-1",
      retirement_reason: "cooldown_expired",
      final_strength: 0.05,
      retired_at: validTimestamp
    } as const;
export const mergedPayload = {
      survivor_path_id: "path-survivor",
      merged_path_ids: ["path-loser-a", "path-loser-b"],
      relation_kind: "supports",
      survivor_why_entry_count: 3,
      merged_at: validTimestamp
    } as const;
export const redirectedPayload = {
      path_id: "path-1",
      previous_direction_bias: "target_to_source",
      new_direction_bias: "source_to_target",
      source_usage_count: 0,
      target_usage_count: 2,
      redirected_at: validTimestamp
    } as const;
export const driftDetectedPayload = {
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      drift_type: "scope_change",
      severity: "governance_critical",
      affected_subject: "surface_binding",
      detected_at: validTimestamp
    } as const;
export const driftLeaseAcquiredPayload = {
      lease_id: "lease-1",
      workspace_id: "workspace-1",
      operation_type: "surface.bind_object",
      granted_to: "user",
      expires_at: "2026-04-17T08:05:00.000Z",
      granted_at: validTimestamp
    } as const;
export const driftLeaseReleasedPayload = {
      lease_id: "lease-1",
      workspace_id: "workspace-1",
      operation_type: "surface.rename_object",
      granted_to: "user",
      released_by: "user",
      released_at: validTimestamp
    } as const;
export const driftLeaseReleaseFailedPayload = {
      lease_id: "lease-1",
      workspace_id: "workspace-1",
      operation_type: "surface.transition_binding_state",
      granted_to: "user",
      released_by: "user",
      failed_at: validTimestamp
    } as const;
export const driftAlertPayload = {
      alert_id: "alert-1",
      drift_id: "drift-1",
      workspace_id: "workspace-1",
      severity: "governance_critical",
      message: "Surface governance-critical drift detected.",
      alerted_at: validTimestamp
    } as const;
export const snapshotCreatedPayload = {
      snapshot_id: "snapshot-1",
      workspace_id: "workspace-1",
      total_active_paths: 4,
      snapshot_at: validTimestamp
    } as const;
export const completedPayload = {
      workspace_id: "workspace-1",
      paths_reinforced: 2,
      paths_weakened: 1,
      paths_retired: 1,
      stability_promotions: 1,
      duration_ms: 42,
      completed_at: validTimestamp
    } as const;
export const fusedPayload = {
      workspace_id: "workspace-1",
      reason: "planner_failed",
      retry_count: 3,
      cooldown_until: "2026-04-17T08:01:00.000Z",
      fused_at: validTimestamp
    } as const;
export const outputShapingPayload = {
      shaping_id: "shape-1",
      command_class: "search",
      original_count: 3,
      compressed_to: 1,
      compression_mode: "last_only",
      original_event_ids: ["evt-1", "evt-2", "evt-3"],
      shaped_at: validTimestamp
    } as const;
export const commandCompressedPayload = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      total_original: 3,
      total_after_shaping: 1,
      compression_ratio: 1 / 3,
      compressed_at: validTimestamp
    } as const;
export const securityStatusChangedPayload = {
      workspace_id: "workspace-1",
      posture: "baseline",
      zero_day_active: true,
      active_security_locks: 0,
      reason: "workspace_initialized",
      changed_at: validTimestamp
    } as const;
export const securityInitializationFailedPayload = {
      workspace_id: "workspace-1",
      operation: "create",
      failed_at: validTimestamp
    } as const;
export const extensionDescriptorRegisteredPayload = {
      descriptor_type: "tool_provider",
      descriptor_id: "provider.mcp.filesystem",
      name: "Filesystem MCP Provider",
      source: "mcp_external",
      registered_at: validTimestamp
    } as const;
export const extensionDescriptorRegistrationRevertedPayload = {
      descriptor_type: "tool_provider",
      descriptor_id: "provider.mcp.filesystem",
      original_event_id: "event-1",
      reverted_at: validTimestamp
    } as const;
export const extensionDescriptorRegistrationCompensationFailedPayload = {
      descriptor_type: "tool_provider",
      descriptor_id: "provider.mcp.filesystem",
      original_event_id: "event-1",
      failed_at: validTimestamp
    } as const;
export const extensionToolDiscoveredPayload = {
      provider_id: "provider.mcp.filesystem",
      tool_id: "mcp__filesystem__read_file",
      tool_name: "filesystem.read_file",
      source: "mcp_external",
      discovered_at: validTimestamp
    } as const;
export const extensionGovernanceCheckedPayload = {
      tool_id: "mcp__filesystem__read_file",
      provider_id: "provider.mcp.filesystem",
      permission_checked: true,
      execution_recorded: true,
      checked_at: validTimestamp
    } as const;
export const constitutionalFragmentPayload = {
      fragment_id: workerDispatchFragmentId,
      workspace_id: "workspace-1",
      category: "hard_constraint",
      authority_source: "system.worker_dispatch",
      registered_at: validTimestamp,
      content_sha256: "9c5ea45891f09690b8d37bc9f1d21e1fd6d883198445846376e925f93edc4ae4"
    } as const;
export const computeProviderRoutedPayload = {
      decision_id: "decision-1",
      workspace_id: "workspace-1",
      selected_provider: "stub",
      model_id: "local-heuristics",
      selection_reason: "stub selected as configured fallback compute provider",
      decided_at: validTimestamp
    } as const;
export const bootstrappingPathsPlantedPayload = {
      record_id: "bootstrap-record-1",
      workspace_id: "workspace-1",
      paths_planted: 1,
      template_ids: ["workspace.bootstrap.explicit-test"],
      planted_at: validTimestamp
    } as const;
export const runtimeSideEffectFailedPayload = {
      source: "MemoryService",
      operation: "green_reevaluate_after_memory_create",
      subject_type: "memory_entry",
      subject_id: "memory-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      committed_event_id: "event-1",
      severity: "error",
      error_name: "Error",
      error_message: "green unavailable",
      failed_at: validTimestamp
    } as const;
