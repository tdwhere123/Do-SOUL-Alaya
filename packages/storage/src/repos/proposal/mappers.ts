import {
  ProposalResolutionStateSchema,
  ProposalSchema,
  PublicMemoryEntryMutableFieldsSchema,
  type MemoryEntryMutableFields,
  type Proposal,
  type ProposalResolutionState
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "../shared/validators.js";
import type { ProposalReviewerAssignment, ProposalReviewerAssignmentInput } from "./types.js";
import type { ProposalReviewerAssignmentRow, ProposalRow } from "./rows.js";

export function parseProposal(value: Proposal): Readonly<Proposal> {
  try {
    return deepFreeze(ProposalSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal.", error);
  }
}

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
