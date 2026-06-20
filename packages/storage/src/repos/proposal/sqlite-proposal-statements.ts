import type { StorageDatabase } from "../../sqlite/db.js";
import {
  prepareProposalCreateStatements,
  prepareProposalMemoryApplyStatements,
  prepareProposalPathRelationApplyStatements,
  prepareProposalReadStatements,
  prepareProposalResolutionStatements,
  prepareProposalReviewerStatements,
  prepareProposalSynthesisApplyStatements,
  type ProposalCreateStatements,
  type ProposalMemoryApplyStatements,
  type ProposalPathRelationApplyStatements,
  type ProposalReadStatements,
  type ProposalResolutionStatements,
  type ProposalReviewerStatements,
  type ProposalSynthesisApplyStatements
} from "./proposal-statement-groups.js";

export type { SqliteStatement } from "./proposal-statement-groups.js";

export interface ProposalStatements
  extends ProposalCreateStatements,
    ProposalReadStatements,
    ProposalReviewerStatements,
    ProposalResolutionStatements,
    ProposalMemoryApplyStatements,
    ProposalPathRelationApplyStatements,
    ProposalSynthesisApplyStatements {}

export function prepareProposalStatements(db: StorageDatabase): ProposalStatements {
  return {
    ...prepareProposalCreateStatements(db),
    ...prepareProposalReadStatements(db),
    ...prepareProposalReviewerStatements(db),
    ...prepareProposalResolutionStatements(db),
    ...prepareProposalMemoryApplyStatements(db),
    ...prepareProposalPathRelationApplyStatements(db),
    ...prepareProposalSynthesisApplyStatements(db)
  };
}
