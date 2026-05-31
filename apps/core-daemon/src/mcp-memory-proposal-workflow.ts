import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  ControlPlaneObjectKind,
  PublicMemoryEntryMutableFieldsSchema,
  NonEmptyStringSchema,
  MemoryGovernanceEventType,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  RetentionPolicy,
  SoulProposalCreatedPayloadSchema,
  SoulProposalResolvedPayloadSchema,
  SoulReviewCompletedPayloadSchema,
  SoulReviewCreatedPayloadSchema,
  TransitionCausedBy,
  type MemoryEntryMutableFields,
  type EventLogEntry,
  type PathAnchorRef,
  type Proposal,
  type SoulListPendingProposalsRequest,
  type SoulPendingProposalSummary,
  type SoulProposeMemoryUpdateRequest,
  type SoulReviewMemoryProposalRequest
} from "@do-soul/alaya-protocol";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandlerDependencies
} from "./mcp-memory-tool-handler.js";

export interface McpMemoryProposalWorkflowEventLogRepo {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export class SourceDeliveryAnchorValidationError extends Error {
  public readonly code = "VALIDATION";
}

type ProposalResolutionEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
type ProposalCreationEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

type AcceptedProposalApply =
  | Readonly<{
      readonly kind: "memory_update";
      readonly memoryUpdate: Readonly<{
        readonly target_object_id: string;
        readonly workspace_id: string;
        readonly proposed_changes: MemoryEntryMutableFields;
        readonly caused_by: string;
        readonly expected_baseline_updated_at: string | null;
      }>;
    }>
  | Readonly<{
      readonly kind: "path_relation_governance";
      readonly pathRelationGovernance: Readonly<{
        readonly target_object_id: string;
        readonly workspace_id: string;
        readonly path_id_on_create: string;
        readonly caused_by: string;
      }>;
    }>;

export interface McpMemoryProposalWorkflowProposalRepo {
  create(input: {
    readonly proposal: Proposal;
    readonly workspace_id: string;
    readonly run_id: string | null;
    readonly target_object_kind?: string;
    readonly proposed_changes?: MemoryEntryMutableFields | null;
    readonly proposed_change_summary?: string;
    readonly created_at?: string;
    readonly target_baseline_updated_at?: string | null;
    readonly source_delivery_ids?: readonly string[] | null;
  }): Promise<Readonly<Proposal>>;
  createProposalWithEvents(
    input: {
      readonly proposal: Proposal;
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly target_object_kind?: string;
      readonly proposed_changes?: MemoryEntryMutableFields | null;
      readonly proposed_change_summary?: string;
      readonly created_at?: string;
      readonly target_baseline_updated_at?: string | null;
      readonly source_delivery_ids?: readonly string[] | null;
    },
    events: readonly ProposalCreationEventInput[],
    options?: {
      readonly reviewerAssignment?: {
        readonly proposal_id: string;
        readonly reviewer_identity: string;
        readonly assigned_at: string;
        readonly deadline_at?: string | null;
        readonly escalation_after_ms?: number | null;
      };
    }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findScopedById(proposalId: string): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly workspace_id: string;
    readonly run_id: string | null;
    // Null until the proposal is reviewed. The workflow does not
    // depend on this field (it is informational for callers), so legacy
    // test fakes that omit it remain compatible via the optional shape.
    readonly reviewer_identity?: string | null;
    readonly reviewer_assignment?: Readonly<{ readonly reviewer_identity: string }> | null;
    // Phase 6 MCP/runtime patch is expected to add durable apply context.
    // Keep optional for compatibility with legacy storage fakes; accept
    // path returns NEEDS_CONTEXT when unavailable.
    readonly target_object_id?: string | null;
    readonly target_object_kind?: string | null;
    readonly proposed_changes?: Readonly<MemoryEntryMutableFields> | null;
    // Scoped path-relation governance payload. The accept-apply path reads the
    // target anchor to gate it through the object-anchor existence/ownership
    // check before the durable insert. Optional for compatibility with legacy
    // storage fakes that predate path_relation proposals.
    readonly proposed_path_relation?: Readonly<{
      readonly target_anchor: PathAnchorRef;
      readonly constitution?: Readonly<{ readonly relation_kind?: string | null }> | null;
    }> | null;
    readonly target_baseline_updated_at?: string | null;
    readonly source_delivery_ids?: readonly string[] | null;
  }> | null>;
  // Pending-queue projection. The repo already enforces workspace
  // scoping; the workflow simply forwards since/limit through.
  findPendingSummaries(
    workspaceId: string,
    options?: {
      readonly since?: string | null;
      readonly limit?: number;
      readonly now?: string;
    }
  ): Promise<readonly Readonly<SoulPendingProposalSummary>[]>;
  acceptPendingMemoryUpdateWithEvents?(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    memoryUpdate: {
      readonly target_object_id: string;
      readonly workspace_id: string;
      readonly proposed_changes: MemoryEntryMutableFields;
      readonly updated_at: string;
      readonly caused_by: string;
      // Optional baseline snapshot of memory_entry.updated_at captured by
      // prepareAcceptedProposalApply outside the storage transaction. The
      // storage layer asserts the live row is still at this baseline before
      // applying; mismatch becomes a stale-snapshot CONFLICT.
      readonly expected_baseline_updated_at?: string | null;
    },
    options?: { readonly reviewerIdentity?: string }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
      readonly events: readonly EventLogEntry[];
    }>>;
  acceptPendingPathRelationGovernanceWithEvents?(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    pathRelationGovernance: {
      readonly target_object_id: string;
      readonly workspace_id: string;
      readonly path_id_on_create: string;
      readonly updated_at: string;
      readonly caused_by: string;
    },
    options?: { readonly reviewerIdentity?: string }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  updatePendingResolutionWithEvents(
    proposalId: string,
    state: Proposal["resolution_state"],
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    options?: { readonly reviewerIdentity?: string }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
}

export interface McpMemoryProposalWorkflowRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface ReviewerIdentityBinding {
  readonly token: string;
  readonly identity: string;
}

export interface McpMemoryProposalWorkflowDependencies {
  readonly eventLogRepo: McpMemoryProposalWorkflowEventLogRepo;
  readonly proposalRepo: McpMemoryProposalWorkflowProposalRepo;
  readonly runtimeNotifier: McpMemoryProposalWorkflowRuntimeNotifier;
  readonly memoryService?: Readonly<{
    findByIdScoped(
      objectId: string,
      workspaceId: string
    ): Promise<
      | Readonly<{
          readonly object_id: string;
          // Optional baseline timestamp captured outside the storage
          // transaction so the accept-and-apply path can reject
          // stale-snapshot proposals via a CAS predicate.
          readonly updated_at?: string;
        }>
      | null
    >;
    update(
      objectId: string,
      fields: MemoryEntryMutableFields,
      reason: string
    ): Promise<Readonly<{ readonly object_id: string }>>;
    validateUpdate?(
      objectId: string,
      fields: MemoryEntryMutableFields
    ): Promise<void>;
  }>;
  readonly reviewerIdentityBinding?: ReviewerIdentityBinding;
  readonly sourceDeliveryAnchorValidator?: {
    validate(
      sourceDeliveryIds: readonly string[],
      context: McpMemoryToolCallContext
    ): Promise<void> | void;
  };
  // invariant: the SAME object-anchor existence + ownership gate the path mint
  // sink runs. The accept-apply path inserts a stored proposed_path_relation
  // into the durable path plane through the storage transaction (which cannot
  // import the core service), so this seam routes that second insert through
  // B3's gate before it lands. Wired by the daemon to
  // PathRelationProposalService.validateProposedObjectAnchors; left undefined
  // only in unit tests that do not exercise path_relation proposals.
  // see also: packages/core/src/path-relation-proposal-service.ts validateProposedObjectAnchors
  readonly objectAnchorGate?: {
    validateProposedObjectAnchors(input: {
      readonly workspaceId: string;
      readonly relationKind: string;
      readonly sourceAnchor: PathAnchorRef;
      readonly targetAnchor: PathAnchorRef;
    }): Promise<"accepted" | "rejected">;
  };
  readonly now?: () => string;
  readonly generateObjectId?: () => string;
}

export function createMcpMemoryProposalWorkflow(
  deps: McpMemoryProposalWorkflowDependencies
): NonNullable<McpMemoryToolHandlerDependencies["proposalWorkflow"]> {
  const now = deps.now ?? (() => new Date().toISOString());
  const generateObjectId = deps.generateObjectId ?? randomUUID;

  return {
    proposeMemoryUpdate: async (input, context) => await proposeMemoryUpdate(input, context),
    reviewMemoryProposal: async (input, context) => await reviewMemoryProposal(input, context),
    listPendingProposals: async (input, context) => await listPendingProposals(input, context)
  };

  async function proposeMemoryUpdate(
    input: SoulProposeMemoryUpdateRequest,
    context: McpMemoryToolCallContext
  ): Promise<Readonly<{ proposal_id: string; status: "created" }>> {
    const timestamp = now();
    const proposalId = generateObjectId();
    const sourceDeliveryIds = input.source_delivery_ids ?? null;
    await validateSourceDeliveryIds(sourceDeliveryIds, context);
    const targetBaselineUpdatedAt = await readProposalTargetBaseline(
      input.target_object_id,
      context.workspaceId
    );
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

    const creationEvents: ProposalCreationEventInput[] = [
      {
        event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: context.agentTarget,
        payload_json: SoulProposalCreatedPayloadSchema.parse({
          object_id: proposal.runtime_id,
          object_kind: proposal.object_kind,
          workspace_id: context.workspaceId,
          run_id: context.runId,
          ...(sourceDeliveryIds === null ? {} : { source_delivery_ids: sourceDeliveryIds })
        })
      }
    ];

    const reviewerAssignment =
      deps.reviewerIdentityBinding === undefined
        ? undefined
        : {
            proposal_id: proposal.proposal_id,
            reviewer_identity: deps.reviewerIdentityBinding.identity,
            assigned_at: timestamp,
            deadline_at: proposal.expires_at,
            escalation_after_ms: null
          };

    const created = await deps.proposalRepo.createProposalWithEvents(
      {
        proposal,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        // Store projection metadata so soul.list_pending_proposals
        // can serve a useful summary without joining event_log payloads.
        // The MCP-driven proposeMemoryUpdate path always targets memory
        // entries; the reason text is the agent-supplied change summary.
        target_object_kind: "memory_entry",
        proposed_changes: input.proposed_changes,
        proposed_change_summary: input.reason,
        created_at: timestamp,
        target_baseline_updated_at: targetBaselineUpdatedAt,
        source_delivery_ids: sourceDeliveryIds
      },
      creationEvents,
      reviewerAssignment === undefined ? undefined : { reviewerAssignment }
    );
    for (const event of created.events) {
      await deps.runtimeNotifier.notifyEntry(event);
    }
    return { proposal_id: created.proposal.proposal_id, status: "created" };
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

    assertReviewCallerIsAllowed(context, deps.reviewerIdentityBinding);
    const reviewerIdentity = resolveReviewerIdentity(input, deps.reviewerIdentityBinding);
    assertReviewerAssignment(scopedProposal, reviewerIdentity);
    const reviewedAt = now();
    const toState =
      input.verdict === "accept"
        ? ProposalResolutionState.ACCEPTED
        : ProposalResolutionState.REJECTED;
    const acceptedMemoryUpdate =
      input.verdict === "accept"
        ? await prepareAcceptedProposalApply(scopedProposal, context)
        : undefined;
    // Review-related event_log rows record reviewer_identity in caused_by
    // so the audit trail names the human
    // (or principal) who approved/rejected, not just the surface that
    // delivered the call. The propose path keeps caused_by=agentTarget
    // because that is who *created* the proposal.
    const reviewEvents: ProposalResolutionEventInput[] = [
      {
        event_type: MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: reviewerIdentity,
        payload_json: SoulReviewCreatedPayloadSchema.parse({
          object_id: proposal.runtime_id,
          object_kind: proposal.object_kind,
          workspace_id: context.workspaceId,
          run_id: context.runId
        })
      },
      {
        event_type: MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: reviewerIdentity,
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
      },
      {
        event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
        entity_type: "proposal",
        entity_id: proposal.proposal_id,
        workspace_id: context.workspaceId,
        run_id: context.runId,
        caused_by: reviewerIdentity,
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
          occurred_at: reviewedAt,
          ...(scopedProposal.source_delivery_ids === null ||
          scopedProposal.source_delivery_ids === undefined
            ? {}
            : { source_delivery_ids: scopedProposal.source_delivery_ids })
        })
      }
    ];
    let resolved: Readonly<{
      readonly proposal: Readonly<Proposal>;
      readonly events: readonly EventLogEntry[];
    }>;

    try {
      resolved =
        acceptedMemoryUpdate === undefined
          ? await deps.proposalRepo.updatePendingResolutionWithEvents(
              proposal.proposal_id,
              toState,
              reviewedAt,
              reviewEvents,
              { reviewerIdentity }
            )
          : acceptedMemoryUpdate.kind === "memory_update"
            ? await acceptProposalWithDurableMemoryUpdate(
                proposal.proposal_id,
                reviewedAt,
                reviewEvents,
                acceptedMemoryUpdate.memoryUpdate,
                reviewerIdentity
              )
            : await acceptProposalWithDurablePathRelationGovernance(
                proposal.proposal_id,
                reviewedAt,
                reviewEvents,
                acceptedMemoryUpdate.pathRelationGovernance,
                reviewerIdentity
              );
    } catch (error) {
      throw normalizeResolutionError(error);
    }
    for (const event of resolved.events) {
      await deps.runtimeNotifier.notifyEntry(event);
    }
    return {
      proposal_id: resolved.proposal.proposal_id,
      resolution_state: resolved.proposal.resolution_state
    };
  }

  async function listPendingProposals(
    input: SoulListPendingProposalsRequest,
    context: McpMemoryToolCallContext
  ): Promise<Readonly<{
    readonly proposals: readonly Readonly<SoulPendingProposalSummary>[];
    readonly total_count: number;
  }>> {
    // workspace_id is server-bound from the trusted MCP call context
    // (invariants §29 Default Scope) and is
    // no longer present on the request schema. The workflow forwards
    // context.workspaceId — never input — to the repo.
    const summaries = await deps.proposalRepo.findPendingSummaries(context.workspaceId, {
      since: input.since ?? null,
      limit: input.limit ?? 50,
      now: now()
    });
    return {
      proposals: summaries,
      total_count: summaries.length
    };
  }

  async function prepareAcceptedProposalApply(
    scopedProposal: Readonly<{
      readonly proposal: Readonly<Proposal>;
      readonly workspace_id: string;
      readonly target_object_kind?: string | null;
      readonly target_object_id?: string | null;
      readonly proposed_changes?: Readonly<MemoryEntryMutableFields> | null;
      readonly proposed_path_relation?: Readonly<{
        readonly target_anchor: PathAnchorRef;
        readonly constitution?: Readonly<{ readonly relation_kind?: string | null }> | null;
      }> | null;
      readonly target_baseline_updated_at?: string | null;
    }>,
    context: McpMemoryToolCallContext
  ): Promise<AcceptedProposalApply> {
    const targetObjectKind = scopedProposal.target_object_kind ?? "memory_entry";
    if (targetObjectKind === "path_relation") {
      return await prepareAcceptedPathRelationGovernance(scopedProposal, context);
    }
    if (targetObjectKind !== "memory_entry") {
      throw createWorkflowError(
        "NEEDS_CONTEXT",
        `Proposal ${scopedProposal.proposal.proposal_id} has unsupported target_object_kind ${targetObjectKind}.`
      );
    }

    const memoryService = deps.memoryService;
    if (memoryService === undefined) {
      throw createWorkflowError(
        "NEEDS_CONTEXT",
        "Memory apply port is unavailable; wire memoryService into MCP proposal workflow."
      );
    }

    const proposalId = scopedProposal.proposal.proposal_id;
    const targetObjectId = resolveProposalTargetObjectId(scopedProposal, proposalId);
    const proposedChanges = resolveProposalChanges(scopedProposal, proposalId);
    const scopedTarget = await memoryService.findByIdScoped(targetObjectId, context.workspaceId);
    if (scopedTarget === null) {
      throw createWorkflowError(
        "NOT_FOUND",
        `Target memory object not found in workspace: ${targetObjectId}`
      );
    }
    if (memoryService.validateUpdate === undefined) {
      throw createWorkflowError(
        "NEEDS_CONTEXT",
        "Memory update validation port is unavailable; wire MemoryService.validateUpdate into MCP proposal workflow."
      );
    }
    await memoryService.validateUpdate(targetObjectId, proposedChanges);

    return {
      kind: "memory_update",
      memoryUpdate: {
        target_object_id: targetObjectId,
        workspace_id: context.workspaceId,
        proposed_changes: proposedChanges,
        caused_by: `proposal_accept:${proposalId}`,
        expected_baseline_updated_at: scopedProposal.target_baseline_updated_at ?? null
      }
    };
  }

  async function prepareAcceptedPathRelationGovernance(
    scopedProposal: Readonly<{
      readonly proposal: Readonly<Proposal>;
      readonly workspace_id: string;
      readonly target_object_id?: string | null;
      readonly proposed_path_relation?: Readonly<{
        readonly target_anchor: PathAnchorRef;
        readonly constitution?: Readonly<{ readonly relation_kind?: string | null }> | null;
      }> | null;
    }>,
    context: McpMemoryToolCallContext
  ): Promise<AcceptedProposalApply> {
    const memoryService = deps.memoryService;
    if (memoryService === undefined) {
      throw createWorkflowError(
        "NEEDS_CONTEXT",
        "Memory read port is unavailable; wire memoryService into MCP proposal workflow."
      );
    }
    const proposalId = scopedProposal.proposal.proposal_id;
    const targetObjectId = resolveProposalTargetObjectId(scopedProposal, proposalId);
    const scopedTarget = await memoryService.findByIdScoped(targetObjectId, context.workspaceId);
    if (scopedTarget === null) {
      throw createWorkflowError(
        "NOT_FOUND",
        `Target memory object not found in workspace: ${targetObjectId}`
      );
    }

    // invariant: this is the second durable path-insert route; gate its object
    // anchors through B3's existence + ownership check before the storage
    // accept-apply commits a path_relations row. The storage layer builds the
    // source anchor as {kind:object, object_id: targetObjectId} and the target
    // anchor from proposed_path_relation.target_anchor (the only field an
    // untrusted producer could aim at a foreign/missing object). A rejection
    // emits the same path.relation_rejected audit the mint sink uses and stops
    // the accept-apply before any durable insert.
    // see also: packages/storage/src/repos/proposal-repo.ts createPathRelationFromProposalPayload
    await assertProposedPathAnchorsValid(scopedProposal, context.workspaceId, targetObjectId);

    return {
      kind: "path_relation_governance",
      pathRelationGovernance: {
        target_object_id: targetObjectId,
        workspace_id: context.workspaceId,
        path_id_on_create: generateObjectId(),
        caused_by: `proposal_accept:${proposalId}`
      }
    };
  }

  async function assertProposedPathAnchorsValid(
    scopedProposal: Readonly<{
      readonly proposed_path_relation?: Readonly<{
        readonly target_anchor: PathAnchorRef;
        readonly constitution?: Readonly<{ readonly relation_kind?: string | null }> | null;
      }> | null;
    }>,
    workspaceId: string,
    targetObjectId: string
  ): Promise<void> {
    if (deps.objectAnchorGate === undefined) {
      return;
    }
    const payload = scopedProposal.proposed_path_relation ?? null;
    // The storage insert always mints the source as an object anchor on the
    // (already existence/ownership-checked) target memory; the target anchor is
    // the payload's when present, else a synthetic object_facet on the same
    // memory. Both are passed to the gate, which resolves the backing memory
    // object id of every anchor variant and checks its existence + ownership.
    const sourceAnchor: PathAnchorRef = { kind: "object", object_id: targetObjectId };
    const targetAnchor: PathAnchorRef =
      payload === null
        ? { kind: "object_facet", object_id: targetObjectId, facet_key: "strictly_governed_constraint" }
        : payload.target_anchor;
    const relationKind = payload?.constitution?.relation_kind ?? "governance_constraint";
    const outcome = await deps.objectAnchorGate.validateProposedObjectAnchors({
      workspaceId,
      relationKind,
      sourceAnchor,
      targetAnchor
    });
    if (outcome === "rejected") {
      throw createWorkflowError(
        "VALIDATION",
        "Proposed path relation names an object anchor that is missing or owned by another workspace."
      );
    }
  }

  async function acceptProposalWithDurableMemoryUpdate(
    proposalId: string,
    reviewedAt: string,
    reviewEvents: readonly ProposalResolutionEventInput[],
    memoryUpdate: Readonly<{
      readonly target_object_id: string;
      readonly workspace_id: string;
      readonly proposed_changes: MemoryEntryMutableFields;
      readonly caused_by: string;
      readonly expected_baseline_updated_at: string | null;
    }>,
    reviewerIdentity: string
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>> {
    if (deps.proposalRepo.acceptPendingMemoryUpdateWithEvents === undefined) {
      throw createWorkflowError(
        "NEEDS_CONTEXT",
        "Atomic proposal accept + memory apply port is unavailable."
      );
    }

    return await deps.proposalRepo.acceptPendingMemoryUpdateWithEvents(
      proposalId,
      reviewedAt,
      reviewEvents,
      {
        ...memoryUpdate,
        updated_at: reviewedAt
      },
      { reviewerIdentity }
    );
  }

  async function acceptProposalWithDurablePathRelationGovernance(
    proposalId: string,
    reviewedAt: string,
    reviewEvents: readonly ProposalResolutionEventInput[],
    pathRelationGovernance: Readonly<{
      readonly target_object_id: string;
      readonly workspace_id: string;
      readonly path_id_on_create: string;
      readonly caused_by: string;
    }>,
    reviewerIdentity: string
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>> {
    if (deps.proposalRepo.acceptPendingPathRelationGovernanceWithEvents === undefined) {
      throw createWorkflowError(
        "NEEDS_CONTEXT",
        "Atomic proposal accept + path relation governance apply port is unavailable."
      );
    }

    return await deps.proposalRepo.acceptPendingPathRelationGovernanceWithEvents(
      proposalId,
      reviewedAt,
      reviewEvents,
      {
        ...pathRelationGovernance,
        updated_at: reviewedAt
      },
      { reviewerIdentity }
    );
  }

  async function readProposalTargetBaseline(
    targetObjectId: string,
    workspaceId: string
  ): Promise<string | null> {
    const memoryService = deps.memoryService;
    if (memoryService === undefined) {
      return null;
    }
    const scopedTarget = await memoryService.findByIdScoped(targetObjectId, workspaceId);
    if (scopedTarget === null) {
      throw createWorkflowError(
        "NOT_FOUND",
        `Target memory object not found in workspace: ${targetObjectId}`
      );
    }
    return scopedTarget.updated_at ?? null;
  }

  async function validateSourceDeliveryIds(
    sourceDeliveryIds: readonly string[] | null,
    context: McpMemoryToolCallContext
  ): Promise<void> {
    if (sourceDeliveryIds === null) {
      return;
    }
    if (deps.sourceDeliveryAnchorValidator === undefined) {
      throw new SourceDeliveryAnchorValidationError(
        "source_delivery_ids require a source delivery anchor validator."
      );
    }
    await deps.sourceDeliveryAnchorValidator.validate(sourceDeliveryIds, context);
  }
}

/**
 * The set of `agentTarget` values that identify the human-reviewer
 * surfaces (Inspector loopback + `alaya review` CLI). Only callers in
 * this set are allowed to review run-scoped proposals with
 * `runId: null`. Any other agent-attached caller still needs strict
 * workspace+run match.
 */
const HUMAN_REVIEWER_AGENT_TARGETS: ReadonlySet<string> = new Set([
  "inspector",
  "cli"
]);

function assertReviewCallerIsAllowed(
  context: McpMemoryToolCallContext,
  binding: ReviewerIdentityBinding | undefined
): void {
  if (binding !== undefined || HUMAN_REVIEWER_AGENT_TARGETS.has(context.agentTarget)) {
    return;
  }

  throw createWorkflowError(
    "VALIDATION",
    "Review requires a human reviewer surface (Inspector/alaya review) or a configured reviewer token."
  );
}

function resolveReviewerIdentity(
  input: SoulReviewMemoryProposalRequest,
  binding: ReviewerIdentityBinding | undefined
): string {
  if (binding === undefined) {
    return input.reviewer_identity;
  }

  if (!matchesReviewerToken(input.reviewer_token, binding.token)) {
    throw createWorkflowError("VALIDATION", "Invalid reviewer token.");
  }
  if (input.reviewer_identity !== binding.identity) {
    throw createWorkflowError("VALIDATION", "Reviewer identity does not match server-bound reviewer.");
  }
  return binding.identity;
}

function assertReviewerAssignment(
  scopedProposal: Readonly<{
    readonly reviewer_assignment?: Readonly<{ readonly reviewer_identity: string }> | null;
  }>,
  reviewerIdentity: string
): void {
  const assignment = scopedProposal.reviewer_assignment ?? null;
  if (assignment !== null && assignment.reviewer_identity !== reviewerIdentity) {
    throw createWorkflowError("VALIDATION", "Proposal is assigned to a different reviewer.");
  }
}

function matchesReviewerToken(providedToken: string | undefined, expectedToken: string): boolean {
  if (providedToken === undefined || providedToken.length === 0) {
    return false;
  }
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function assertProposalContext(
  scopedProposal: Readonly<{
    readonly workspace_id: string;
    readonly run_id: string | null;
  }>,
  context: McpMemoryToolCallContext
): void {
  // The original strict check required
  //   scopedProposal.run_id === context.runId
  // even when the call came in from the human-reviewer surfaces (the
  // Inspector POST and `alaya review accept`), which always pass
  // runId: null. That made every proposal created via
  // soul.propose_memory_update — i.e. every proposal carrying the
  // attached agent's run_id — unreviewable through Inspector or CLI.
  //
  // The human-reviewer loosening is gated on
  // `agentTarget ∈ HUMAN_REVIEWER_AGENT_TARGETS` (Inspector + CLI).
  // Other surfaces still need strict workspace+run match, including MCP
  // callers whose context resolves to runId=null.
  const workspaceId = NonEmptyStringSchema.parse(context.workspaceId);
  if (scopedProposal.workspace_id !== workspaceId) {
    throw createWorkflowError("NOT_FOUND", "Proposal not found in current workspace/run context.");
  }
  const isHumanReviewerSurface = HUMAN_REVIEWER_AGENT_TARGETS.has(context.agentTarget);
  if (context.runId === null && isHumanReviewerSurface) {
    return;
  }
  if (context.runId === null) {
    // Non-human caller with no runId is treated as a strict mismatch:
    // the proposal MUST also have run_id=null.
    if (scopedProposal.run_id !== null) {
      throw createWorkflowError(
        "NOT_FOUND",
        "Proposal not found in current workspace/run context."
      );
    }
    return;
  }
  const runId = NonEmptyStringSchema.parse(context.runId);
  if (scopedProposal.run_id !== runId) {
    throw createWorkflowError("NOT_FOUND", "Proposal not found in current workspace/run context.");
  }
}

function createWorkflowError(
  code: "NOT_FOUND" | "VALIDATION" | "NEEDS_CONTEXT",
  message: string
): Error & { readonly code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function resolveProposalTargetObjectId(
  scopedProposal: Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly target_object_id?: string | null;
  }>,
  proposalId: string
): string {
  const targetObjectId = scopedProposal.target_object_id ?? scopedProposal.proposal.derived_from;
  if (targetObjectId === null || targetObjectId === undefined || targetObjectId.trim().length === 0) {
    throw createWorkflowError(
      "NEEDS_CONTEXT",
      `Proposal ${proposalId} is missing target_object_id/derived_from for accept-as-apply.`
    );
  }
  return NonEmptyStringSchema.parse(targetObjectId);
}

function resolveProposalChanges(
  scopedProposal: Readonly<{
    readonly proposed_changes?: Readonly<MemoryEntryMutableFields> | null;
  }>,
  proposalId: string
): MemoryEntryMutableFields {
  if (scopedProposal.proposed_changes === undefined || scopedProposal.proposed_changes === null) {
    throw createWorkflowError(
      "NEEDS_CONTEXT",
      `Proposal ${proposalId} does not expose proposed_changes yet.`
    );
  }
  return PublicMemoryEntryMutableFieldsSchema.parse(scopedProposal.proposed_changes);
}

function normalizeResolutionError(error: unknown): unknown {
  if (error instanceof Error && "code" in error && error.code === "CONFLICT") {
    return createWorkflowError("VALIDATION", error.message);
  }
  if (error instanceof Error && "code" in error && error.code === "VALIDATION_FAILED") {
    return createWorkflowError("VALIDATION", error.message);
  }

  return error;
}
