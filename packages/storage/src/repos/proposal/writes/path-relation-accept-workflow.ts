import {
  type EventLogEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import { deepFreeze } from "@do-soul/alaya-protocol";
import { insertEventLogEntry } from "../../runtime/writes/event-log-writer.js";
import { parseRows } from "../../shared/parse-row.js";
import type { SqliteProposalWorkflowContext } from "./accept-workflows.js";
import { parseAcceptedPathRelationGovernanceInput } from "../mappers/acceptance.js";
import {
  applyPathRelationProposal,
  createPathRelationFromProposalPayload,
  parseProposalPathRelationRow,
  pathRelationMatchesProposalPayload,
  ProposalPathRelationRowParser
} from "../path-relations.js";
import type {
  ProposalPathRelationRow,
  ProposalRow
} from "../mappers/rows.js";
import type { PathRelationProposalPayload } from "../types.js";

export function upsertProposedPathRelation(
  ctx: SqliteProposalWorkflowContext,
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  proposalRow: ProposalRow,
  proposedPathRelation: Readonly<PathRelationProposalPayload>
): Readonly<{ readonly pathRelation: Readonly<PathRelation>; readonly event: EventLogEntry }> {
  const existingRows = parseRows(ctx.findPathRelationByAnchorMemoryIdStatement.all(
      input.workspace_id,
      input.target_object_id,
      input.target_object_id,
      input.target_object_id,
      input.target_object_id
    ),
    ProposalPathRelationRowParser,
    "proposal path relation row"
  );
  const existingRow = existingRows.find((row) =>
    pathRelationMatchesProposalPayload(parseProposalPathRelationRow(row), input.target_object_id, proposedPathRelation)
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
  proposedPathRelation: Readonly<PathRelationProposalPayload>
): Readonly<{ readonly pathRelation: Readonly<PathRelation>; readonly event: EventLogEntry }> {
  const existing = parseProposalPathRelationRow(existingRow);
  const updated = applyPathRelationProposal(existing, input, proposedPathRelation);
  const pathEvent = insertEventLogEntry(ctx.eventLogWriter, input.buildEvent(updated, existing, proposalRow.run_id));
  const result = ctx.updatePathRelationLegitimacyStatement.run(
    JSON.stringify(updated.legitimacy),
    updated.updated_at,
    updated.path_id
  );
  if (result.changes === 0) {
    throw new StorageError("NOT_FOUND", `Path relation ${updated.path_id} was not found.`);
  }
  return deepFreeze({ pathRelation: updated, event: pathEvent });
}

function createGovernedPathRelation(
  ctx: SqliteProposalWorkflowContext,
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  proposalRow: ProposalRow,
  proposedPathRelation: Readonly<PathRelationProposalPayload>
): Readonly<{ readonly pathRelation: Readonly<PathRelation>; readonly event: EventLogEntry }> {
  const created = createPathRelationFromProposalPayload(input, proposedPathRelation);
  const pathEvent = insertEventLogEntry(ctx.eventLogWriter, input.buildEvent(created, null, proposalRow.run_id));
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
