import {
  SignalKind,
  GardenClaimTaskRequestSchema,
  GardenCompleteTaskRequestSchema,
  GardenListPendingTasksRequestSchema,
  SoulApplyOverrideRequestSchema,
  SoulEmitCandidateSignalRequestSchema,
  SoulExploreGraphRequestSchema,
  SoulListPendingProposalsRequestSchema,
  SoulMemorySearchRequestSchema,
  SoulOpenPointerRequestSchema,
  SoulProposeMemoryUpdateRequestSchema,
  SoulReportContextUsageRequestSchema,
  SoulReviewMemoryProposalRequestSchema
} from "@do-soul/alaya-protocol";

export interface ProviderNeutralSchema {
  parse(input: unknown): unknown;
}

export interface SoulToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: ProviderNeutralSchema;
}

const emitCandidateSignalDescription =
  "Emit a candidate memory signal when you detect a durable preference, decision, constraint, handoff, conflict, synthesis, or evidence anchor worth tracking. (This tool is language-agnostic. For Chinese inputs: 当你检测到需要记忆的偏好、决定、约束、冲突或证据时，请触发此工具)";

export const soulToolDefs: readonly SoulToolSpec[] = [
  {
    name: "soul.recall",
    description:
      "Recall relevant durable memory for the current task. Returns ranked candidates, evidence pointers, and a delivery id for later usage proof.",
    parametersSchema: SoulMemorySearchRequestSchema
  },
  {
    name: "soul.open_pointer",
    description:
      "Open a recalled memory object or evidence pointer by id. Read-only; use before citing recalled context in model output.",
    parametersSchema: SoulOpenPointerRequestSchema
  },
  {
    name: "soul.emit_candidate_signal",
    description: emitCandidateSignalDescription,
    parametersSchema: SoulEmitCandidateSignalRequestSchema
  },
  {
    name: "soul.propose_memory_update",
    description:
      "Submit a proposed durable memory update for governance review. This does not directly write durable memory.",
    parametersSchema: SoulProposeMemoryUpdateRequestSchema
  },
  {
    name: "soul.review_memory_proposal",
    description:
      "Accept or reject a pending memory proposal while preserving an explicit governance trace. Requires reviewer_identity so the review record names who approved or rejected the change.",
    parametersSchema: SoulReviewMemoryProposalRequestSchema
  },
  {
    name: "soul.list_pending_proposals",
    description:
      "List proposals in the pending state for a workspace. Read-only; use before soul.review_memory_proposal so the agent can present a current queue to the human reviewer.",
    parametersSchema: SoulListPendingProposalsRequestSchema
  },
  {
    name: "soul.apply_override",
    description:
      "Apply an immediate session-only correction when the user explicitly says the current assumption/tool/behavior is wrong and should be replaced for this run.",
    parametersSchema: SoulApplyOverrideRequestSchema
  },
  {
    name: "soul.explore_graph",
    description:
      "Inspect one-hop memory graph neighbors for an existing memory entry. Read-only; does not create or mutate edges.",
    parametersSchema: SoulExploreGraphRequestSchema
  },
  {
    name: "soul.report_context_usage",
    description:
      "Report whether recalled context for a delivery was used, skipped, or not applicable. Supports delivered-vs-used trust state.",
    parametersSchema: SoulReportContextUsageRequestSchema
  },
  {
    name: "garden.list_pending_tasks",
    description:
      "List Garden background tasks pending in this workspace. Read-only. Use before garden.claim_task to scope what work the host can pick up.",
    parametersSchema: GardenListPendingTasksRequestSchema
  },
  {
    name: "garden.claim_task",
    description:
      "Atomically claim a Garden task by id so the host (Codex / Claude Code) can run its own sub-agent extraction and post the result back. Returns already_claimed when another worker already grabbed it.",
    parametersSchema: GardenClaimTaskRequestSchema
  },
  {
    name: "garden.complete_task",
    description:
      "Submit the host's task result. Candidate signals in the result envelope flow into the same review queue host agents use via soul.emit_candidate_signal.",
    parametersSchema: GardenCompleteTaskRequestSchema
  }
];

export function readSignalKindCount(): number {
  return Object.values(SignalKind).length;
}
