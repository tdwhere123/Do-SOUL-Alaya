import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../../../shared/schema-primitives.js";
import { DirectionBiasSchema, PathGovernanceClassSchema } from "../../../soul/path-relation.js";

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
