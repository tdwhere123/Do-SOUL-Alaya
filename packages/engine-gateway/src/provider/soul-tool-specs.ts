import {
  SignalKind,
  SoulApplyOverrideRequestSchema,
  SoulEmitCandidateSignalRequestSchema,
  SoulExploreGraphRequestSchema,
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
      "Accept or reject a pending memory proposal while preserving an explicit governance trace.",
    parametersSchema: SoulReviewMemoryProposalRequestSchema
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
  }
];

export function readSignalKindCount(): number {
  return Object.values(SignalKind).length;
}
