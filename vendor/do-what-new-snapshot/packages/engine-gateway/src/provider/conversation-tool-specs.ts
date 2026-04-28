import {
  ExecShellToolInputSchema,
  ListDirectoryToolInputSchema,
  ReadFileToolInputSchema,
  SearchFilesToolInputSchema,
  WriteFileToolInputSchema,
  type FileToolName
} from "@do-what/protocol";
import type { ToolSpec } from "@do-what/protocol";
import type { AiSdkToolDef } from "./ai-sdk-tools.js";

type ConversationToolInputSchema =
  | typeof ReadFileToolInputSchema
  | typeof ListDirectoryToolInputSchema
  | typeof SearchFilesToolInputSchema
  | typeof WriteFileToolInputSchema
  | typeof ExecShellToolInputSchema;

const conversationToolInputSchemas = {
  "tools.read_file": ReadFileToolInputSchema,
  "tools.list_directory": ListDirectoryToolInputSchema,
  "tools.search_files": SearchFilesToolInputSchema,
  "tools.write_file": WriteFileToolInputSchema,
  "tools.exec_shell": ExecShellToolInputSchema
} satisfies Readonly<Record<FileToolName, ConversationToolInputSchema>>;

const fallbackToolInputSchema = ReadFileToolInputSchema.partial().passthrough();
type ConversationToolId = keyof typeof conversationToolInputSchemas;

export function buildConversationToolDefs(
  toolSpecs: readonly Readonly<ToolSpec>[]
): readonly AiSdkToolDef[] {
  return toolSpecs.map((toolSpec) => ({
    name: toolSpec.tool_id,
    description: toolSpec.description,
    parametersSchema: resolveConversationToolInputSchema(toolSpec.tool_id)
  }));
}

function resolveConversationToolInputSchema(toolId: string) {
  return hasConversationToolInputSchema(toolId)
    ? conversationToolInputSchemas[toolId]
    : fallbackToolInputSchema;
}

function hasConversationToolInputSchema(toolId: string): toolId is ConversationToolId {
  return Object.prototype.hasOwnProperty.call(conversationToolInputSchemas, toolId);
}
