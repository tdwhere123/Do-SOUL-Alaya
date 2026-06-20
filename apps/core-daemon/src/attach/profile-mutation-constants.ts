import { soulToolDefs } from "@do-soul/alaya-engine-gateway";

export const SUPPORTED_PROFILE_TARGETS = Object.freeze(["codex", "claude-code"] as const);
export const ALAYA_SLASH_ALIAS = "/alaya-inspect";
export const ALAYA_LEGACY_SLASH_COMMAND = "alaya inspect --open";
export const ALAYA_MCP_COMMAND = "alaya";
export const ALAYA_MCP_ARGS = Object.freeze(["mcp", "stdio"] as const);
export const ALAYA_SLASH_ARGS = Object.freeze(["inspect", "--open"] as const);
export const PROFILE_MUTATION_CONFIRM_PROMPT = "Apply profile mutation changes? [y/N] ";
export const PUBLIC_SOUL_TOOL_NAMES = Object.freeze(soulToolDefs.map((toolDef) => toolDef.name));

export const ALAYA_OPERATOR_INSTRUCTIONS = [
  "This server is tools-only for soul.* memory operations; do not expect MCP prompts/resources.",
  `Use only these public SOUL memory tools: ${PUBLIC_SOUL_TOOL_NAMES.join(", ")}.`,
  "START every memory-sensitive turn by calling soul.recall BEFORE answering.",
  "You SHOULD call soul.recall when the user message touches: personal preferences, working style, or past corrections; prior decisions, architecture choices, or project context; or any \"do you remember / last time / we agreed\" reference.",
  "Workflow: soul.recall -> soul.open_pointer (only if the preview is insufficient) -> answer -> soul.report_context_usage.",
  "When you detect possible durable memory, call soul.emit_candidate_signal first; signal emission is candidate-only and not durable by itself.",
  "For durable edits, call soul.propose_memory_update, then soul.list_pending_proposals and soul.review_memory_proposal with explicit reviewer approval.",
  "When the operator has set Garden compute provider_kind=host_worker and you have spare capacity, optionally call garden.list_pending_tasks, then garden.claim_task, then garden.complete_task. If provider_kind is not host_worker, do not claim Garden work.",
  "Accepted proposals trigger durable-memory apply; rejected proposals keep durable memory unchanged."
].join(" ");
