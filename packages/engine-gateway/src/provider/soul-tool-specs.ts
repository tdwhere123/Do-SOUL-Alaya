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
  "WHEN: you observe a new durable signal worth memorizing — a preference, decision, constraint, handoff, conflict, synthesis, or evidence anchor. Emit a candidate memory signal so the governance loop can promote it to a durable proposal. (Language-agnostic. 当你检测到需要记忆的偏好、决定、约束、冲突或证据时，请触发此工具)";

export const soulToolDefs: readonly SoulToolSpec[] = [
  {
    name: "soul.recall",
    description:
      "WHEN: at the start of any turn that may benefit from prior memory (user preferences, past decisions, project context, or any \"do you remember / last time / we agreed\" reference). Recall relevant durable memory for the current task. Returns ranked candidates, evidence pointers, and a delivery id for later usage proof. Optional time filter via `since` / `until` (ISO datetime) — useful for queries like \"what did I say on May 20\".",
    parametersSchema: SoulMemorySearchRequestSchema
  },
  {
    name: "soul.open_pointer",
    description:
      "WHEN: a recall result preview is insufficient and you need the full content before citing it. Open a recalled memory object or evidence pointer by id. Read-only.",
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
      "WHEN: a candidate signal has matured into a concrete memory write you want governance to review. Submit a proposed durable memory update; this does not directly write durable memory.",
    parametersSchema: SoulProposeMemoryUpdateRequestSchema
  },
  {
    name: "soul.review_memory_proposal",
    description:
      "WHEN: a human reviewer has explicitly approved or rejected a pending proposal and you need to record their decision. Accept or reject a pending memory proposal while preserving an explicit governance trace. Requires reviewer_identity so the review record names who approved or rejected the change.",
    parametersSchema: SoulReviewMemoryProposalRequestSchema
  },
  {
    name: "soul.list_pending_proposals",
    description:
      "WHEN: you need to present the pending governance queue to the reviewer (read-only) before calling soul.review_memory_proposal. List proposals in the pending state for a workspace.",
    parametersSchema: SoulListPendingProposalsRequestSchema
  },
  {
    name: "soul.apply_override",
    description:
      "WHEN: the user explicitly says the current assumption, tool, or behavior is wrong and must be replaced for this run. Apply an immediate session-only correction.",
    parametersSchema: SoulApplyOverrideRequestSchema
  },
  {
    name: "soul.explore_graph",
    description:
      "WHEN: you need 1-hop graph neighbors of an existing memory entry to ground related context. Inspect memory graph neighbors. Read-only; does not create or mutate edges.",
    parametersSchema: SoulExploreGraphRequestSchema
  },
  {
    name: "soul.report_context_usage",
    description:
      "WHEN: you used recalled memory in your answer and need to close the delivery loop. Report whether recalled context for a delivery was used, skipped, or not applicable. Supports delivered-vs-used trust state.",
    parametersSchema: SoulReportContextUsageRequestSchema
  },
  {
    name: "garden.list_pending_tasks",
    description:
      "WHEN: you have spare capacity (idle between user turns, or operator asks to flush the garden queue) and the operator has set garden compute provider_kind=host_worker so the host CLI agent is the worker. List Garden background tasks pending for this workspace. Read-only. Use before garden.claim_task to scope what work the host can pick up. (当 garden compute 模式为 host_worker 时，CLI agent 在空闲间隙先 list 再 claim 抢任务)",
    parametersSchema: GardenListPendingTasksRequestSchema
  },
  {
    name: "garden.claim_task",
    description:
      "WHEN: a pending Garden task should be picked up by this host (atomic claim). Returns already_claimed when another worker already grabbed it. The host (Codex / Claude Code / similar attached CLI agent) then runs its own sub-agent extraction on the task payload and posts the result back via garden.complete_task. Abandoned claims are reclaimed automatically after a stale timeout, so don't claim more than you'll actually run.",
    parametersSchema: GardenClaimTaskRequestSchema
  },
  {
    name: "garden.complete_task",
    description:
      "WHEN: the host finished its task work and is reporting the result back. Only the agent target that claimed the task can complete it. Candidate signals in the result_envelope flow into the same governance review queue host agents use via soul.emit_candidate_signal — they are NOT durable memory writes.",
    parametersSchema: GardenCompleteTaskRequestSchema
  }
];

export function readSignalKindCount(): number {
  return Object.values(SignalKind).length;
}
