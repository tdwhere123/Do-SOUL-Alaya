import {
  NonEmptyStringSchema,
  PublicMemoryEntryMutableFieldsSchema,
  SynthesisCapsuleSchema,
  SynthesisType,
  type EventLogEntry,
  type MemoryEntryMutableFields,
  type PathAnchorRef,
  type Proposal,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { McpMemoryToolCallContext } from "./tool-handler.js";
import type { McpMemoryProposalWorkflowDependencies } from "./proposal-workflow.js";

type ProposalResolutionEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
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
    }>
  | Readonly<{
      readonly kind: "synthesis_create";
      readonly synthesisCreate: Readonly<{
        readonly workspace_id: string;
        readonly capsule: SynthesisCapsule;
        readonly caused_by: string;
      }>;
    }>;

const SYNTHESIS_CREATE_DOSSIER_REFS: ReadonlySet<string> = new Set([
  "librarian.synthesis",
  "bootstrapping.synthesis_candidate"
]);
const SYNTHESIS_TOPIC_PREFIXES: readonly string[] = ["synthesis-subject:", "bootstrapping:"];
const SYNTHESIS_SUMMARY_MAX_LENGTH = 600;

export async function prepareAcceptedProposalApply(
  deps: McpMemoryProposalWorkflowDependencies,
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
  context: McpMemoryToolCallContext,
  now: () => string,
  generateObjectId: () => string
): Promise<AcceptedProposalApply> {
  const dossierRef = scopedProposal.proposal.dossier_ref;
  if (dossierRef !== null && SYNTHESIS_CREATE_DOSSIER_REFS.has(dossierRef)) {
    return await prepareAcceptedSynthesisCreate(deps, scopedProposal, context, now, generateObjectId);
  }

  const targetObjectKind = scopedProposal.target_object_kind ?? "memory_entry";
  if (targetObjectKind === "path_relation") {
    return await prepareAcceptedPathRelationGovernance(deps, scopedProposal, context, generateObjectId);
  }
  if (targetObjectKind !== "memory_entry") {
    throw createAcceptanceError(
      "NEEDS_CONTEXT",
      `Proposal ${scopedProposal.proposal.proposal_id} has unsupported target_object_kind ${targetObjectKind}.`
    );
  }

  const memoryService = deps.memoryService;
  if (memoryService === undefined) {
    throw createAcceptanceError(
      "NEEDS_CONTEXT",
      "Memory apply port is unavailable; wire memoryService into MCP proposal workflow."
    );
  }

  const proposalId = scopedProposal.proposal.proposal_id;
  const targetObjectId = resolveProposalTargetObjectId(scopedProposal, proposalId);
  const proposedChanges = resolveProposalChanges(scopedProposal, proposalId);
  const scopedTarget = await memoryService.findByIdScoped(targetObjectId, context.workspaceId);
  if (scopedTarget === null) {
    throw createAcceptanceError(
      "NOT_FOUND",
      `Target memory object not found in workspace: ${targetObjectId}`
    );
  }
  if (memoryService.validateUpdate === undefined) {
    throw createAcceptanceError(
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

export async function acceptProposalWithDurableMemoryUpdate(
  deps: McpMemoryProposalWorkflowDependencies,
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
    throw createAcceptanceError(
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

export async function acceptProposalWithDurablePathRelationGovernance(
  deps: McpMemoryProposalWorkflowDependencies,
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
    throw createAcceptanceError(
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

export async function acceptProposalWithDurableSynthesisCreate(
  deps: McpMemoryProposalWorkflowDependencies,
  proposalId: string,
  reviewedAt: string,
  reviewEvents: readonly ProposalResolutionEventInput[],
  synthesisCreate: Readonly<{
    readonly workspace_id: string;
    readonly capsule: SynthesisCapsule;
    readonly caused_by: string;
  }>,
  reviewerIdentity: string
): Promise<Readonly<{
  readonly proposal: Readonly<Proposal>;
  readonly events: readonly EventLogEntry[];
}>> {
  if (deps.proposalRepo.acceptPendingSynthesisCreateWithEvents === undefined) {
    throw createAcceptanceError(
      "NEEDS_CONTEXT",
      "Atomic proposal accept + synthesis create port is unavailable."
    );
  }

  return await deps.proposalRepo.acceptPendingSynthesisCreateWithEvents(
    proposalId,
    reviewedAt,
    reviewEvents,
    synthesisCreate,
    { reviewerIdentity }
  );
}

async function prepareAcceptedPathRelationGovernance(
  deps: McpMemoryProposalWorkflowDependencies,
  scopedProposal: Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly workspace_id: string;
    readonly target_object_id?: string | null;
    readonly proposed_path_relation?: Readonly<{
      readonly target_anchor: PathAnchorRef;
      readonly constitution?: Readonly<{ readonly relation_kind?: string | null }> | null;
    }> | null;
  }>,
  context: McpMemoryToolCallContext,
  generateObjectId: () => string
): Promise<AcceptedProposalApply> {
  const memoryService = deps.memoryService;
  if (memoryService === undefined) {
    throw createAcceptanceError(
      "NEEDS_CONTEXT",
      "Memory read port is unavailable; wire memoryService into MCP proposal workflow."
    );
  }

  const proposalId = scopedProposal.proposal.proposal_id;
  const targetObjectId = resolveProposalTargetObjectId(scopedProposal, proposalId);
  const scopedTarget = await memoryService.findByIdScoped(targetObjectId, context.workspaceId);
  if (scopedTarget === null) {
    throw createAcceptanceError(
      "NOT_FOUND",
      `Target memory object not found in workspace: ${targetObjectId}`
    );
  }

  await assertProposedPathAnchorsValid(deps, scopedProposal, context.workspaceId, targetObjectId);

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

async function prepareAcceptedSynthesisCreate(
  deps: McpMemoryProposalWorkflowDependencies,
  scopedProposal: Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly workspace_id: string;
  }>,
  context: McpMemoryToolCallContext,
  now: () => string,
  generateObjectId: () => string
): Promise<AcceptedProposalApply> {
  const proposal = scopedProposal.proposal;
  const proposalId = proposal.proposal_id;
  const evidenceRefs = proposal.proposal_options[0]?.dropped_candidates ?? [];
  const topicKey = deriveSynthesisTopicKey(proposal.derived_from, proposalId);
  const gists = await resolveSynthesisEvidenceGists(deps, evidenceRefs, context.workspaceId, proposalId);
  const summary = buildDeterministicSynthesisSummary(topicKey, gists);
  const sourceMemoryRefs = await resolveSynthesisMemberRefs(
    deps,
    evidenceRefs,
    context.workspaceId
  );
  const timestamp = now();
  const capsule = parseSynthesisCapsuleForAccept({
    object_id: generateObjectId(),
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: timestamp,
    updated_at: timestamp,
    created_by: `proposal_accept:${proposalId}`,
    topic_key: topicKey,
    synthesis_type: SynthesisType.CROSS_EVIDENCE,
    summary,
    evidence_refs: [...evidenceRefs],
    source_memory_refs: sourceMemoryRefs,
    workspace_id: context.workspaceId,
    run_id: `synthesis-accept:${context.workspaceId}`,
    synthesis_status: "working"
  });

  return {
    kind: "synthesis_create",
    synthesisCreate: {
      workspace_id: context.workspaceId,
      capsule,
      caused_by: `proposal_accept:${proposalId}`
    }
  };
}

async function resolveSynthesisEvidenceGists(
  deps: McpMemoryProposalWorkflowDependencies,
  evidenceRefs: readonly string[],
  workspaceId: string,
  proposalId: string
): Promise<readonly string[]> {
  if (evidenceRefs.length === 0) {
    return [];
  }
  const reader = deps.synthesisEvidenceReader;
  if (reader === undefined) {
    throw createAcceptanceError(
      "NEEDS_CONTEXT",
      "Synthesis evidence reader is unavailable; wire synthesisEvidenceReader into MCP proposal workflow."
    );
  }
  const gists: string[] = [];
  for (const evidenceRef of evidenceRefs) {
    const gist = await reader.findGistById(evidenceRef, workspaceId);
    if (gist === null) {
      throw createAcceptanceError(
        "NOT_FOUND",
        `Synthesis proposal ${proposalId} references evidence not found in workspace: ${evidenceRef}`
      );
    }
    gists.push(gist);
  }
  return gists;
}

async function resolveSynthesisMemberRefs(
  deps: McpMemoryProposalWorkflowDependencies,
  evidenceRefs: readonly string[],
  workspaceId: string
): Promise<readonly string[]> {
  if (evidenceRefs.length === 0) {
    return [];
  }
  const resolver = deps.synthesisMemberResolver;
  if (resolver === undefined) {
    return [];
  }
  const memberIds = await resolver.findMemberObjectIdsByEvidenceRefs(workspaceId, evidenceRefs);
  return [...new Set(memberIds.filter((id) => typeof id === "string" && id.length > 0))].sort();
}

async function assertProposedPathAnchorsValid(
  deps: McpMemoryProposalWorkflowDependencies,
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
    throw createAcceptanceError(
      "VALIDATION",
      "Proposed path relation names an object anchor that is missing or owned by another workspace."
    );
  }
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
    throw createAcceptanceError(
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
    throw createAcceptanceError(
      "NEEDS_CONTEXT",
      `Proposal ${proposalId} does not expose proposed_changes yet.`
    );
  }
  return PublicMemoryEntryMutableFieldsSchema.parse(scopedProposal.proposed_changes);
}

function deriveSynthesisTopicKey(derivedFrom: string | null, proposalId: string): string {
  const raw = derivedFrom ?? "";
  for (const prefix of SYNTHESIS_TOPIC_PREFIXES) {
    if (raw.startsWith(prefix)) {
      const stripped = raw.slice(prefix.length).trim();
      if (stripped.length > 0) {
        return stripped;
      }
    }
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : `synthesis:${proposalId}`;
}

function buildDeterministicSynthesisSummary(
  topicKey: string,
  gists: readonly string[]
): string {
  const cleanedGists = gists
    .map((gist) => gist.trim())
    .filter((gist) => gist.length > 0);
  const body =
    cleanedGists.length === 0
      ? "no member evidence"
      : cleanedGists.join("; ");
  const summary = `Synthesis of ${topicKey}: ${body}`;
  if (summary.length <= SYNTHESIS_SUMMARY_MAX_LENGTH) {
    return summary;
  }
  return summary.slice(0, SYNTHESIS_SUMMARY_MAX_LENGTH);
}

function parseSynthesisCapsuleForAccept(value: unknown): SynthesisCapsule {
  return SynthesisCapsuleSchema.parse(value);
}

function createAcceptanceError(
  code: "NOT_FOUND" | "VALIDATION" | "NEEDS_CONTEXT",
  message: string
): Error & { readonly code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
