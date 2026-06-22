import {
  SignalKind,
  GardenClaimTaskRequestSchema,
  GardenCompleteTaskRequestSchema,
  GardenListPendingTasksRequestSchema,
  SoulApplyOverrideRequestSchema,
  SoulEmitCandidateSignalRequestSchema,
  SoulExploreGraphRequestSchema,
  SoulBatchReviewEdgeProposalsRequestSchema,
  SoulListPendingEdgeProposalsRequestSchema,
  SoulListPendingProposalsRequestSchema,
  SoulMemorySearchRequestSchema,
  SoulOpenPointerRequestSchema,
  SoulProposeEdgeRequestSchema,
  SoulProposeMemoryUpdateRequestSchema,
  SoulReportContextUsageRequestSchema,
  SoulResolveRequestSchema,
  SoulReviewMemoryProposalRequestSchema
} from "@do-soul/alaya-protocol";

export interface ProviderNeutralSchema<T = unknown> {
  parse(input: unknown): T;
}

export interface SoulToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: ProviderNeutralSchema;
}

const emitCandidateSignalDescription =
  "WHEN: you observe a new durable signal worth memorizing — a preference, decision, constraint, handoff, conflict, synthesis, or evidence anchor. Emit a candidate memory signal so the governance loop can promote it to a durable proposal. Optional source_delivery_ids must reference recorded recall deliveries in the current trusted context. Use first-class source_memory_refs, supersedes_refs, exception_to_refs, contradicts_refs, and incompatible_with_refs when the signal should propose graph edges; do not put those graph hints only in raw_payload. (Language-agnostic. 当你检测到需要记忆的偏好、决定、约束、冲突或证据时，请触发此工具)";

export const soulToolDefs: readonly SoulToolSpec[] = [
  {
    name: "soul.recall",
    description:
      "WHEN: at the start of any turn that may benefit from prior memory (user preferences, past decisions, project context, or any \"do you remember / last time / we agreed\" reference). Recall relevant durable memory for the current task. Returns ranked candidates, evidence pointers, and a delivery id for later usage proof. Optional time filter via `since` / `until` (ISO datetime) — useful for queries like \"what did I say on May 20\". Pass the user's latest message verbatim in `recent_turn` so Alaya passively extracts durable candidates from this turn — you do not have to file them yourself.",
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
      "WHEN: a candidate signal has matured into a concrete memory write you want governance to review. Submit a proposed durable memory update; this does not directly write durable memory. Optional source_delivery_ids must reference recorded recall deliveries in the current trusted context.",
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
    name: "soul.propose_edge",
    description:
      "WHEN: a human or attached agent wants to propose a memory graph relation for review. This creates a pending edge proposal only; it does not write durable memory. Accepted proposals mint a governed path relation.",
    parametersSchema: SoulProposeEdgeRequestSchema
  },
  {
    name: "soul.list_pending_edge_proposals",
    description:
      "WHEN: you need to inspect pending memory graph relation proposals before review. Read-only; filters by edge_type, confidence, trigger source, and time.",
    parametersSchema: SoulListPendingEdgeProposalsRequestSchema
  },
  {
    name: "soul.batch_review_edge_proposals",
    description:
      "WHEN: a reviewer has explicitly accepted or rejected pending edge proposals. Accepting mints a governed path relation through the path-relation service.",
    parametersSchema: SoulBatchReviewEdgeProposalsRequestSchema
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
      "WHEN: you need 1-hop graph neighbors of an existing memory entry to ground related context. Inspect memory path-relation neighbors. Read-only; does not create or mutate relations.",
    parametersSchema: SoulExploreGraphRequestSchema
  },
  {
    name: "soul.report_context_usage",
    description:
      "WHEN: you used recalled memory in your answer and need to close the delivery loop. Report whether recalled context for a delivery was used, skipped, or not applicable. Supports delivered-vs-used trust state. Usage trust weight is server-derived: a self-reported usage is always treated as automatic attribution and carries the lower path-plasticity weight. Include `turn_index` and `turn_digest.last_messages` (the turn's verbatim messages) so Alaya extracts durable candidates from this turn even when nothing was recalled.",
    parametersSchema: SoulReportContextUsageRequestSchema
  },
  {
    name: "soul.resolve",
    description:
      "WHEN: a recalled pointer carries a `staged_warnings` entry and you have decided how to handle it (confirm / reject / correct / stale / defer / not_relevant). Resolve a staged warning attached to a recall result. `confirm` activates a draft claim_form (draft -> active); `reject` archives a non-draft claim_form or records the dismissal for a memory_entry; `correct` records the corrected proposition (downstream consumers pick it up from the audit row); `stale` transitions an active memory_entry to dormant; `defer` creates a deferred obligation that expires at `defer_until`; `not_relevant` records the dismissal without mutating the target. delivery_id MUST be the same delivery_id soul.recall returned for the pointer being resolved.",
    parametersSchema: SoulResolveRequestSchema
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
