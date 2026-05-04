import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import {
  ConstitutionalFragmentCategorySchema,
  ConstitutionalFragmentIdSchema
} from "../soul/constitutional-fragment.js";
import { ComputeProviderPrioritySchema } from "../soul/compute-routing.js";
import {
  ExtensionDescriptorTypeSchema,
  ExtensionSourceSchema
} from "../soul/extension-descriptors.js";
import {
  ExecutionConservatismSchema,
  ExecutionVerificationAttentionSchema
} from "../soul/execution-stance.js";
import { ManifestationLevelSchema } from "../soul/manifestation-budget.js";
import { OutputShapingResultSchema } from "../soul/output-shaping.js";
import { PathGovernanceClassSchema } from "../soul/path-relation.js";
import { SecurityPostureSchema } from "../soul/security-status.js";
import {
  DriftSeveritySchema,
  DriftTypeSchema,
  SurfaceDriftOperationTypeSchema
} from "../soul/surface-drift.js";

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

const runtimeGovernanceEventTypeValues = [
  "canonicalization.applied",
  "canonicalization.alias_resolved",
  "stance.policy_evaluated",
  "stance.resolution_changed",
  "path.relation_created",
  "path.relation_reinforced",
  "path.relation_weakened",
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

export const RuntimeGovernanceEventType = {
  CANONICALIZATION_APPLIED: "canonicalization.applied",
  CANONICALIZATION_ALIAS_RESOLVED: "canonicalization.alias_resolved",
  STANCE_POLICY_EVALUATED: "stance.policy_evaluated",
  STANCE_RESOLUTION_CHANGED: "stance.resolution_changed",
  PATH_RELATION_CREATED: "path.relation_created",
  PATH_RELATION_REINFORCED: "path.relation_reinforced",
  PATH_RELATION_WEAKENED: "path.relation_weakened",
  PATH_RELATION_RETIRED: "path.relation_retired",
  PATH_CONSOLIDATION_COMPLETED: "path.consolidation_completed",
  PATH_CONSOLIDATION_FUSED: "path.consolidation_fused",
  SURFACE_DRIFT_DETECTED: "surface.drift_detected",
  SURFACE_DRIFT_LEASE_ACQUIRED: "surface.drift_lease_acquired",
  SURFACE_DRIFT_LEASE_RELEASED: "surface.drift_lease_released",
  SURFACE_DRIFT_LEASE_RELEASE_FAILED: "surface.drift_lease_release_failed",
  SURFACE_DRIFT_ALERT: "surface.drift_alert",
  PATH_GRAPH_SNAPSHOT_CREATED: "path.graph.snapshot_created",
  OUTPUT_SHAPING_APPLIED: "output.shaping_applied",
  OUTPUT_COMMAND_COMPRESSED: "output.command_compressed",
  MANIFESTATION_BUDGET_EVALUATED: "manifestation.budget_evaluated",
  MANIFESTATION_ESCALATION_DECIDED: "manifestation.escalation_decided",
  SECURITY_PASSTHROUGH_STATUS_CHANGED: "security.passthrough_status_changed",
  SECURITY_PASSTHROUGH_INITIALIZATION_FAILED: "security.passthrough_initialization_failed",
  EXTENSION_DESCRIPTOR_REGISTERED: "extension.descriptor_registered",
  EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED:
    "extension.descriptor_registration_reverted",
  EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED:
    "extension.descriptor_registration_compensation_failed",
  EXTENSION_TOOL_DISCOVERED: "extension.tool_discovered",
  EXTENSION_GOVERNANCE_CHECKED: "extension.governance_checked",
  COMPUTE_PROVIDER_ROUTED: "compute.provider_routed",
  BOOTSTRAPPING_PATHS_PLANTED: "bootstrapping.paths_planted",
  CONSTITUTIONAL_FRAGMENT_REGISTERED: "constitutional.fragment_registered"
} as const;

export const RuntimeGovernanceEventTypeSchema = z.enum(runtimeGovernanceEventTypeValues);

export const CanonicalizationAppliedPayloadSchema = z
  .object({
    input: NonEmptyStringSchema,
    canonical: NonEmptyStringSchema,
    domain: NonEmptyStringSchema,
    was_alias_resolved: z.boolean(),
    applied_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const CanonicalizationAliasResolvedPayloadSchema = z
  .object({
    alias: NonEmptyStringSchema,
    canonical: NonEmptyStringSchema,
    domain: NonEmptyStringSchema,
    language: NonEmptyStringSchema,
    resolved_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const StancePolicyEvaluatedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    policy_id: NonEmptyStringSchema.nullable(),
    default_verification_attention: ExecutionVerificationAttentionSchema,
    default_conservatism: ExecutionConservatismSchema,
    evaluated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const StanceResolutionChangedPayloadSchema = z
  .object({
    resolution_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    verification_attention: ExecutionVerificationAttentionSchema,
    conservatism: ExecutionConservatismSchema,
    contributing_candidate_count: NonNegativeIntSchema,
    has_model_ref: z.boolean(),
    resolved_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ComputeProviderRoutedPayloadSchema = z
  .object({
    decision_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    selected_provider: ComputeProviderPrioritySchema,
    model_id: NonEmptyStringSchema,
    selection_reason: NonEmptyStringSchema,
    decided_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const BootstrappingPathsPlantedPayloadSchema = z
  .object({
    record_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    paths_planted: NonNegativeIntSchema,
    template_ids: z.array(NonEmptyStringSchema).readonly(),
    planted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathRelationCreatedPayloadSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    relation_kind: NonEmptyStringSchema,
    source_anchor_kind: NonEmptyStringSchema,
    target_anchor_kind: NonEmptyStringSchema,
    initial_strength: z.number(),
    governance_class: PathGovernanceClassSchema,
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathRelationReinforcedPayloadSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    previous_strength: z.number(),
    new_strength: z.number(),
    support_events_count: NonNegativeIntSchema,
    reinforced_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathRelationWeakenedPayloadSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    previous_strength: z.number(),
    new_strength: z.number(),
    reason: NonEmptyStringSchema,
    // Optional, A3: counts the number of contradiction signals (e.g.
    // not_applicable receipts) attributed to this weakening event. Mirrors
    // PathRelationReinforcedPayloadSchema.support_events_count so an
    // audit-only replayer can reconstruct contradiction totals from the
    // event log without reading the durable PathRelation row. Optional to
    // preserve backward compatibility with pre-A3 events that did not carry
    // this field.
    contradiction_events_count: NonNegativeIntSchema.optional(),
    weakened_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathRelationRetiredPayloadSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    retirement_reason: NonEmptyStringSchema,
    final_strength: z.number(),
    retired_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftDetectedPayloadSchema = z
  .object({
    drift_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    drift_type: DriftTypeSchema,
    severity: DriftSeveritySchema,
    affected_subject: NonEmptyStringSchema,
    detected_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftLeaseAcquiredPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    operation_type: SurfaceDriftOperationTypeSchema,
    granted_to: NonEmptyStringSchema,
    expires_at: IsoDatetimeStringSchema,
    granted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftLeaseReleasedPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    operation_type: SurfaceDriftOperationTypeSchema,
    granted_to: NonEmptyStringSchema,
    released_by: NonEmptyStringSchema,
    released_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftLeaseReleaseFailedPayloadSchema = z
  .object({
    lease_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    operation_type: SurfaceDriftOperationTypeSchema,
    granted_to: NonEmptyStringSchema,
    released_by: NonEmptyStringSchema,
    failed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SurfaceDriftAlertPayloadSchema = z
  .object({
    alert_id: NonEmptyStringSchema,
    drift_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    severity: z.literal("governance_critical"),
    message: NonEmptyStringSchema,
    alerted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathGraphSnapshotCreatedPayloadSchema = z
  .object({
    snapshot_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    total_active_paths: NonNegativeIntSchema,
    total_retired_paths: NonNegativeIntSchema,
    snapshot_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathConsolidationCompletedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    paths_reinforced: NonNegativeIntSchema,
    paths_weakened: NonNegativeIntSchema,
    paths_retired: NonNegativeIntSchema,
    stability_promotions: NonNegativeIntSchema,
    duration_ms: NonNegativeIntSchema,
    completed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathConsolidationFusedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    reason: NonEmptyStringSchema,
    retry_count: NonNegativeIntSchema,
    cooldown_until: IsoDatetimeStringSchema,
    fused_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const OutputShapingAppliedPayloadSchema = OutputShapingResultSchema;

export const OutputCommandCompressedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    total_original: NonNegativeIntSchema,
    total_after_shaping: NonNegativeIntSchema,
    compression_ratio: z.number().finite(),
    compressed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ManifestationBudgetEvaluatedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    total_candidates: NonNegativeIntSchema,
    stance_bias_assigned: NonNegativeIntSchema,
    dialogue_nudge_assigned: NonNegativeIntSchema,
    lens_entry_assigned: NonNegativeIntSchema,
    discarded: NonNegativeIntSchema,
    evaluated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SecurityPassthroughStatusChangedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    posture: SecurityPostureSchema,
    zero_day_active: z.boolean(),
    active_security_locks: NonNegativeIntSchema,
    reason: NonEmptyStringSchema,
    changed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SecurityPassthroughInitializationOperationSchema = z.enum([
  "create",
  "list",
  "get_by_id"
]);

export const SecurityPassthroughInitializationFailedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    operation: SecurityPassthroughInitializationOperationSchema,
    failed_at: IsoDatetimeStringSchema,
    reason: z.string().nullable().optional(),
    error_code: z.string().nullable().optional()
  })
  .strict()
  .readonly();

export const ManifestationEscalationDecidedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    decisions: z
      .array(
        z
          .object({
            candidate_id: NonEmptyStringSchema,
            assigned_level: ManifestationLevelSchema.nullable(),
            reason: NonEmptyStringSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    decided_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ExtensionDescriptorRegisteredPayloadSchema = z
  .object({
    descriptor_type: ExtensionDescriptorTypeSchema,
    descriptor_id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    source: ExtensionSourceSchema,
    registered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ExtensionDescriptorRegistrationRevertedPayloadSchema = z
  .object({
    descriptor_type: ExtensionDescriptorTypeSchema,
    descriptor_id: NonEmptyStringSchema,
    original_event_id: NonEmptyStringSchema,
    reverted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ExtensionDescriptorRegistrationCompensationFailedPayloadSchema = z
  .object({
    descriptor_type: ExtensionDescriptorTypeSchema,
    descriptor_id: NonEmptyStringSchema,
    original_event_id: NonEmptyStringSchema,
    failed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ExtensionToolDiscoveredPayloadSchema = z
  .object({
    provider_id: NonEmptyStringSchema,
    tool_id: NonEmptyStringSchema,
    tool_name: NonEmptyStringSchema,
    source: ExtensionSourceSchema,
    discovered_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ExtensionGovernanceCheckedPayloadSchema = z
  .object({
    tool_id: NonEmptyStringSchema,
    provider_id: NonEmptyStringSchema,
    permission_checked: z.boolean(),
    execution_recorded: z.boolean(),
    checked_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ConstitutionalFragmentRegisteredPayloadSchema = z
  .object({
    fragment_id: ConstitutionalFragmentIdSchema,
    workspace_id: NonEmptyStringSchema,
    category: ConstitutionalFragmentCategorySchema,
    authority_source: NonEmptyStringSchema,
    registered_at: IsoDatetimeStringSchema,
    content_sha256: Sha256HexSchema
  })
  .strict()
  .readonly();

const runtimeGovernancePayloadSchemas = {
  [RuntimeGovernanceEventType.CANONICALIZATION_APPLIED]: CanonicalizationAppliedPayloadSchema,
  [RuntimeGovernanceEventType.CANONICALIZATION_ALIAS_RESOLVED]: CanonicalizationAliasResolvedPayloadSchema,
  [RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED]: StancePolicyEvaluatedPayloadSchema,
  [RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED]: StanceResolutionChangedPayloadSchema,
  [RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED]: ComputeProviderRoutedPayloadSchema,
  [RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED]: BootstrappingPathsPlantedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_CREATED]: PathRelationCreatedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_REINFORCED]: PathRelationReinforcedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_WEAKENED]: PathRelationWeakenedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_RETIRED]: PathRelationRetiredPayloadSchema,
  [RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED]: SurfaceDriftDetectedPayloadSchema,
  [RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED]: SurfaceDriftLeaseAcquiredPayloadSchema,
  [RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED]: SurfaceDriftLeaseReleasedPayloadSchema,
  [RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED]:
    SurfaceDriftLeaseReleaseFailedPayloadSchema,
  [RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT]: SurfaceDriftAlertPayloadSchema,
  [RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED]: PathGraphSnapshotCreatedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED]: PathConsolidationCompletedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED]: PathConsolidationFusedPayloadSchema,
  [RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED]: OutputShapingAppliedPayloadSchema,
  [RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED]: OutputCommandCompressedPayloadSchema,
  [RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED]: ManifestationBudgetEvaluatedPayloadSchema,
  [RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED]:
    ManifestationEscalationDecidedPayloadSchema,
  [RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED]:
    SecurityPassthroughStatusChangedPayloadSchema,
  [RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED]:
    SecurityPassthroughInitializationFailedPayloadSchema,
  [RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED]:
    ExtensionDescriptorRegisteredPayloadSchema,
  [RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED]:
    ExtensionDescriptorRegistrationRevertedPayloadSchema,
  [RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED]:
    ExtensionDescriptorRegistrationCompensationFailedPayloadSchema,
  [RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED]:
    ExtensionToolDiscoveredPayloadSchema,
  [RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED]:
    ExtensionGovernanceCheckedPayloadSchema,
  [RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED]:
    ConstitutionalFragmentRegisteredPayloadSchema
} as const;

function createRuntimeGovernanceEventObjectSchema<T extends keyof typeof runtimeGovernancePayloadSchemas>(
  type: T,
  payloadSchema: (typeof runtimeGovernancePayloadSchemas)[T]
) {
  return z.object({
    type: z.literal(type),
    payload: payloadSchema
  });
}

const CanonicalizationAppliedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.CANONICALIZATION_APPLIED,
  CanonicalizationAppliedPayloadSchema
);
const CanonicalizationAliasResolvedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.CANONICALIZATION_ALIAS_RESOLVED,
  CanonicalizationAliasResolvedPayloadSchema
);
const StancePolicyEvaluatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED,
  StancePolicyEvaluatedPayloadSchema
);
const StanceResolutionChangedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED,
  StanceResolutionChangedPayloadSchema
);
const ComputeProviderRoutedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED,
  ComputeProviderRoutedPayloadSchema
);
const BootstrappingPathsPlantedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED,
  BootstrappingPathsPlantedPayloadSchema
);
const PathRelationCreatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.PATH_RELATION_CREATED,
  PathRelationCreatedPayloadSchema
);
const PathRelationReinforcedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.PATH_RELATION_REINFORCED,
  PathRelationReinforcedPayloadSchema
);
const PathRelationWeakenedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.PATH_RELATION_WEAKENED,
  PathRelationWeakenedPayloadSchema
);
const PathRelationRetiredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
  PathRelationRetiredPayloadSchema
);
const SurfaceDriftDetectedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.SURFACE_DRIFT_DETECTED,
  SurfaceDriftDetectedPayloadSchema
);
const SurfaceDriftLeaseAcquiredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_ACQUIRED,
  SurfaceDriftLeaseAcquiredPayloadSchema
);
const SurfaceDriftLeaseReleasedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASED,
  SurfaceDriftLeaseReleasedPayloadSchema
);
const SurfaceDriftLeaseReleaseFailedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.SURFACE_DRIFT_LEASE_RELEASE_FAILED,
  SurfaceDriftLeaseReleaseFailedPayloadSchema
);
const SurfaceDriftAlertEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.SURFACE_DRIFT_ALERT,
  SurfaceDriftAlertPayloadSchema
);
const PathGraphSnapshotCreatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.PATH_GRAPH_SNAPSHOT_CREATED,
  PathGraphSnapshotCreatedPayloadSchema
);
const PathConsolidationCompletedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED,
  PathConsolidationCompletedPayloadSchema
);
const PathConsolidationFusedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED,
  PathConsolidationFusedPayloadSchema
);
const OutputShapingAppliedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.OUTPUT_SHAPING_APPLIED,
  OutputShapingAppliedPayloadSchema
);
const OutputCommandCompressedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.OUTPUT_COMMAND_COMPRESSED,
  OutputCommandCompressedPayloadSchema
);
const ManifestationBudgetEvaluatedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.MANIFESTATION_BUDGET_EVALUATED,
  ManifestationBudgetEvaluatedPayloadSchema
);
const ManifestationEscalationDecidedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.MANIFESTATION_ESCALATION_DECIDED,
  ManifestationEscalationDecidedPayloadSchema
);
const SecurityPassthroughStatusChangedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_STATUS_CHANGED,
  SecurityPassthroughStatusChangedPayloadSchema
);
const SecurityPassthroughInitializationFailedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.SECURITY_PASSTHROUGH_INITIALIZATION_FAILED,
  SecurityPassthroughInitializationFailedPayloadSchema
);
const ExtensionDescriptorRegisteredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED,
  ExtensionDescriptorRegisteredPayloadSchema
);
const ExtensionDescriptorRegistrationRevertedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED,
  ExtensionDescriptorRegistrationRevertedPayloadSchema
);
const ExtensionDescriptorRegistrationCompensationFailedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED,
  ExtensionDescriptorRegistrationCompensationFailedPayloadSchema
);
const ExtensionToolDiscoveredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.EXTENSION_TOOL_DISCOVERED,
  ExtensionToolDiscoveredPayloadSchema
);
const ExtensionGovernanceCheckedEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.EXTENSION_GOVERNANCE_CHECKED,
  ExtensionGovernanceCheckedPayloadSchema
);
const ConstitutionalFragmentRegisteredEventObjectSchema = createRuntimeGovernanceEventObjectSchema(
  RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED,
  ConstitutionalFragmentRegisteredPayloadSchema
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
export const PathRelationReinforcedEventSchema = PathRelationReinforcedEventObjectSchema.readonly();
export const PathRelationWeakenedEventSchema = PathRelationWeakenedEventObjectSchema.readonly();
export const PathRelationRetiredEventSchema = PathRelationRetiredEventObjectSchema.readonly();
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
    PathRelationReinforcedEventObjectSchema,
    PathRelationWeakenedEventObjectSchema,
    PathRelationRetiredEventObjectSchema,
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
    ConstitutionalFragmentRegisteredEventObjectSchema
  ])
  .readonly();

export type RuntimeGovernanceEventPayloadMap = {
  [K in keyof typeof runtimeGovernancePayloadSchemas]: z.infer<(typeof runtimeGovernancePayloadSchemas)[K]>;
};

export function parseRuntimeGovernanceEventPayload<T extends keyof typeof runtimeGovernancePayloadSchemas>(
  type: T,
  payload: Record<string, unknown>
): RuntimeGovernanceEventPayloadMap[T] {
  const schema = runtimeGovernancePayloadSchemas[type];

  if (schema === undefined) {
    throw new Error(`Unknown Phase C event type: ${String(type)}`);
  }

  return schema.parse(payload) as RuntimeGovernanceEventPayloadMap[T];
}

export type RuntimeGovernanceEventTypeValue = z.infer<typeof RuntimeGovernanceEventTypeSchema>;
export type CanonicalizationAppliedPayload = z.infer<typeof CanonicalizationAppliedPayloadSchema>;
export type CanonicalizationAliasResolvedPayload = z.infer<
  typeof CanonicalizationAliasResolvedPayloadSchema
>;
export type StancePolicyEvaluatedPayload = z.infer<typeof StancePolicyEvaluatedPayloadSchema>;
export type StanceResolutionChangedPayload = z.infer<typeof StanceResolutionChangedPayloadSchema>;
export type ComputeProviderRoutedPayload = z.infer<typeof ComputeProviderRoutedPayloadSchema>;
export type BootstrappingPathsPlantedPayload = z.infer<
  typeof BootstrappingPathsPlantedPayloadSchema
>;
export type PathRelationCreatedPayload = z.infer<typeof PathRelationCreatedPayloadSchema>;
export type PathRelationReinforcedPayload = z.infer<typeof PathRelationReinforcedPayloadSchema>;
export type PathRelationWeakenedPayload = z.infer<typeof PathRelationWeakenedPayloadSchema>;
export type PathRelationRetiredPayload = z.infer<typeof PathRelationRetiredPayloadSchema>;
export type SurfaceDriftDetectedPayload = z.infer<typeof SurfaceDriftDetectedPayloadSchema>;
export type SurfaceDriftLeaseAcquiredPayload = z.infer<typeof SurfaceDriftLeaseAcquiredPayloadSchema>;
export type SurfaceDriftLeaseReleasedPayload = z.infer<typeof SurfaceDriftLeaseReleasedPayloadSchema>;
export type SurfaceDriftLeaseReleaseFailedPayload = z.infer<
  typeof SurfaceDriftLeaseReleaseFailedPayloadSchema
>;
export type SurfaceDriftAlertPayload = z.infer<typeof SurfaceDriftAlertPayloadSchema>;
export type PathGraphSnapshotCreatedPayload = z.infer<typeof PathGraphSnapshotCreatedPayloadSchema>;
export type PathConsolidationCompletedPayload = z.infer<typeof PathConsolidationCompletedPayloadSchema>;
export type PathConsolidationFusedPayload = z.infer<typeof PathConsolidationFusedPayloadSchema>;
export type OutputShapingAppliedPayload = z.infer<typeof OutputShapingAppliedPayloadSchema>;
export type OutputCommandCompressedPayload = z.infer<typeof OutputCommandCompressedPayloadSchema>;
export type ManifestationBudgetEvaluatedPayload = z.infer<
  typeof ManifestationBudgetEvaluatedPayloadSchema
>;
export type ManifestationEscalationDecidedPayload = z.infer<
  typeof ManifestationEscalationDecidedPayloadSchema
>;
export type SecurityPassthroughStatusChangedPayload = z.infer<
  typeof SecurityPassthroughStatusChangedPayloadSchema
>;
export type SecurityPassthroughInitializationFailedPayload = z.infer<
  typeof SecurityPassthroughInitializationFailedPayloadSchema
>;
export type ExtensionDescriptorRegisteredPayload = z.infer<
  typeof ExtensionDescriptorRegisteredPayloadSchema
>;
export type ExtensionDescriptorRegistrationRevertedPayload = z.infer<
  typeof ExtensionDescriptorRegistrationRevertedPayloadSchema
>;
export type ExtensionDescriptorRegistrationCompensationFailedPayload = z.infer<
  typeof ExtensionDescriptorRegistrationCompensationFailedPayloadSchema
>;
export type ExtensionToolDiscoveredPayload = z.infer<
  typeof ExtensionToolDiscoveredPayloadSchema
>;
export type ExtensionGovernanceCheckedPayload = z.infer<
  typeof ExtensionGovernanceCheckedPayloadSchema
>;
export type ConstitutionalFragmentRegisteredPayload = z.infer<
  typeof ConstitutionalFragmentRegisteredPayloadSchema
>;
export type RuntimeGovernanceEvent = z.infer<typeof RuntimeGovernanceEventUnionSchema>;
