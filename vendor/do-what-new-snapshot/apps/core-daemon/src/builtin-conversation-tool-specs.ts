import type { ToolSpec } from "@do-what/protocol";
import {
  EXEC_SHELL_TOOL_SPEC,
  LIST_DIRECTORY_TOOL_SPEC,
  READ_FILE_TOOL_SPEC,
  SEARCH_FILES_TOOL_SPEC,
  WRITE_FILE_TOOL_SPEC
} from "@do-what/engine-gateway";

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
