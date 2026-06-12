import {
  PublicMemoryEntryMutableFieldsSchema,
  SynthesisCapsuleSchema,
  type MemoryEntryMutableFields,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { parseUpdateFields } from "../memory-entry/row-mapper.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString } from "../shared/validators.js";
import type {
  AcceptedMemoryUpdateInput,
  AcceptedPathRelationGovernanceInput,
  AcceptedSynthesisCreateInput
} from "./types.js";
import { SYNTHESIS_CREATE_DOSSIER_REFS } from "./types.js";
import type { ProposalRow } from "./rows.js";
import {
  parseProposedChanges,
  parseUpdatedAt,
  parseWorkspaceId
} from "./mappers.js";

export function parseAcceptedMemoryUpdateInput(
  input: AcceptedMemoryUpdateInput
): Readonly<{
  readonly target_object_id: string;
  readonly workspace_id: string;
  readonly proposed_changes: MemoryEntryMutableFields & { readonly updated_at: string };
  readonly caused_by: string;
  readonly expected_baseline_updated_at: string | null;
}> {
  const parsedChanges = parseUpdateFields({
    ...PublicMemoryEntryMutableFieldsSchema.parse(input.proposed_changes),
    updated_at: parseUpdatedAt(input.updated_at)
  });

  const expectedBaselineUpdatedAt =
    input.expected_baseline_updated_at === null ||
    input.expected_baseline_updated_at === undefined
      ? null
      : parseUpdatedAt(input.expected_baseline_updated_at);

  return deepFreeze({
    target_object_id: parseNonEmptyString(input.target_object_id, "target_object_id"),
    workspace_id: parseWorkspaceId(input.workspace_id),
    proposed_changes: parsedChanges,
    caused_by: parseNonEmptyString(input.caused_by, "caused_by"),
    expected_baseline_updated_at: expectedBaselineUpdatedAt
  });
}

export function parseAcceptedPathRelationGovernanceInput(
  input: AcceptedPathRelationGovernanceInput
): Readonly<{
  readonly target_object_id: string;
  readonly workspace_id: string;
  readonly path_id_on_create: string;
  readonly updated_at: string;
  readonly caused_by: string;
}> {
  return deepFreeze({
    target_object_id: parseNonEmptyString(input.target_object_id, "target_object_id"),
    workspace_id: parseWorkspaceId(input.workspace_id),
    path_id_on_create: parseNonEmptyString(input.path_id_on_create, "path_id_on_create"),
    updated_at: parseUpdatedAt(input.updated_at),
    caused_by: parseNonEmptyString(input.caused_by, "caused_by")
  });
}

export function assertAcceptedMemoryUpdateMatchesProposal(
  row: ProposalRow,
  update: ReturnType<typeof parseAcceptedMemoryUpdateInput>
): void {
  if (
    row.workspace_id !== update.workspace_id ||
    row.target_object_kind !== "memory_entry" ||
    row.derived_from !== update.target_object_id ||
    row.target_baseline_updated_at !== update.expected_baseline_updated_at
  ) {
    throw createAcceptedMemoryUpdateMismatch(row.proposal_id);
  }

  const storedChanges = parseProposedChanges(row.proposed_changes);
  if (
    storedChanges === null ||
    !proposedChangesMatch(storedChanges, update.proposed_changes)
  ) {
    throw createAcceptedMemoryUpdateMismatch(row.proposal_id);
  }
}

export function assertAcceptedPathRelationGovernanceMatchesProposal(
  row: ProposalRow,
  update: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>
): void {
  if (
    row.workspace_id !== update.workspace_id ||
    row.target_object_kind !== "path_relation" ||
    row.derived_from !== update.target_object_id
  ) {
    throw createAcceptedPathRelationGovernanceMismatch(row.proposal_id);
  }
}

export function createAcceptedMemoryUpdateMismatch(proposalId: string): StorageError {
  return new StorageError(
    "CONFLICT",
    `Accepted memory update does not match proposal ${proposalId}.`
  );
}

export function createAcceptedPathRelationGovernanceMismatch(proposalId: string): StorageError {
  return new StorageError(
    "CONFLICT",
    `Accepted path relation governance update does not match proposal ${proposalId}.`
  );
}

export function parseAcceptedSynthesisCreateInput(
  input: AcceptedSynthesisCreateInput
): Readonly<{
  readonly workspace_id: string;
  readonly capsule: Readonly<SynthesisCapsule>;
  readonly caused_by: string;
}> {
  let capsule: Readonly<SynthesisCapsule>;
  try {
    capsule = SynthesisCapsuleSchema.parse(input.capsule);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate synthesis capsule.", error);
  }
  const workspaceId = parseWorkspaceId(input.workspace_id);
  if (capsule.workspace_id !== workspaceId) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Synthesis capsule workspace ${capsule.workspace_id} does not match accept scope ${workspaceId}.`
    );
  }
  return deepFreeze({
    workspace_id: workspaceId,
    capsule,
    caused_by: parseNonEmptyString(input.caused_by, "caused_by")
  });
}

export function assertAcceptedSynthesisCreateMatchesProposal(
  row: ProposalRow,
  create: ReturnType<typeof parseAcceptedSynthesisCreateInput>
): void {
  if (
    row.workspace_id !== create.workspace_id ||
    row.dossier_ref === null ||
    !SYNTHESIS_CREATE_DOSSIER_REFS.has(row.dossier_ref)
  ) {
    throw createAcceptedSynthesisCreateMismatch(row.proposal_id);
  }
}

export function createAcceptedSynthesisCreateMismatch(proposalId: string): StorageError {
  return new StorageError(
    "CONFLICT",
    `Accepted synthesis create does not match proposal ${proposalId}.`
  );
}

export function proposedChangesMatch(
  stored: Readonly<MemoryEntryMutableFields>,
  supplied: Readonly<MemoryEntryMutableFields>
): boolean {
  return (
    stored.content === supplied.content &&
    stringArraysMatch(stored.domain_tags, supplied.domain_tags) &&
    stringArraysMatch(stored.evidence_refs, supplied.evidence_refs) &&
    stored.storage_tier === supplied.storage_tier &&
    stored.confidence === supplied.confidence &&
    stored.retention_state === supplied.retention_state
  );
}

function stringArraysMatch(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function shouldRevokeGreenForEvidenceRewrite(
  previousEvidenceRefs: readonly string[],
  nextEvidenceRefs: readonly string[]
): boolean {
  if (previousEvidenceRefs.length === 0) {
    return false;
  }
  const next = new Set(nextEvidenceRefs);
  return !previousEvidenceRefs.some((ref) => next.has(ref));
}

export function toUpdatedFieldNames(fields: MemoryEntryMutableFields): string[] {
  const updatedFields: string[] = [];

  if (fields.content !== undefined) {
    updatedFields.push("content");
  }
  if (fields.domain_tags !== undefined) {
    updatedFields.push("domain_tags");
  }
  if (fields.evidence_refs !== undefined) {
    updatedFields.push("evidence_refs");
  }
  if (fields.storage_tier !== undefined) {
    updatedFields.push("storage_tier");
  }
  if (fields.confidence !== undefined) {
    updatedFields.push("confidence");
  }
  if (fields.retention_state !== undefined) {
    updatedFields.push("retention_state");
  }

  return updatedFields;
}
