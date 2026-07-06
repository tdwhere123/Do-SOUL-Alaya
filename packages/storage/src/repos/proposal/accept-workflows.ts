import {
  MemoryGovernanceEventType,
  SoulSynthesisCreatedPayloadSchema,
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type Proposal,
  type ProposalResolutionState,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { insertEventLogEntry } from "../shared/event-log-writer.js";
import { parseNonEmptyString } from "../shared/validators.js";
import {
  assertAcceptedMemoryUpdateMatchesProposal,
  assertAcceptedPathRelationGovernanceMatchesProposal,
  assertAcceptedSynthesisCreateMatchesProposal,
  parseAcceptedMemoryUpdateInput,
  parseAcceptedPathRelationGovernanceInput,
  parseAcceptedSynthesisCreateInput
} from "./acceptance.js";
import {
  applyAcceptedMemoryUpdate,
  assertBaselineFresh,
  assertMemoryExistsInWorkspace,
  loadMemoryForAcceptedUpdate
} from "./accept-workflow-memory.js";
import { parseProposalId, parseProposalRow, parseUpdatedAt } from "./mappers.js";
import type {
  AcceptedMemoryUpdateInput,
  AcceptedPathRelationGovernanceInput,
  AcceptedSynthesisCreateInput,
  ProposalResolutionEventInput,
  UpdatePendingResolutionOptions
} from "./types.js";
import type { ProposalRow } from "./rows.js";
import { upsertStrictlyGovernedPathRelation } from "./path-relation-accept-workflow.js";
import type { MemoryEntryEvidenceRefIndexHost } from "../memory-entry/evidence-ref-index.js";

interface SqliteStatement {
  run(...args: readonly unknown[]): { readonly changes: number };
  get(...args: readonly unknown[]): unknown;
  all(...args: readonly unknown[]): readonly unknown[];
}

export interface SqliteProposalWorkflowContext extends MemoryEntryEvidenceRefIndexHost {
  readonly db: StorageDatabase;
  transaction<T>(fn: () => T, options?: { readonly immediate?: boolean }): T;
  readonly eventLogWriter: Parameters<typeof insertEventLogEntry>[0];
  readonly findByIdStatement: SqliteStatement;
  readonly findMemoryEntryByIdStatement: SqliteStatement;
  readonly updateMemoryEntryStatement: SqliteStatement;
  readonly findRevokableGreenStatusStatement: SqliteStatement;
  readonly revokeGreenStatusStatement: SqliteStatement;
  readonly updatePendingResolutionStatement: SqliteStatement;
  readonly updatePendingResolutionWithIdentityStatement: SqliteStatement;
  readonly findPathRelationByAnchorMemoryIdStatement: SqliteStatement;
  readonly createPathRelationStatement: SqliteStatement;
  readonly updatePathRelationLegitimacyStatement: SqliteStatement;
  readonly createSynthesisCapsuleStatement: SqliteStatement;
  readonly createPendingResolutionFailure: (proposalId: string) => StorageError;
}

interface ParsedAcceptRequest {
  readonly proposalId: string;
  readonly updatedAt: string;
  readonly reviewerIdentity: string | undefined;
  readonly applySynchronousResolutionMutation?: () => readonly ProposalResolutionEventInput[];
}

export async function acceptPendingMemoryUpdateWithEvents(
  ctx: SqliteProposalWorkflowContext,
  proposalId: string,
  updatedAt: string,
  events: readonly ProposalResolutionEventInput[],
  memoryUpdate: AcceptedMemoryUpdateInput,
  options: UpdatePendingResolutionOptions = {}
): Promise<Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly memory: Readonly<MemoryEntry>;
  readonly events: readonly EventLogEntry[];
}>> {
  const request = parseAcceptRequest(proposalId, updatedAt, options);
  const parsedMemoryUpdate = parseAcceptedMemoryUpdateInput(memoryUpdate);

  try {
    return ctx.transaction(() =>
      acceptMemoryUpdateTransaction(ctx, request, events, parsedMemoryUpdate)
    );
  } catch (error) {
    throw wrapWorkflowError(
      error,
      `Failed to accept proposal ${request.proposalId} with durable memory update.`
    );
  }
}

export async function acceptPendingPathRelationGovernanceWithEvents(
  ctx: SqliteProposalWorkflowContext,
  proposalId: string,
  updatedAt: string,
  events: readonly ProposalResolutionEventInput[],
  pathRelationGovernance: AcceptedPathRelationGovernanceInput,
  options: UpdatePendingResolutionOptions = {}
): Promise<Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly path_relation: Readonly<PathRelation>;
  readonly events: readonly EventLogEntry[];
}>> {
  const request = parseAcceptRequest(proposalId, updatedAt, options);
  const parsedPathRelationGovernance = parseAcceptedPathRelationGovernanceInput(
    pathRelationGovernance
  );

  try {
    return ctx.transaction(() =>
      acceptPathRelationGovernanceTransaction(
        ctx,
        request,
        events,
        parsedPathRelationGovernance
      )
    );
  } catch (error) {
    throw wrapWorkflowError(
      error,
      `Failed to accept proposal ${request.proposalId} with durable path relation governance update.`
    );
  }
}

export async function acceptPendingSynthesisCreateWithEvents(
  ctx: SqliteProposalWorkflowContext,
  proposalId: string,
  updatedAt: string,
  events: readonly ProposalResolutionEventInput[],
  synthesisCreate: AcceptedSynthesisCreateInput,
  options: UpdatePendingResolutionOptions = {}
): Promise<Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly synthesis: Readonly<SynthesisCapsule>;
  readonly events: readonly EventLogEntry[];
}>> {
  const request = parseAcceptRequest(proposalId, updatedAt, options);
  const parsedSynthesisCreate = parseAcceptedSynthesisCreateInput(synthesisCreate);

  try {
    return ctx.transaction(() =>
      acceptSynthesisCreateTransaction(ctx, request, events, parsedSynthesisCreate)
    );
  } catch (error) {
    throw wrapWorkflowError(
      error,
      `Failed to accept proposal ${request.proposalId} with durable synthesis create.`
    );
  }
}

function acceptMemoryUpdateTransaction(
  ctx: SqliteProposalWorkflowContext,
  request: ParsedAcceptRequest,
  events: readonly ProposalResolutionEventInput[],
  memoryUpdate: ReturnType<typeof parseAcceptedMemoryUpdateInput>
): Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly memory: Readonly<MemoryEntry>;
  readonly events: readonly EventLogEntry[];
}> {
  const proposalRow = loadPendingProposal(ctx, request.proposalId);
  assertAcceptedMemoryUpdateMatchesProposal(proposalRow, memoryUpdate);
  const existingMemory = loadMemoryForAcceptedUpdate(ctx, memoryUpdate);
  assertBaselineFresh(existingMemory, memoryUpdate);

  const storedReviewEvents = insertReviewEvents(ctx, events);
  resolvePendingProposal(ctx, request);
  const memoryResult = applyAcceptedMemoryUpdate(
    ctx,
    request.updatedAt,
    existingMemory,
    memoryUpdate
  );
  const mutationEvents = insertTransactionMutationEvents(ctx, request);

  return deepFreeze({
    proposal: loadUpdatedProposal(ctx, request.proposalId),
    memory: memoryResult.memory,
    events: [...storedReviewEvents, ...memoryResult.events, ...mutationEvents]
  });
}

function acceptPathRelationGovernanceTransaction(
  ctx: SqliteProposalWorkflowContext,
  request: ParsedAcceptRequest,
  events: readonly ProposalResolutionEventInput[],
  pathRelationGovernance: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>
): Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly path_relation: Readonly<PathRelation>;
  readonly events: readonly EventLogEntry[];
}> {
  const proposalRow = loadPendingProposal(ctx, request.proposalId);
  assertAcceptedPathRelationGovernanceMatchesProposal(proposalRow, pathRelationGovernance);
  assertMemoryExistsInWorkspace(ctx, pathRelationGovernance.target_object_id, pathRelationGovernance.workspace_id);

  const storedReviewEvents = insertReviewEvents(ctx, events);
  resolvePendingProposal(ctx, request);
  const pathApply = upsertStrictlyGovernedPathRelation(ctx, pathRelationGovernance, proposalRow);
  const mutationEvents = insertTransactionMutationEvents(ctx, request);

  return deepFreeze({
    proposal: loadUpdatedProposal(ctx, request.proposalId),
    path_relation: pathApply.pathRelation,
    events:
      pathApply.event === null
        ? [...storedReviewEvents, ...mutationEvents]
        : [...storedReviewEvents, pathApply.event, ...mutationEvents]
  });
}

function acceptSynthesisCreateTransaction(
  ctx: SqliteProposalWorkflowContext,
  request: ParsedAcceptRequest,
  events: readonly ProposalResolutionEventInput[],
  synthesisCreate: ReturnType<typeof parseAcceptedSynthesisCreateInput>
): Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly synthesis: Readonly<SynthesisCapsule>;
  readonly events: readonly EventLogEntry[];
}> {
  const proposalRow = loadPendingProposal(ctx, request.proposalId);
  assertAcceptedSynthesisCreateMatchesProposal(proposalRow, synthesisCreate);

  const storedReviewEvents = insertReviewEvents(ctx, events);
  resolvePendingProposal(ctx, request);
  const synthesisEvent = insertSynthesisCreatedEvent(ctx, synthesisCreate.capsule);
  insertSynthesisCapsule(ctx, synthesisCreate.capsule);
  const mutationEvents = insertTransactionMutationEvents(ctx, request);

  return deepFreeze({
    proposal: loadUpdatedProposal(ctx, request.proposalId),
    synthesis: synthesisCreate.capsule,
    events: [...storedReviewEvents, synthesisEvent, ...mutationEvents]
  });
}

function parseAcceptRequest(
  proposalId: string,
  updatedAt: string,
  options: UpdatePendingResolutionOptions
): ParsedAcceptRequest {
  return {
    proposalId: parseProposalId(proposalId),
    updatedAt: parseUpdatedAt(updatedAt),
    reviewerIdentity:
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity"),
    ...(options.applySynchronousResolutionMutation === undefined
      ? {}
      : { applySynchronousResolutionMutation: options.applySynchronousResolutionMutation })
  };
}

function loadPendingProposal(
  ctx: SqliteProposalWorkflowContext,
  proposalId: string
): ProposalRow {
  const proposalRow = ctx.findByIdStatement.get(proposalId) as ProposalRow | undefined;
  if (proposalRow === undefined) {
    throw new StorageError("NOT_FOUND", `Proposal ${proposalId} was not found.`);
  }
  if (proposalRow.resolution_state !== "pending") {
    throw ctx.createPendingResolutionFailure(proposalId);
  }
  return proposalRow;
}

function resolvePendingProposal(
  ctx: SqliteProposalWorkflowContext,
  request: ParsedAcceptRequest
): void {
  const acceptedState = "accepted" satisfies ProposalResolutionState;
  const result =
    request.reviewerIdentity === undefined
      ? ctx.updatePendingResolutionStatement.run(
          acceptedState,
          request.updatedAt,
          request.proposalId
        )
      : ctx.updatePendingResolutionWithIdentityStatement.run(
          acceptedState,
          request.updatedAt,
          request.reviewerIdentity,
          request.proposalId
        );

  if (result.changes === 0) {
    throw ctx.createPendingResolutionFailure(request.proposalId);
  }
}

function insertReviewEvents(
  ctx: SqliteProposalWorkflowContext,
  events: readonly ProposalResolutionEventInput[]
): readonly EventLogEntry[] {
  return events.map((event) => insertEventLogEntry(ctx.eventLogWriter, event));
}

function insertTransactionMutationEvents(
  ctx: SqliteProposalWorkflowContext,
  request: ParsedAcceptRequest
): readonly EventLogEntry[] {
  const mutationEvents = request.applySynchronousResolutionMutation?.() ?? [];
  return mutationEvents.map((event) => insertEventLogEntry(ctx.eventLogWriter, event));
}

function insertSynthesisCreatedEvent(
  ctx: SqliteProposalWorkflowContext,
  capsule: SynthesisCapsule
): EventLogEntry {
  return insertEventLogEntry(ctx.eventLogWriter, {
    event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
    entity_type: "synthesis_capsule",
    entity_id: capsule.object_id,
    workspace_id: capsule.workspace_id,
    run_id: capsule.run_id,
    caused_by: capsule.created_by,
    payload_json: SoulSynthesisCreatedPayloadSchema.parse({
      object_id: capsule.object_id,
      object_kind: capsule.object_kind,
      workspace_id: capsule.workspace_id,
      run_id: capsule.run_id
    })
  });
}

function insertSynthesisCapsule(
  ctx: SqliteProposalWorkflowContext,
  capsule: SynthesisCapsule
): void {
  ctx.createSynthesisCapsuleStatement.run(
    capsule.object_id,
    capsule.object_kind,
    capsule.schema_version,
    capsule.lifecycle_state,
    capsule.created_at,
    capsule.updated_at,
    capsule.created_by,
    capsule.topic_key,
    capsule.synthesis_type,
    capsule.summary,
    JSON.stringify(capsule.evidence_refs),
    JSON.stringify(capsule.source_memory_refs),
    capsule.workspace_id,
    capsule.run_id,
    capsule.synthesis_status
  );
}

function loadUpdatedProposal(
  ctx: SqliteProposalWorkflowContext,
  proposalId: string
): Readonly<Proposal> {
  const updatedProposalRow = ctx.findByIdStatement.get(proposalId) as ProposalRow | undefined;
  if (updatedProposalRow === undefined) {
    throw new StorageError("NOT_FOUND", `Proposal ${proposalId} was not found after update.`);
  }
  return parseProposalRow(updatedProposalRow);
}

function wrapWorkflowError(error: unknown, message: string): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  return new StorageError("QUERY_FAILED", message, error);
}
