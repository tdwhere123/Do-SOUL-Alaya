import { soulToolJsonSchemas } from "@do-soul/alaya-protocol";

export const ALAYA_MEMORY_TOOL_NAMES = Object.freeze([
  "soul.recall",
  "soul.open_pointer",
  "soul.emit_candidate_signal",
  "soul.propose_memory_update",
  "soul.review_memory_proposal",
  "soul.list_pending_proposals",
  "soul.apply_override",
  "soul.explore_graph",
  "soul.report_context_usage"
] as const);

export type AlayaMemoryToolName = (typeof ALAYA_MEMORY_TOOL_NAMES)[number];

/**
 * MCP tool input schema. Derived from `@do-soul/alaya-protocol`
 * `soulToolJsonSchemas` (zod → JSON Schema, p5-system-review-r3 MR-I04)
 * so external clients see the exact same bounds the runtime enforces.
 */
export type JsonObjectSchema = Readonly<Record<string, unknown>>;

export interface AlayaMemoryToolDefinition {
  readonly name: AlayaMemoryToolName;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly annotations: Readonly<{
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  }>;
}

const descriptionByName: Readonly<Record<AlayaMemoryToolName, string>> = Object.freeze({
  "soul.recall":
    "Recall relevant durable memory for the current task. Returns ranked candidates, evidence pointers, and a delivery id for later usage proof.",
  "soul.open_pointer":
    "Open a recalled memory object or evidence pointer by id. Read-only; use before citing recalled context in model output.",
  "soul.emit_candidate_signal":
    "Emit a candidate memory signal when you detect a durable preference, decision, constraint, handoff, conflict, synthesis, or evidence anchor worth tracking. (This tool is language-agnostic. For Chinese inputs: 当你检测到需要记忆的偏好、决定、约束、冲突或证据时，请触发此工具)",
  "soul.propose_memory_update":
    "Submit a proposed durable memory update for governance review. This does not directly write durable memory.",
  "soul.review_memory_proposal":
    "Accept or reject a pending memory proposal while preserving an explicit governance trace. Requires reviewer_identity so the review record names who approved or rejected the change.",
  "soul.list_pending_proposals":
    "List proposals in the pending state for a workspace. Read-only; use before soul.review_memory_proposal so the agent can present a current queue to the human reviewer.",
  "soul.apply_override":
    "Apply an immediate session-only correction when the user explicitly says the current assumption/tool/behavior is wrong and should be replaced for this run.",
  "soul.explore_graph":
    "Inspect one-hop memory graph neighbors for an existing memory entry. Read-only; does not create or mutate edges.",
  "soul.report_context_usage":
    "Report whether recalled context for a delivery was used, skipped, or not applicable. Supports delivered-vs-used trust state."
});

const readOnlyAnnotation = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});

const writeAnnotation = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});

const annotationByToolName: Record<AlayaMemoryToolName, AlayaMemoryToolDefinition["annotations"]> =
  Object.freeze({
    "soul.recall": readOnlyAnnotation,
    "soul.open_pointer": readOnlyAnnotation,
    "soul.emit_candidate_signal": writeAnnotation,
    "soul.propose_memory_update": writeAnnotation,
    "soul.review_memory_proposal": writeAnnotation,
    "soul.list_pending_proposals": readOnlyAnnotation,
    "soul.apply_override": writeAnnotation,
    "soul.explore_graph": readOnlyAnnotation,
    "soul.report_context_usage": writeAnnotation
  });

export function listAlayaMemoryTools(): readonly AlayaMemoryToolDefinition[] {
  return ALAYA_MEMORY_TOOL_NAMES.map((name) =>
    Object.freeze({
      name,
      description: descriptionByName[name],
      inputSchema: soulToolJsonSchemas[name],
      annotations: annotationByToolName[name]
    })
  );
}

export function hasAlayaMemoryToolName(value: string): value is AlayaMemoryToolName {
  return (ALAYA_MEMORY_TOOL_NAMES as readonly string[]).includes(value);
}
