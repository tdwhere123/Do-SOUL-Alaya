import { z } from "zod";
import {
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
import {
  DirectionBiasSchema,
  PathGovernanceClassSchema
} from "../../soul/path-relation.js";
import { SecurityPostureSchema } from "../../soul/security-status.js";
import {
  DriftSeveritySchema,
  DriftTypeSchema,
  SurfaceDriftOperationTypeSchema
} from "../../soul/surface-drift.js";

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
  "constitutional.fragment_registered"
] as const;

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

// invariant: rejection_reason distinguishes a missing object id from one that
// exists but belongs to another workspace; both are refused, but the operator
// needs to tell a stale ref from a cross-workspace leak attempt. anchor_role
// names which side of the proposed relation failed. No path_id exists — the
// path was never minted — so the rejected anchor's object id keys the record.
export const PathRelationRejectedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    relation_kind: NonEmptyStringSchema,
    anchor_role: z.enum(["source", "target"]),
    rejected_object_id: NonEmptyStringSchema,
    rejection_reason: z.enum(["object_missing", "object_foreign_workspace"]),
    rejected_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathRelationLegitimacyUpdatedPayloadSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    previous_governance_class: PathGovernanceClassSchema,
    new_governance_class: PathGovernanceClassSchema,
    previous_evidence_basis: z.array(NonEmptyStringSchema).readonly(),
    new_evidence_basis: z.array(NonEmptyStringSchema).readonly(),
    updated_at: IsoDatetimeStringSchema
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
    // Optional count of contradiction signals, such as not_applicable
    // receipts, attributed to this weakening event. Mirrors
    // PathRelationReinforcedPayloadSchema.support_events_count so an
    // audit-only replayer can reconstruct contradiction totals from the
    // event log without reading the durable PathRelation row. Optional to
    // preserve backward compatibility with older events that did not carry
    // this field.
    contradiction_events_count: NonNegativeIntSchema.optional(),
    weakened_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const PathRelationRedirectedPayloadSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    previous_direction_bias: DirectionBiasSchema,
    new_direction_bias: DirectionBiasSchema,
    source_usage_count: NonNegativeIntSchema,
    target_usage_count: NonNegativeIntSchema,
    redirected_at: IsoDatetimeStringSchema
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

// invariant: dormant clears effect_vector.salience to 0 and drops the path
// out of recall while leaving the row in the DB; strength is preserved so a
// revive can restore the path. active <-> dormant is reversible.
export const PathRelationDormantPayloadSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    dormancy_reason: NonEmptyStringSchema,
    dormant_strength: z.number(),
    dormant_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

// invariant: revive resets strength to the configured revive floor and
// returns the path to active. The trigger is recorded so an audit replayer
// can distinguish a usage-driven revive from an explicit override.
export const PathRelationRevivedPayloadSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    revive_trigger: NonEmptyStringSchema,
    previous_strength: z.number(),
    new_strength: z.number(),
    revived_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

// invariant: the sign of a deleted loser's recall_bias. Positive paths amplify
// recall; negative paths suppress (the contradicts / supersedes family); zero
// is the recall-neutral topology marker (exception_to). Recorded so a deleted
// loser's family is reconstructable from the append-only log even though the
// survivor row keeps only its own effect_vector.
// see also: packages/protocol/src/soul/path-relation.ts isPathRecallEligible.
export const MergedLoserRecallBiasSignSchema = z.enum(["positive", "negative", "zero"]);

// invariant: a merge DELETES the loser rows; this schema is the ONLY durable
// record of the destroyed provenance. The survivor ROW absorbs only a bounded
// subset of loser why/evidence (capped at consolidation_merge_why_max_entries),
// so the dropped remainder lives nowhere except here. Each entry therefore
// carries the loser's FULL why_this_relation_exists + evidence_basis plus an
// effect_vector summary, so an audit replayer can fully reconstruct what was
// destroyed (durable memory needs source + evidence).
export const PathRelationMergedLoserSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    why_this_relation_exists: z.array(NonEmptyStringSchema).readonly(),
    evidence_basis: z.array(NonEmptyStringSchema).readonly(),
    recall_bias_sign: MergedLoserRecallBiasSignSchema,
    recall_bias_magnitude: z.number(),
    direction_bias: DirectionBiasSchema
  })
  .strict()
  .readonly();

// invariant: a merge deletes the loser paths and folds their provenance into
// the survivor. merged_path_ids carries the deleted loser ids and merged_losers
// carries each deleted loser's FULL destroyed why/evidence + effect summary, so
// an audit replayer can reconstruct which paths were absorbed AND every why/
// evidence entry dropped past the survivor row's bound — no loser provenance is
// discarded silently (durable memory needs source + evidence). merged_losers is
// optional so EventLog replay tolerates rows persisted before the field existed;
// the consolidation executor (producer) MUST populate one entry per merged_path_id.
export const PathRelationMergedPayloadSchema = z
  .object({
    survivor_path_id: NonEmptyStringSchema,
    merged_path_ids: z.array(NonEmptyStringSchema).readonly(),
    relation_kind: NonEmptyStringSchema,
    survivor_why_entry_count: NonNegativeIntSchema,
    merged_losers: z.array(PathRelationMergedLoserSchema).readonly().optional(),
    merged_at: IsoDatetimeStringSchema
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
  [RuntimeGovernanceEventType.CONSTITUTIONAL_FRAGMENT_REGISTERED]:
    ConstitutionalFragmentRegisteredPayloadSchema
} as const;
