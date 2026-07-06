import type { ToolSpec } from "@do-soul/alaya-protocol";

const READ_FILE_TOOL_SPEC: Readonly<ToolSpec> = Object.freeze({
  tool_id: "tools.read_file",
  category: "read",
  description: "Read the content of a single file within the workspace boundary.",
  scope_guard: "workspace",
  read_only: true,
  destructive: false,
  concurrency_safe: true,
  interrupt_behavior: "continue",
  requires_confirmation: false,
  requires_evidence_reopen: false,
  rollback_support: "none",
  fast_path_eligible: true
});

const LIST_DIRECTORY_TOOL_SPEC: Readonly<ToolSpec> = Object.freeze({
  tool_id: "tools.list_directory",
  category: "read",
  description: "List the immediate contents of a directory within the workspace boundary.",
  scope_guard: "workspace",
  read_only: true,
  destructive: false,
  concurrency_safe: true,
  interrupt_behavior: "continue",
  requires_confirmation: false,
  requires_evidence_reopen: false,
  rollback_support: "none",
  fast_path_eligible: true
});

const SEARCH_FILES_TOOL_SPEC: Readonly<ToolSpec> = Object.freeze({
  tool_id: "tools.search_files",
  category: "read",
  description: "Search for files matching a glob pattern within the workspace boundary.",
  scope_guard: "workspace",
  read_only: true,
  destructive: false,
  concurrency_safe: true,
  interrupt_behavior: "continue",
  requires_confirmation: false,
  requires_evidence_reopen: false,
  rollback_support: "none",
  fast_path_eligible: true
});

const WRITE_FILE_TOOL_SPEC: Readonly<ToolSpec> = Object.freeze({
  tool_id: "tools.write_file",
  category: "write",
  description:
    "Write content to a file within the workspace boundary. Creates the file if it does not exist; overwrites if it does. Parent directory must already exist.",
  scope_guard: "workspace",
  read_only: false,
  destructive: false,
  concurrency_safe: false,
  interrupt_behavior: "wait",
  requires_confirmation: false,
  requires_evidence_reopen: false,
  rollback_support: "best_effort",
  fast_path_eligible: false
});

const EXEC_SHELL_TOOL_SPEC: Readonly<ToolSpec> = Object.freeze({
  tool_id: "tools.exec_shell",
  category: "exec",
  description:
    "Execute a shell command within the project boundary. Always requires explicit user approval before execution. Destructive operations are subject to circuit-breaker posture escalation.",
  scope_guard: "project",
  read_only: false,
  destructive: true,
  concurrency_safe: false,
  interrupt_behavior: "abort",
  requires_confirmation: true,
  requires_evidence_reopen: false,
  rollback_support: "none",
  fast_path_eligible: false
});

const BUILTIN_CONVERSATION_TOOL_SPECS: readonly Readonly<ToolSpec>[] = Object.freeze([
  READ_FILE_TOOL_SPEC,
  LIST_DIRECTORY_TOOL_SPEC,
  SEARCH_FILES_TOOL_SPEC,
  WRITE_FILE_TOOL_SPEC,
  EXEC_SHELL_TOOL_SPEC
]);
const BUILTIN_CONVERSATION_TOOL_IDS = Object.freeze([
  READ_FILE_TOOL_SPEC.tool_id,
  LIST_DIRECTORY_TOOL_SPEC.tool_id,
  SEARCH_FILES_TOOL_SPEC.tool_id,
  WRITE_FILE_TOOL_SPEC.tool_id,
  EXEC_SHELL_TOOL_SPEC.tool_id
] as const);
const BUILTIN_CONVERSATION_TOOL_ID_LOOKUP = new Set<string>(BUILTIN_CONVERSATION_TOOL_IDS);

export type BuiltinConversationToolId = (typeof BUILTIN_CONVERSATION_TOOL_IDS)[number];

export function getBuiltinConversationToolSpecs(): readonly ToolSpec[] {
  return Object.freeze(BUILTIN_CONVERSATION_TOOL_SPECS.map((spec) => ({ ...spec })));
}

export function isBuiltinConversationToolId(
  toolId: string | null | undefined
): toolId is BuiltinConversationToolId {
  return typeof toolId === "string" && BUILTIN_CONVERSATION_TOOL_ID_LOOKUP.has(toolId);
}

export function builtinConversationToolRequiresConfirmation(
  toolId: string | null | undefined
): boolean {
  if (!isBuiltinConversationToolId(toolId)) {
    return false;
  }

  return BUILTIN_CONVERSATION_TOOL_SPECS.some(
    (spec) => spec.tool_id === toolId && spec.requires_confirmation
  );
}
