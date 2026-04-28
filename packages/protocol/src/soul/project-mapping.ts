import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";
import { PersistentObjectEnvelopeSchema } from "./envelope.js";
import { MemoryDimension as MemoryDimensionValue } from "./memory-entry.js";
import type { MemoryDimension } from "./memory-entry.js";
import { ObjectKind } from "./object-kind.js";

const projectMappingStateValues = ["suggested", "probationary", "accepted", "adapted", "rejected", "not_applicable"] as const;
const acceptedByValues = ["user", "review", "deterministic_rule"] as const;
const confirmationPolicyValues = ["batch_recommend", "per_item", "strict"] as const;
const projectMappingTransitionActionValues = ["accept", "reject", "adapt", "not_applicable", "probationary"] as const;

export const ProjectMappingState = {
  SUGGESTED: "suggested",
  PROBATIONARY: "probationary",
  ACCEPTED: "accepted",
  ADAPTED: "adapted",
  REJECTED: "rejected",
  NOT_APPLICABLE: "not_applicable"
} as const;

export const AcceptedBy = {
  USER: "user",
  REVIEW: "review",
  DETERMINISTIC_RULE: "deterministic_rule"
} as const;

export const ConfirmationPolicy = {
  BATCH_RECOMMEND: "batch_recommend",
  PER_ITEM: "per_item",
  STRICT: "strict"
} as const;

export const ProjectMappingTransitionAction = {
  ACCEPT: "accept",
  REJECT: "reject",
  ADAPT: "adapt",
  NOT_APPLICABLE: "not_applicable",
  PROBATIONARY: "probationary"
} as const;

export const ProjectMappingStateSchema = z.enum(projectMappingStateValues);
export const AcceptedBySchema = z.enum(acceptedByValues);
export const ConfirmationPolicySchema = z.enum(confirmationPolicyValues);
export const ProjectMappingTransitionActionSchema = z.enum(projectMappingTransitionActionValues);

export const ProjectMappingAnchorSchema = PersistentObjectEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ObjectKind.PROJECT_MAPPING_ANCHOR),
    global_object_id: NonEmptyStringSchema,
    project_id: NonEmptyStringSchema,
    mapping_state: ProjectMappingStateSchema,
    workspace_id: NonEmptyStringSchema,
    accepted_by: AcceptedBySchema.nullable(),
    last_transition_at: IsoDatetimeStringSchema
  })
  .readonly();

export function getConfirmationPolicy(dimension: MemoryDimension): ConfirmationPolicy {
  switch (dimension) {
    case MemoryDimensionValue.PREFERENCE:
    case MemoryDimensionValue.GLOSSARY:
      return ConfirmationPolicy.BATCH_RECOMMEND;
    case MemoryDimensionValue.HAZARD:
      return ConfirmationPolicy.STRICT;
    default:
      return ConfirmationPolicy.PER_ITEM;
  }
}

export type ProjectMappingState = z.infer<typeof ProjectMappingStateSchema>;
export type AcceptedBy = z.infer<typeof AcceptedBySchema>;
export type ConfirmationPolicy = z.infer<typeof ConfirmationPolicySchema>;
export type ProjectMappingTransitionAction = z.infer<typeof ProjectMappingTransitionActionSchema>;
export type ProjectMappingAnchor = z.infer<typeof ProjectMappingAnchorSchema>;
