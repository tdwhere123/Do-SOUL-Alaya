import {
  ProposalResolutionStateSchema,
  MemoryProposalOperationSchema,
  ProposalSchema,
  PublicMemoryEntryMutableFieldsSchema,
  type MemoryEntryMutableFields,
  type MemoryProposalOperation,
  type Proposal,
  type ProposalResolutionState
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import { deepFreeze } from "@do-soul/alaya-protocol";
import {
  readNonEmptyStringField,
  readNullableStringField,
  readRecord,
  readStringField,
  readSqliteBooleanIntField,
  type RowParser
} from "../../shared/parse-row.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "../../shared/validators.js";
import type { ProposalReviewerAssignment, ProposalReviewerAssignmentInput } from "../types.js";
import type { PendingProposalSummaryRow, ProposalReviewerAssignmentRow, ProposalRow } from "./rows.js";

export function parseProposal(value: Proposal): Readonly<Proposal> {
  try {
    return deepFreeze(ProposalSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal.", error);
  }
}

function readProposalRow(value: unknown): ProposalRow {
  const record = readRecord(value, "proposal row");
  return {
    runtime_id: readNonEmptyStringField(record, "runtime_id"),
    object_kind: readNonEmptyStringField(record, "object_kind"),
    proposal_id: readNonEmptyStringField(record, "proposal_id"),
    task_surface_ref: readNullableStringField(record, "task_surface_ref"),
    derived_from: readNullableStringField(record, "derived_from"),
    retention_policy: readNonEmptyStringField(record, "retention_policy"),
    dossier_ref: readNullableStringField(record, "dossier_ref"),
    recommended_option_id: readNullableStringField(record, "recommended_option_id"),
    proposal_options: readNonEmptyStringField(record, "proposal_options"),
    resolution_state: readNonEmptyStringField(record, "resolution_state"),
    expires_at: readNullableStringField(record, "expires_at"),
    last_updated_at: readNonEmptyStringField(record, "last_updated_at"),
    workspace_id: readNonEmptyStringField(record, "workspace_id"),
    run_id: readNullableStringField(record, "run_id"),
    reviewer_identity: readNullableStringField(record, "reviewer_identity"),
    proposal_operation: readNullableStringField(record, "proposal_operation"),
    target_object_kind: readNonEmptyStringField(record, "target_object_kind"),
    proposed_change_summary: readStringField(record, "proposed_change_summary"),
    proposed_changes: readNullableStringField(record, "proposed_changes"),
    proposed_path_relation: readNullableStringField(record, "proposed_path_relation"),
    created_at: readNullableStringField(record, "created_at"),
    target_baseline_updated_at: readNullableStringField(record, "target_baseline_updated_at"),
    source_delivery_ids: readNullableStringField(record, "source_delivery_ids")
  };
}

export const ProposalRowParser: RowParser<Readonly<Proposal>> = {
  parse(value: unknown): Readonly<Proposal> {
    return parseProposalRow(readProposalRow(value));
  }
};

function readPendingProposalSummaryRow(value: unknown): PendingProposalSummaryRow {
  const record = readRecord(value, "pending proposal summary row");
  return {
    ...readProposalRow(record),
    assigned_reviewer_identity: readNullableStringField(record, "assigned_reviewer_identity"),
    assigned_at: readNullableStringField(record, "assigned_at"),
    deadline_at: readNullableStringField(record, "deadline_at"),
    is_overdue: readSqliteBooleanIntField(record, "is_overdue") as 0 | 1
  };
}

export const PendingProposalSummaryRowParser: RowParser<PendingProposalSummaryRow> = {
  parse: readPendingProposalSummaryRow
};

export function parseProposalRow(row: ProposalRow): Readonly<Proposal> {
  let proposalOptions: unknown;

  try {
    proposalOptions = JSON.parse(row.proposal_options);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal options JSON.", error);
  }

  try {
    return deepFreeze(
      ProposalSchema.parse({
        runtime_id: row.runtime_id,
        object_kind: row.object_kind,
        proposal_id: row.proposal_id,
        task_surface_ref: row.task_surface_ref,
        derived_from: row.derived_from,
        retention_policy: row.retention_policy,
        dossier_ref: row.dossier_ref,
        recommended_option_id: row.recommended_option_id,
        proposal_options: proposalOptions,
        resolution_state: row.resolution_state,
        expires_at: row.expires_at,
        last_updated_at: row.last_updated_at
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal row.", error);
  }
}

export function serializeProposedChanges(
  value: MemoryEntryMutableFields | null
): string | null {
  if (value === null) {
    return null;
  }

  try {
    return JSON.stringify(PublicMemoryEntryMutableFieldsSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal proposed_changes.", error);
  }
}

export function parseProposedChanges(value: string | null): Readonly<MemoryEntryMutableFields> | null {
  if (value === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal proposed_changes JSON.", error);
  }

  try {
    return deepFreeze(PublicMemoryEntryMutableFieldsSchema.parse(parsedJson));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal proposed_changes row.", error);
  }
}

export function serializeSourceDeliveryIds(value: readonly string[] | null): string | null {
  if (value === null) {
    return null;
  }

  const parsed = parseSourceDeliveryIdsArray(value);
  return JSON.stringify(parsed);
}

export function parseSourceDeliveryIds(value: string | null): readonly string[] | null {
  if (value === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal source_delivery_ids JSON.", error);
  }

  return parseSourceDeliveryIdsArray(parsedJson);
}

export function parseSourceDeliveryIdsArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new StorageError("VALIDATION_FAILED", "Proposal source_delivery_ids must be a non-empty array.");
  }
  return deepFreeze(
    value.map((item, index) => parseNonEmptyString(item, `source_delivery_ids[${index}]`))
  );
}

export function parseProposalReviewerAssignment(
  input: ProposalReviewerAssignmentInput
): Readonly<ProposalReviewerAssignment> {
  return deepFreeze({
    proposal_id: parseProposalId(input.proposal_id),
    reviewer_identity: parseNonEmptyString(input.reviewer_identity, "reviewer_identity"),
    assigned_at: parseTimestamp(input.assigned_at),
    deadline_at: parseNullableTimestamp(input.deadline_at ?? null),
    escalation_after_ms: parseNullableNonNegativeInteger(
      input.escalation_after_ms ?? null,
      "escalation_after_ms"
    )
  });
}

export function parseProposalReviewerAssignmentRow(
  row: ProposalReviewerAssignmentRow
): Readonly<ProposalReviewerAssignment> {
  return deepFreeze({
    proposal_id: parseProposalId(row.proposal_id),
    reviewer_identity: parseNonEmptyString(row.reviewer_identity, "reviewer_identity"),
    assigned_at: parseTimestamp(row.assigned_at),
    deadline_at: parseNullableTimestamp(row.deadline_at),
    escalation_after_ms: parseNullableNonNegativeInteger(
      row.escalation_after_ms,
      "escalation_after_ms"
    )
  });
}

export function parseProposalResolutionState(state: ProposalResolutionState): ProposalResolutionState {
  try {
    return ProposalResolutionStateSchema.parse(state);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal resolution state.", error);
  }
}

export function parseProposalId(value: string): string {
  return parseNonEmptyString(value, "proposal_id");
}

export function parseMemoryProposalOperation(
  value: MemoryProposalOperation | string | null
): MemoryProposalOperation | null {
  if (value === null) return null;
  try {
    return MemoryProposalOperationSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal operation.", error);
  }
}

export function parseWorkspaceId(value: string): string {
  return parseNonEmptyString(value, "workspace_id");
}

export function parseRunId(value: string | null): string | null {
  return parseNullableString(value, "run_id");
}

export function parseNullableTimestamp(value: string | null): string | null {
  return value === null ? null : parseTimestamp(value);
}

export function parseNullableNonNegativeInteger(value: number | null, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

export const parseUpdatedAt = parseTimestamp;
