import {
  SignalKind,
  SoulApplyOverrideRequestSchema,
  SoulEmitCandidateSignalRequestSchema,
  SoulExploreGraphRequestSchema
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
    name: "soul.emit_candidate_signal",
    description: emitCandidateSignalDescription,
    parametersSchema: SoulEmitCandidateSignalRequestSchema
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
  }
];

export function readSignalKindCount(): number {
  return Object.values(SignalKind).length;
}
