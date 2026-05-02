import { randomUUID } from "node:crypto";
import {
  ControlPlaneObjectKind,
  NonEmptyStringSchema,
  Phase1BEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  SoulProposalCreatedPayloadSchema,
  SoulProposalResolvedPayloadSchema,
  SoulReviewCompletedPayloadSchema,
  SoulReviewCreatedPayloadSchema,
  TransitionCausedBy,
  type EventLogEntry,
  type Proposal,
  type SoulProposeMemoryUpdateRequest,
  type SoulReviewMemoryProposalRequest
} from "@do-soul/alaya-protocol";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandlerDependencies
} from "./mcp-memory-tool-handler.js";

export interface McpMemoryProposalWorkflowEventLogRepo {
  append(event: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  deleteById(eventId: string): Promise<void>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface McpMemoryProposalWorkflowProposalRepo {
  create(input: {
    readonly proposal: Proposal;
    readonly workspace_id: string;
    readonly run_id: string | null;
  }): Promise<Readonly<Proposal>>;
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findScopedById(proposalId: string): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly workspace_id: string;
    readonly run_id: string | null;
  }> | null>;
  updatePendingResolution(
    proposalId: string,
    state: Proposal["resolution_state"],
    updatedAt: string
  ): Promise<Readonly<Proposal>>;
}

export interface McpMemoryProposalWorkflowRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface McpMemoryProposalWorkflowDependencies {
  readonly eventLogRepo: McpMemoryProposalWorkflowEventLogRepo;
  readonly proposalRepo: McpMemoryProposalWorkflowProposalRepo;
  readonly runtimeNotifier: McpMemoryProposalWorkflowRuntimeNotifier;
  readonly now?: () => string;
  readonly generateObjectId?: () => string;
}

export function createMcpMemoryProposalWorkflow(
  deps: McpMemoryProposalWorkflowDependencies
): NonNullable<McpMemoryToolHandlerDependencies["proposalWorkflow"]> {
  const now = deps.now ?? (() => new Date().toISOString());
  const generateObjectId = deps.generateObjectId ?? randomUUID;
  const proposalReviewLocks = new Map<string, Promise<void>>();

  return {
    proposeMemoryUpdate: async (input, context) => await proposeMemoryUpdate(input, context),
    reviewMemoryProposal: async (input, context) =>
      await withProposalReviewLock(input.proposal_id, async () => await reviewMemoryProposal(input, context))
  };

  async function proposeMemoryUpdate(
    input: SoulProposeMemoryUpdateRequest,
    context: McpMemoryToolCallContext
  ): Promise<Readonly<{ proposal_id: string; status: "created" }>> {
    const timestamp = now();
    const proposalId = generateObjectId();
    const proposal = ProposalSchema.parse({
      runtime_id: proposalId,
      object_kind: ControlPlaneObjectKind.PROPOSAL,
      task_surface_ref: context.surfaceId ?? null,
      expires_at: null,
      derived_from: input.target_object_id,
      retention_policy: RetentionPolicy.SESSION_ONLY,
      proposal_id: proposalId,
      dossier_ref: null,
      recommended_option_id: null,
      proposal_options: [
        {
          option_id: `memory_update_${proposalId}`,
          option_kind: ProposalOptionKind.REQUEST_CONFIRMATION,
          preserves_protected_constraints: true,
          dropped_candidates: [],
          unresolved_after_apply: [],
          requires_confirmation: true
        }
      ],
      resolution_state: ProposalResolutionState.PENDING,
      last_updated_at: timestamp
    });

    const event = await deps.eventLogRepo.append({
      event_type: Phase1BEventType.SOUL_PROPOSAL_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: context.workspaceId,
      run_id: context.runId,
      caused_by: context.agentTarget,
      revision: await nextRevision(proposal.proposal_id),
      payload_json: SoulProposalCreatedPayloadSchema.parse({
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: context.workspaceId,
        run_id: context.runId
      })
    });
    const created = await deps.proposalRepo.create({
      proposal,
      workspace_id: context.workspaceId,
      run_id: context.runId
    });
    await deps.runtimeNotifier.notifyEntry(event);
    return { proposal_id: created.proposal_id, status: "created" };
  }

  async function reviewMemoryProposal(
    input: SoulReviewMemoryProposalRequest,
    context: McpMemoryToolCallContext
  ): Promise<Readonly<{ proposal_id: string; resolution_state: Proposal["resolution_state"] }>> {
    const scopedProposal = await deps.proposalRepo.findScopedById(input.proposal_id);
    if (scopedProposal === null) {
      throw createWorkflowError("NOT_FOUND", `Proposal not found: ${input.proposal_id}`);
    }
    assertProposalContext(scopedProposal, context);
    const proposal = scopedProposal.proposal;
    if (proposal.resolution_state !== ProposalResolutionState.PENDING) {
      throw createWorkflowError("VALIDATION", `Proposal is already ${proposal.resolution_state}`);
    }

    const reviewedAt = now();
    const toState =
      input.verdict === "accept"
        ? ProposalResolutionState.ACCEPTED
        : ProposalResolutionState.REJECTED;
    const next = createRevisionCursor(await nextRevision(proposal.proposal_id));

    const appendedEvents: EventLogEntry[] = [];
    let reviewCreated: EventLogEntry;
    let reviewCompleted: EventLogEntry;
    let resolved: EventLogEntry;
    let updated: Readonly<Proposal>;

    try {
      reviewCreated = await appendAndTrack(appendedEvents, {
        event_type: Phase1BEventType.SOUL_REVIEW_CREATED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: context.agentTarget,
        revision: next(),
        payload_json: SoulReviewCreatedPayloadSchema.parse({
          object_id: proposal.runtime_id,
          object_kind: proposal.object_kind,
          workspace_id: context.workspaceId,
          run_id: context.runId
        })
      });
      reviewCompleted = await appendAndTrack(appendedEvents, {
        event_type: Phase1BEventType.SOUL_REVIEW_COMPLETED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: context.agentTarget,
        revision: next(),
        payload_json: SoulReviewCompletedPayloadSchema.parse({
          object_id: proposal.runtime_id,
          object_kind: proposal.object_kind,
          workspace_id: context.workspaceId,
          run_id: context.runId,
          from_state: proposal.resolution_state,
          to_state: toState,
          reason_code: input.reason ?? input.verdict,
          caused_by: TransitionCausedBy.REVIEW,
          evidence_refs: null,
          occurred_at: reviewedAt
        })
      });
      resolved = await appendAndTrack(appendedEvents, {
        event_type: Phase1BEventType.SOUL_PROPOSAL_RESOLVED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: context.agentTarget,
        revision: next(),
        payload_json: SoulProposalResolvedPayloadSchema.parse({
          object_id: proposal.runtime_id,
          object_kind: proposal.object_kind,
          workspace_id: context.workspaceId,
          run_id: context.runId,
          from_state: proposal.resolution_state,
          to_state: toState,
          reason_code: input.reason ?? input.verdict,
          caused_by: TransitionCausedBy.REVIEW,
          evidence_refs: null,
          occurred_at: reviewedAt
        })
      });

      updated = await deps.proposalRepo.updatePendingResolution(proposal.proposal_id, toState, reviewedAt);
    } catch (error) {
      await rollbackAppendedEvents(appendedEvents);
      throw normalizeResolutionError(error);
    }
    await deps.runtimeNotifier.notifyEntry(reviewCreated);
    await deps.runtimeNotifier.notifyEntry(reviewCompleted);
    await deps.runtimeNotifier.notifyEntry(resolved);
    return { proposal_id: updated.proposal_id, resolution_state: updated.resolution_state };
  }

  async function appendAndTrack(
    appendedEvents: EventLogEntry[],
    event: Omit<EventLogEntry, "event_id" | "created_at">
  ): Promise<EventLogEntry> {
    const entry = await deps.eventLogRepo.append(event);
    appendedEvents.push(entry);
    return entry;
  }

  async function rollbackAppendedEvents(appendedEvents: readonly EventLogEntry[]): Promise<void> {
    for (const entry of [...appendedEvents].reverse()) {
      await deps.eventLogRepo.deleteById(entry.event_id);
    }
  }

  async function nextRevision(proposalId: string): Promise<number> {
    const events = await deps.eventLogRepo.queryByEntity("proposal", proposalId);
    return events.length + 1;
  }

  async function withProposalReviewLock<T>(proposalId: string, work: () => Promise<T>): Promise<T> {
    const previous = proposalReviewLocks.get(proposalId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(async () => await current);
    proposalReviewLocks.set(proposalId, tail);

    await previous.catch(() => undefined);

    try {
      return await work();
    } finally {
      releaseCurrent();
      if (proposalReviewLocks.get(proposalId) === tail) {
        proposalReviewLocks.delete(proposalId);
      }
    }
  }
}

function assertProposalContext(
  scopedProposal: Readonly<{
    readonly workspace_id: string;
    readonly run_id: string | null;
  }>,
  context: McpMemoryToolCallContext
): void {
  const workspaceId = NonEmptyStringSchema.parse(context.workspaceId);
  const runId = context.runId === null ? null : NonEmptyStringSchema.parse(context.runId);
  if (scopedProposal.workspace_id !== workspaceId || scopedProposal.run_id !== runId) {
    throw createWorkflowError("NOT_FOUND", "Proposal not found in current workspace/run context.");
  }
}

function createRevisionCursor(firstRevision: number): () => number {
  let revision = firstRevision;
  return () => revision++;
}

function createWorkflowError(code: "NOT_FOUND" | "VALIDATION", message: string): Error & { readonly code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function normalizeResolutionError(error: unknown): unknown {
  if (error instanceof Error && "code" in error && error.code === "CONFLICT") {
    return createWorkflowError("VALIDATION", error.message);
  }

  return error;
}
