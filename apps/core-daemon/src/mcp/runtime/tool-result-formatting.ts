import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type McpRuntimeCallResult = Awaited<ReturnType<Client["callTool"]>>;

export function formatMcpToolResult(result: McpRuntimeCallResult): unknown {
  const content = readMcpToolResultContent(result);
  const structuredContent = readMcpToolStructuredContent(result);
  if (readMcpToolIsError(result)) {
    return {
      ok: false,
      code: "MCP_TOOL_ERROR",
      message: readMcpToolErrorMessage(content),
      content,
      ...(structuredContent === undefined ? {} : { structuredContent })
    };
  }
  return { content, ...(structuredContent === undefined ? {} : { structuredContent }) };
}

function readMcpToolResultContent(result: McpRuntimeCallResult): unknown {
  if ("content" in result) {
    return result.content;
  }

  return result.toolResult;
}

function readMcpToolStructuredContent(result: McpRuntimeCallResult): unknown {
  return "structuredContent" in result ? result.structuredContent : undefined;
}

function readMcpToolIsError(result: McpRuntimeCallResult): boolean {
  return "isError" in result && result.isError === true;
}

function readMcpToolErrorMessage(content: unknown): string {
  if (!Array.isArray(content)) {
    return "MCP tool call failed.";
  }

  for (const item of content) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }

    const text = (item as { readonly text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text;
    }
  }

  return "MCP tool call failed.";
}
