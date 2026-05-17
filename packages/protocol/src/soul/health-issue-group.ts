import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";

// invariant: HealthIssueGroup is a control-plane projection, not memory
// ontology. It aggregates raw OrphanRadar / GreenStatus revoke /
// evidence_failure entries by (target_object_id, cause_kind) so the
// Inspector inbox can fatigue-dedupe and dispatch typed actions without
// polluting MemoryEntry / EvidenceCapsule. See `decisions.md` §D1.

const healthIssueCauseKindValues = [
  "orphan_radar",
  "green_revoked",
  "evidence_failure"
] as const;

const healthIssueResolutionStateValues = [
  "pending",
  "resolved",
  "suppressed"
] as const;

const healthIssueSeverityValues = ["info", "warn", "blocking"] as const;

const healthIssueSuggestedActionValues = [
  "relink",
  "retire_memory",
  "request_evidence",
  "mark_questionable_ok",
  "suppress",
  "defer",
  "promote",
  "review_proposal"
] as const;

export const HealthIssueCauseKind = {
  ORPHAN_RADAR: "orphan_radar",
  GREEN_REVOKED: "green_revoked",
  EVIDENCE_FAILURE: "evidence_failure"
} as const;

export const HealthIssueResolutionState = {
  PENDING: "pending",
  RESOLVED: "resolved",
  SUPPRESSED: "suppressed"
} as const;

export const HealthIssueSeverity = {
  INFO: "info",
  WARN: "warn",
  BLOCKING: "blocking"
} as const;

export const HealthIssueSuggestedAction = {
  RELINK: "relink",
  RETIRE_MEMORY: "retire_memory",
  REQUEST_EVIDENCE: "request_evidence",
  MARK_QUESTIONABLE_OK: "mark_questionable_ok",
  SUPPRESS: "suppress",
  DEFER: "defer",
  PROMOTE: "promote",
  REVIEW_PROPOSAL: "review_proposal"
} as const;

export const HealthIssueCauseKindSchema = z.enum(healthIssueCauseKindValues);
export const HealthIssueResolutionStateSchema = z.enum(healthIssueResolutionStateValues);
export const HealthIssueSeveritySchema = z.enum(healthIssueSeverityValues);
export const HealthIssueSuggestedActionSchema = z.enum(healthIssueSuggestedActionValues);

export const HealthIssueGroupSchema = z
  .object({
    group_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    target_object_id: NonEmptyStringSchema,
    target_object_kind: NonEmptyStringSchema,
    cause_kind: HealthIssueCauseKindSchema,
    severity: HealthIssueSeveritySchema,
    confidence: z.number().min(0).max(1),
    first_seen_at: IsoDatetimeStringSchema,
    last_seen_at: IsoDatetimeStringSchema,
    count: NonNegativeIntSchema,
    suggested_actions: z.array(HealthIssueSuggestedActionSchema).readonly(),
    resolution_state: HealthIssueResolutionStateSchema,
    resolved_at: IsoDatetimeStringSchema.nullable(),
    resolved_by: NonEmptyStringSchema.nullable()
  })
  .strict()
  .readonly();

export type HealthIssueCauseKindValue = z.infer<typeof HealthIssueCauseKindSchema>;
export type HealthIssueResolutionStateValue = z.infer<typeof HealthIssueResolutionStateSchema>;
export type HealthIssueSeverityValue = z.infer<typeof HealthIssueSeveritySchema>;
export type HealthIssueSuggestedActionValue = z.infer<typeof HealthIssueSuggestedActionSchema>;
export type HealthIssueGroup = z.infer<typeof HealthIssueGroupSchema>;
