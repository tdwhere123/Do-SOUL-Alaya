import { type ConversationRuntimeContext, type ToolUseBlock } from "@do-what/protocol";
import { soulToolDefs } from "./provider/soul-tool-specs.js";

export interface McpToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export interface McpBridgeDependencies {
  readonly soulHandler: (
    toolUse: ToolUseBlock,
    runtimeContext?: Readonly<ConversationRuntimeContext>
  ) => Promise<McpToolResultBlock>;
  readonly toolsHandler?: (
    toolUse: ToolUseBlock,
    runtimeContext?: Readonly<ConversationRuntimeContext>
  ) => Promise<McpToolResultBlock>;
  readonly hasConversationToolName?: (toolName: string) => boolean;
}

export class McpBridge {
  private readonly toolsHandler: (
    toolUse: ToolUseBlock,
    runtimeContext?: Readonly<ConversationRuntimeContext>
  ) => Promise<McpToolResultBlock>;
  private readonly hasConversationToolName: (toolName: string) => boolean;

  public constructor(private readonly dependencies: McpBridgeDependencies) {
    this.toolsHandler =
      dependencies.toolsHandler ??
      (async (toolUse) =>
        createErrorResult(toolUse.id, "tools.* is not implemented during Phase 0.5"));
    this.hasConversationToolName = dependencies.hasConversationToolName ?? (() => false);
  }

  public async executeToolUse(
    toolUse: ToolUseBlock,
    runtimeContext?: Readonly<ConversationRuntimeContext>
  ): Promise<McpToolResultBlock> {
    try {
      if (toolUse.name.startsWith("soul.")) {
        if (!Object.hasOwn(allowedSoulToolNames, toolUse.name)) {
          return createErrorResult(toolUse.id, "unsupported tool");
        }
        return await this.dependencies.soulHandler(toolUse, runtimeContext);
      }

      if (this.hasConversationToolName(toolUse.name)) {
        return await this.toolsHandler(toolUse, runtimeContext);
      }

      if (toolUse.name.startsWith("tools.")) {
        return createErrorResult(toolUse.id, "unsupported tool");
      }

      return createErrorResult(toolUse.id, `Unknown MCP namespace for tool ${toolUse.name}`);
    } catch (error) {
      return createErrorResult(toolUse.id, readErrorMessage(error));
    }
  }

  public async executeToolUses(
    toolUses: readonly ToolUseBlock[],
    runtimeContext?: Readonly<ConversationRuntimeContext>
  ): Promise<readonly McpToolResultBlock[]> {
    return await Promise.all(
      toolUses.map(async (toolUse) => await this.executeToolUse(toolUse, runtimeContext))
    );
  }
}

const allowedSoulToolNames = createStringLookup(soulToolDefs.map((toolDef) => toolDef.name));

function createErrorResult(toolUseId: string, message: string | Record<string, string | number | boolean | null>): McpToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify({ error: message }),
    is_error: true
  };
}

function readErrorMessage(
  error: unknown
): string | Record<string, string | number | boolean | null> {
  if (isStructuredValidationError(error)) {
    return Object.fromEntries(
      Object.entries(error).filter(([, value]) => isStructuredValidationValue(value))
    ) as Record<string, string | number | boolean | null>;
  }

  return "MCP tool execution failed.";
}

function isStructuredValidationError(
  error: unknown
): error is Record<string, string | number | boolean | null> {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }

  const record = error as Record<string, unknown>;
  return typeof record["error_code"] === "string" && Object.values(record).every(isStructuredValidationValue);
}

function isStructuredValidationValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function createStringLookup(values: readonly string[]): Readonly<Record<string, true>> {
  const lookup: Record<string, true> = {};
  for (const value of values) {
    lookup[value] = true;
  }

  return Object.freeze(lookup);
}
