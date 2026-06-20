import { randomUUID } from "node:crypto";
import type { MemoryEntryMutableFields, PathAnchorRef, SynthesisCapsule } from "@do-soul/alaya-protocol";
import type {
  McpMemoryToolCallContext,
  McpMemoryToolHandlerDependencies
} from "./tool-handler-types.js";
import { createProposalWorkflowHandlers } from "./proposal-workflow-handlers.js";
import { type ReviewerIdentityBinding } from "./proposal-workflow-reviewer.js";
export type { ReviewerIdentityBinding } from "./proposal-workflow-reviewer.js";
import type {
  McpMemoryProposalWorkflowEventLogRepo,
  McpMemoryProposalWorkflowProposalRepo,
  McpMemoryProposalWorkflowRuntimeNotifier
} from "./proposal-workflow-types.js";
export type {
  McpMemoryProposalWorkflowEventLogRepo,
  McpMemoryProposalWorkflowProposalRepo,
  McpMemoryProposalWorkflowRuntimeNotifier
} from "./proposal-workflow-types.js";
export { SourceDeliveryAnchorValidationError } from "./proposal-workflow-types.js";

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
  // invariant: the MEMORY-COMPRESSION synthesis-create accept-apply reads member
  // evidence gists to distill a deterministic, NO-LLM summary and to validate
  // that every recovered evidence ref exists before the durable insert (the same
  // EventLog-first reference gate SynthesisService.create runs). Wired by the
  // daemon to EvidenceService; left undefined in unit tests that do not exercise
  // synthesis review proposals. A null gist read is treated as a missing ref.
  // see also: packages/core/src/memory/synthesis-service.ts validateEvidenceRefs
  readonly synthesisEvidenceReader?: {
    findGistById(
      evidenceId: string,
      workspaceId: string
    ): Promise<string | null>;
  };
  // invariant: resolves the synthesis cluster's member memories at capsule-build
  // time so source_memory_refs is populated, not hard-coded empty. An eligible
  // member is a workspace-scoped memory whose evidence_refs are a SUBSET of the
  // capsule's evidence_refs (the member is FULLY consolidated by the cluster the
  // librarian/auditor summarized — it has no private evidence living outside the
  // cluster). The compress arm of autonomous forgetting earns the `compressed`
  // disposition ONLY for a member listed here, so an unpopulated set leaves the
  // arm inert. The lookup is mechanical (no LLM) and BOUNDED by the repo (caps
  // the id set + LIMITs the row scan). Wired by the daemon to
  // memoryEntryRepo.findByEvidenceRefs (intersection candidates) then narrowed to
  // the subset members; left undefined in unit tests that do not exercise member
  // resolution (capsule then builds with an empty member set).
  // see also: packages/storage/src/repos/memory-entry/sqlite-memory-entry-repo.ts findByEvidenceRefs,
  // apps/core-daemon/src/garden/forget-disposition-ports.ts buildLiveCapsuleMemberIndex
  readonly synthesisMemberResolver?: {
    findMemberObjectIdsByEvidenceRefs(
      workspaceId: string,
      evidenceRefs: readonly string[]
    ): Promise<readonly string[]>;
  };
  readonly reviewerIdentityBinding?: ReviewerIdentityBinding;
  readonly sourceDeliveryAnchorValidator?: {
    validate(
      sourceDeliveryIds: readonly string[],
      context: McpMemoryToolCallContext
    ): Promise<void> | void;
  };
  // invariant: accept-apply uses the same object-anchor existence + ownership
  // gate as the path mint sink before storage writes a proposed_path_relation.
  // see also: packages/core/src/path-graph/path-relation-proposal-service.ts validateProposedObjectAnchors
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
  return createProposalWorkflowHandlers({ deps, now, generateObjectId });
}
