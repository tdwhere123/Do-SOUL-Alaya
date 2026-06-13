import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../../events/event-log.js";
import {
  RuntimeGovernanceEventType,
  RuntimeGovernanceEventTypeSchema,
  SecurityPassthroughInitializationFailedPayloadSchema,
  parseRuntimeGovernanceEventPayload
} from "../../events/runtime-governance.js";
import {
  OutputShapingResultSchema,
  OutputShapingRuleSchema
} from "../../soul/output-shaping.js";

const validTimestamp = "2026-04-17T08:00:00.000Z";
const workerDispatchFragmentId =
  "constitutional://workspace-1/hard_constraint/system.worker_dispatch-9c5ea45891f0";

describe("Phase C event validation", () => {
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
