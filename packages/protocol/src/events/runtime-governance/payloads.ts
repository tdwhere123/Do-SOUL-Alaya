import { z } from "zod";
import {
  BoundedIdSchema,
  BoundedLabelSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../../shared/schema-primitives.js";
import {
  ConstitutionalFragmentCategorySchema,
  ConstitutionalFragmentIdSchema
} from "../../soul/constitutional-fragment.js";
import { ComputeProviderPrioritySchema } from "../../soul/compute-routing.js";
import {
  ExtensionDescriptorTypeSchema,
  ExtensionSourceSchema
} from "../../soul/extension-descriptors.js";
import {
  ExecutionConservatismSchema,
  ExecutionVerificationAttentionSchema
} from "../../soul/execution-stance.js";
import { ManifestationLevelSchema } from "../../soul/manifestation-budget.js";
import { OutputShapingResultSchema } from "../../soul/output-shaping.js";
import { SecurityPostureSchema } from "../../soul/security-status.js";

import {
  PathRelationCreatedPayloadSchema,
  PathRelationRejectedPayloadSchema,
  PathRelationLegitimacyUpdatedPayloadSchema,
  PathRelationReinforcedPayloadSchema,
  PathRelationWeakenedPayloadSchema,
  PathRelationRedirectedPayloadSchema,
  PathRelationRetiredPayloadSchema,
  PathRelationDormantPayloadSchema,
  PathRelationRevivedPayloadSchema,
  PathRelationMergedPayloadSchema
} from "./payloads/path-relation-payloads.js";
import {
  SurfaceDriftDetectedPayloadSchema,
  SurfaceDriftLeaseAcquiredPayloadSchema,
  SurfaceDriftLeaseReleasedPayloadSchema,
  SurfaceDriftLeaseReleaseFailedPayloadSchema,
  SurfaceDriftAlertPayloadSchema
} from "./payloads/surface-drift-payloads.js";

export {
  PathRelationCreatedPayloadSchema,
  PathRelationRejectedPayloadSchema,
  PathRelationLegitimacyUpdatedPayloadSchema,
  PathRelationReinforcedPayloadSchema,
  PathRelationWeakenedPayloadSchema,
  PathRelationRedirectedPayloadSchema,
  PathRelationRetiredPayloadSchema,
  PathRelationDormantPayloadSchema,
  PathRelationRevivedPayloadSchema,
  MergedLoserRecallBiasSignSchema,
  PathRelationMergedLoserSchema,
  PathRelationMergedPayloadSchema
} from "./payloads/path-relation-payloads.js";
export {
  SurfaceDriftDetectedPayloadSchema,
  SurfaceDriftLeaseAcquiredPayloadSchema,
  SurfaceDriftLeaseReleasedPayloadSchema,
  SurfaceDriftLeaseReleaseFailedPayloadSchema,
  SurfaceDriftAlertPayloadSchema
} from "./payloads/surface-drift-payloads.js";

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

const runtimeGovernanceEventTypeValues = [
  "canonicalization.applied",
  "canonicalization.alias_resolved",
  "stance.policy_evaluated",
  "stance.resolution_changed",
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

const runtimeSideEffectFailureSeverityValues = ["warning", "error"] as const;

export const RuntimeGovernanceEventType = {
  CANONICALIZATION_APPLIED: "canonicalization.applied",
  CANONICALIZATION_ALIAS_RESOLVED: "canonicalization.alias_resolved",
  STANCE_POLICY_EVALUATED: "stance.policy_evaluated",
  STANCE_RESOLUTION_CHANGED: "stance.resolution_changed",
  PATH_RELATION_CREATED: "path.relation_created",
  // invariant: durable audit that an agent/Garden-proposed path candidate was
  // refused at the mint sink because an object anchor it carries does not
  // exist in, or is not owned by, the relation workspace. Agents PROPOSE;
  // Alaya DECIDES — a rejected candidate never becomes durable graph topology,
  // and this event is the only forensic trace that the refusal happened.
  // see also: path-relation-proposal-service.ts materialize anchor gate.
  PATH_RELATION_REJECTED: "path.relation_rejected",
  PATH_RELATION_LEGITIMACY_UPDATED: "path.relation_legitimacy_updated",
  PATH_RELATION_REINFORCED: "path.relation_reinforced",
  PATH_RELATION_WEAKENED: "path.relation_weakened",
  PATH_RELATION_REDIRECTED: "path.relation_redirected",
  PATH_RELATION_RETIRED: "path.relation_retired",
  // invariant: dormant is the positive-associative-family decay landing
  // point (reversible), distinct from terminal retired. revived reverses it.
  PATH_RELATION_DORMANT: "path.relation_dormant",
  PATH_RELATION_REVIVED: "path.relation_revived",
  // invariant: a merge folds dormant duplicate paths into an evidence-richest
  // survivor. The losers are deleted; the survivor absorbs their provenance.
  // This is a SYSTEM consolidation decision (Alaya decides), audited so the
  // deleted losers' evidence is never silently discarded.
  PATH_RELATION_MERGED: "path.relation_merged",
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
  RUNTIME_SIDE_EFFECT_FAILED: "runtime.side_effect_failed",
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

export const PathGraphSnapshotCreatedPayloadSchema = z
  .object({
    snapshot_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    total_active_paths: NonNegativeIntSchema,
    snapshot_at: IsoDatetimeStringSchema,
    // invariant: deprecated and no longer emitted; retained as optional
    // so EventLog replay tolerates rows persisted before the field was
    // retired. Producers MUST omit it; consumers MUST ignore it.
    total_retired_paths: NonNegativeIntSchema.optional()
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
    reason: BoundedReasonSchema.nullable().optional(),
    error_code: BoundedLabelSchema.nullable().optional()
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
    decided_at: IsoDatetimeStringSchema,
    // invariant: one resolve may emit 0..N DECIDED events when the decision
    // list exceeds the bounded JSON size. Consumers fold by matching
    // (run_id, decided_at) and concatenate `decisions` in batch_index order
    // when present. Omitting batch_* remains valid for single-batch emits.
    batch_index: NonNegativeIntSchema.optional(),
    batch_count: NonNegativeIntSchema.optional()
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

export const RuntimeSideEffectFailedPayloadSchema = z
  .object({
    source: BoundedLabelSchema,
    operation: BoundedLabelSchema,
    subject_type: BoundedLabelSchema,
    subject_id: BoundedIdSchema,
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema.nullable(),
    committed_event_id: NonEmptyStringSchema.nullable(),
    severity: z.enum(runtimeSideEffectFailureSeverityValues),
    error_name: BoundedLabelSchema.nullable(),
    error_message: BoundedReasonSchema,
    failed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const runtimeGovernancePayloadSchemas = {
  [RuntimeGovernanceEventType.CANONICALIZATION_APPLIED]: CanonicalizationAppliedPayloadSchema,
  [RuntimeGovernanceEventType.CANONICALIZATION_ALIAS_RESOLVED]: CanonicalizationAliasResolvedPayloadSchema,
  [RuntimeGovernanceEventType.STANCE_POLICY_EVALUATED]: StancePolicyEvaluatedPayloadSchema,
  [RuntimeGovernanceEventType.STANCE_RESOLUTION_CHANGED]: StanceResolutionChangedPayloadSchema,
  [RuntimeGovernanceEventType.COMPUTE_PROVIDER_ROUTED]: ComputeProviderRoutedPayloadSchema,
  [RuntimeGovernanceEventType.BOOTSTRAPPING_PATHS_PLANTED]: BootstrappingPathsPlantedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_CREATED]: PathRelationCreatedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_REJECTED]: PathRelationRejectedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED]:
    PathRelationLegitimacyUpdatedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_REINFORCED]: PathRelationReinforcedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_WEAKENED]: PathRelationWeakenedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED]: PathRelationRedirectedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_RETIRED]: PathRelationRetiredPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_DORMANT]: PathRelationDormantPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_REVIVED]: PathRelationRevivedPayloadSchema,
  [RuntimeGovernanceEventType.PATH_RELATION_MERGED]: PathRelationMergedPayloadSchema,
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
  [RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED]:
    RuntimeSideEffectFailedPayloadSchema,
  [RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED]:
    ConstitutionalFragmentRegisteredPayloadSchema
} as const;
