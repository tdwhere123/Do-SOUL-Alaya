import type { EventLogEntry, Proposal } from "@do-soul/alaya-protocol";
import { StorageError } from "../../../shared/errors.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { insertEventLogEntry } from "../../shared/event-log-writer.js";
import { parseNonEmptyString } from "../../shared/validators.js";
import {
  parseProposalId,
  parseProposalRow,
  parseUpdatedAt
} from "../mappers.js";
import type { ProposalConnectionHost } from "../proposal-connection-host.js";
import type { ProposalRow } from "../rows.js";
import type {
  ProposalResolutionEventInput,
  TransactionBoundProposalMutation,
  UpdatePendingResolutionOptions
} from "../types.js";

type PrivacyAcceptContext = Readonly<{
  readonly transactionScope: object;
  readonly connectionHost: ProposalConnectionHost;
  readonly createPendingResolutionFailure: (proposalId: string) => StorageError;
}>;

export async function acceptPendingPrivacyEraseWithEvents(
  ctx: PrivacyAcceptContext,
  proposalId: string,
  updatedAt: string,
  events: readonly ProposalResolutionEventInput[],
  mutation: TransactionBoundProposalMutation,
  options: UpdatePendingResolutionOptions
): Promise<Readonly<{ readonly proposal: Readonly<Proposal>; readonly events: readonly EventLogEntry[] }>> {
  const parsedId = parseProposalId(proposalId);
  requireMatchingTransactionScope(ctx, mutation);
  try {
    return runPrivacyEraseAcceptTransaction(
      ctx,
      parsedId,
      parseUpdatedAt(updatedAt),
      events,
      mutation,
      parseReviewerIdentity(options)
    );
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "QUERY_FAILED",
      `Failed to accept privacy erase proposal ${parsedId}.`,
      error
    );
  }
}

function runPrivacyEraseAcceptTransaction(
  ctx: PrivacyAcceptContext,
  proposalId: string,
  updatedAt: string,
  events: readonly ProposalResolutionEventInput[],
  mutation: TransactionBoundProposalMutation,
  reviewerIdentity: string | undefined
): Readonly<{ readonly proposal: Readonly<Proposal>; readonly events: readonly EventLogEntry[] }> {
  return ctx.connectionHost.transaction(() => {
    assertPendingPrivacyErase(ctx, proposalId);
    const storedEvents = events.map((event) =>
      insertEventLogEntry(ctx.connectionHost.eventLogWriter, event)
    );
    resolveAccepted(ctx, proposalId, updatedAt, reviewerIdentity);
    const mutationEvents = mutation.apply(storedEvents).map((event) =>
      insertEventLogEntry(ctx.connectionHost.eventLogWriter, event)
    );
    return deepFreeze({
      proposal: loadProposal(ctx, proposalId),
      events: [...storedEvents, ...mutationEvents]
    });
  });
}

function requireMatchingTransactionScope(
  ctx: PrivacyAcceptContext,
  mutation: TransactionBoundProposalMutation
): void {
  if (mutation.transactionScope !== ctx.transactionScope) {
    throw new StorageError(
      "VALIDATION_FAILED",
      "Privacy erase mutation must use the proposal repository transaction scope."
    );
  }
}

function assertPendingPrivacyErase(ctx: PrivacyAcceptContext, proposalId: string): void {
  const row = ctx.connectionHost.findByIdStatement.get(proposalId) as ProposalRow | undefined;
  if (row === undefined) throw new StorageError("NOT_FOUND", `Proposal ${proposalId} was not found.`);
  if (row.resolution_state !== "pending") throw ctx.createPendingResolutionFailure(proposalId);
  if (row.proposal_operation !== "privacy_erase") {
    throw new StorageError("VALIDATION_FAILED", "Proposal is not a privacy erase operation.");
  }
}

function resolveAccepted(
  ctx: PrivacyAcceptContext,
  proposalId: string,
  updatedAt: string,
  reviewerIdentity: string | undefined
): void {
  const result = reviewerIdentity === undefined
    ? ctx.connectionHost.updatePendingResolutionStatement.run("accepted", updatedAt, proposalId)
    : ctx.connectionHost.updatePendingResolutionWithIdentityStatement.run(
        "accepted", updatedAt, reviewerIdentity, proposalId
      );
  if (result.changes === 0) throw ctx.createPendingResolutionFailure(proposalId);
}

function loadProposal(ctx: PrivacyAcceptContext, proposalId: string): Readonly<Proposal> {
  const row = ctx.connectionHost.findByIdStatement.get(proposalId) as ProposalRow | undefined;
  if (row === undefined) {
    throw new StorageError("NOT_FOUND", `Proposal ${proposalId} was not found after update.`);
  }
  return parseProposalRow(row);
}

function parseReviewerIdentity(options: UpdatePendingResolutionOptions): string | undefined {
  return options.reviewerIdentity === undefined
    ? undefined
    : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");
}
