import { type ConversationRuntimeContext, type ToolUseBlock } from "@do-soul/alaya-protocol";
import { soulToolDefs } from "../provider/soul-tool-specs.js";
import { withTimeout } from "./with-timeout.js";

const DEFAULT_TOOL_TIMEOUT_MS = 30000;

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
    // invariant: production always injects a toolsHandler; this default is only
    // reachable in a misconfigured embedding (a hasConversationToolName that
    // matches with no handler injected). Fail loud with a configuration error
    // instead of pretending the call is unsupported.
    this.toolsHandler =
      dependencies.toolsHandler ??
      (async (toolUse) =>
        createErrorResult(
          toolUse.id,
          "no tools handler injected for this MCP bridge"
        ));
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
        // Signal passed for future abort-aware handlers; withTimeout already
        // suppresses a late reject so a timed-out handler cannot crash the daemon.
        return await withTimeout(
          (_signal) => this.dependencies.soulHandler(toolUse, runtimeContext),
          resolveTimeoutMs()
        );
      }

      if (this.hasConversationToolName(toolUse.name)) {
        return await withTimeout(
          (_signal) => this.toolsHandler(toolUse, runtimeContext),
          resolveTimeoutMs()
        );
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

function resolveTimeoutMs(): number {
  const raw = process.env["ALAYA_MCP_TOOL_TIMEOUT_MS"];
  if (raw === undefined) {
    return DEFAULT_TOOL_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_TIMEOUT_MS;
}

function createErrorResult(
  toolUseId: string,
  message: string | Record<string, string | number | boolean | null>
): McpToolResultBlock {
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

  return {
    error_code: "handler_exception",
    message: "MCP tool execution failed.",
    error_type: error instanceof Error ? error.name : typeof error
  };
}

function isStructuredValidationError(
  error: unknown
): error is Record<string, string | number | boolean | null> {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }

  const record = error as Record<string, unknown>;
  return (
    typeof record["error_code"] === "string" &&
    Object.values(record).every(isStructuredValidationValue)
  );
}

function isStructuredValidationValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function createStringLookup(values: readonly string[]): Readonly<Record<string, true>> {
  const lookup: Record<string, true> = {};
  for (const value of values) {
    lookup[value] = true;
  }

  return Object.freeze(lookup);
}
