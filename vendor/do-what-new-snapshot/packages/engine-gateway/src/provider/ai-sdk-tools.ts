import { tool, zodSchema, type Tool } from "ai";

type SupportedZodSchema = Parameters<typeof zodSchema>[0];

export interface AiSdkToolDef {
  readonly name: string;
  readonly description: string;
  readonly parametersSchema: SupportedZodSchema;
}

export function buildAiSdkTools(toolDefs: readonly AiSdkToolDef[]): Record<string, Tool> {
  const tools: Record<string, Tool> = {};

  for (const toolDef of toolDefs) {
    tools[toolDef.name] = tool({
      description: toolDef.description,
      inputSchema: toolDef.parametersSchema,
      execute: async (args, { toolCallId }) => ({ __stub: true, toolCallId, args })
    });
  }

  return tools;
}
