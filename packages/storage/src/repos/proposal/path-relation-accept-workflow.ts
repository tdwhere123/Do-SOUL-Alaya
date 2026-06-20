import {
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type EventLogEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { insertEventLogEntry } from "../shared/event-log-writer.js";
import type { SqliteProposalWorkflowContext } from "./accept-workflows.js";
import { parseAcceptedPathRelationGovernanceInput } from "./acceptance.js";
import {
  applyPathRelationProposal,
  createPathRelationFromProposalPayload,
  createStrictlyGovernedPathRelation,
  parseProposedPathRelation,
  parseProposalPathRelationRow,
  pathRelationMatchesProposalPayload
} from "./path-relations.js";
import type {
  ProposalPathRelationRow,
  ProposalRow
} from "./rows.js";

export function upsertStrictlyGovernedPathRelation(
  ctx: SqliteProposalWorkflowContext,
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  proposalRow: ProposalRow
): Readonly<{ readonly pathRelation: Readonly<PathRelation>; readonly event: EventLogEntry | null }> {
  const proposedPathRelation = parseProposedPathRelation(proposalRow.proposed_path_relation);
  const existingRows = ctx.findPathRelationByAnchorMemoryIdStatement.all(
    input.workspace_id,
    input.target_object_id,
    input.target_object_id,
    input.target_object_id,
    input.target_object_id
  ) as ProposalPathRelationRow[];
  const existingRow =
    proposedPathRelation === null
      ? existingRows[0]
      : existingRows.find((row) =>
          pathRelationMatchesProposalPayload(
            parseProposalPathRelationRow(row),
            input.target_object_id,
            proposedPathRelation
          )
        );

  if (existingRow !== undefined) {
    return updateExistingPathRelation(ctx, input, proposalRow, existingRow, proposedPathRelation);
  }

  return createGovernedPathRelation(ctx, input, proposalRow, proposedPathRelation);
}

function updateExistingPathRelation(
  ctx: SqliteProposalWorkflowContext,
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  proposalRow: ProposalRow,
  existingRow: ProposalPathRelationRow,
  proposedPathRelation: ReturnType<typeof parseProposedPathRelation>
): Readonly<{ readonly pathRelation: Readonly<PathRelation>; readonly event: EventLogEntry | null }> {
  const existing = parseProposalPathRelationRow(existingRow);
  const updated = applyPathRelationProposal(existing, input, proposedPathRelation);
  const result = ctx.updatePathRelationLegitimacyStatement.run(
    JSON.stringify(updated.legitimacy),
    updated.updated_at,
    updated.path_id
  );
  if (result.changes === 0) {
    throw new StorageError("NOT_FOUND", `Path relation ${updated.path_id} was not found.`);
  }
  const pathEvent = insertEventLogEntry(ctx.eventLogWriter, {
    event_type: RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
    entity_type: "path_relation",
    entity_id: updated.path_id,
    workspace_id: updated.workspace_id,
    run_id: proposalRow.run_id,
    caused_by: input.caused_by,
    payload_json: parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
      {
        path_id: updated.path_id,
        workspace_id: updated.workspace_id,
        previous_governance_class: existing.legitimacy.governance_class,
        new_governance_class: updated.legitimacy.governance_class,
        previous_evidence_basis: existing.legitimacy.evidence_basis,
        new_evidence_basis: updated.legitimacy.evidence_basis,
        updated_at: updated.updated_at
      }
    ) as unknown as Record<string, unknown>
  });
  return deepFreeze({ pathRelation: updated, event: pathEvent });
}

function createGovernedPathRelation(
  ctx: SqliteProposalWorkflowContext,
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  proposalRow: ProposalRow,
  proposedPathRelation: ReturnType<typeof parseProposedPathRelation>
): Readonly<{ readonly pathRelation: Readonly<PathRelation>; readonly event: EventLogEntry | null }> {
  const created =
    proposedPathRelation === null
      ? createStrictlyGovernedPathRelation(input)
      : createPathRelationFromProposalPayload(input, proposedPathRelation);
  const pathEvent = insertEventLogEntry(ctx.eventLogWriter, {
    event_type: RuntimeGovernanceEventType.PATH_RELATION_CREATED,
    entity_type: "path_relation",
    entity_id: created.path_id,
    workspace_id: created.workspace_id,
    run_id: proposalRow.run_id,
    caused_by: input.caused_by,
    payload_json: parseRuntimeGovernanceEventPayload(
      RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      {
        path_id: created.path_id,
        workspace_id: created.workspace_id,
        relation_kind: created.constitution.relation_kind,
        source_anchor_kind: created.anchors.source_anchor.kind,
        target_anchor_kind: created.anchors.target_anchor.kind,
        initial_strength: created.plasticity_state.strength,
        governance_class: created.legitimacy.governance_class,
        created_at: created.created_at
      }
    ) as unknown as Record<string, unknown>
  });
  ctx.createPathRelationStatement.run(
    created.path_id,
    created.workspace_id,
    JSON.stringify(created.anchors),
    JSON.stringify(created.constitution),
    JSON.stringify(created.effect_vector),
    JSON.stringify(created.plasticity_state),
    JSON.stringify(created.lifecycle),
    JSON.stringify(created.legitimacy),
    created.created_at,
    created.updated_at
  );
  return deepFreeze({ pathRelation: created, event: pathEvent });
}
