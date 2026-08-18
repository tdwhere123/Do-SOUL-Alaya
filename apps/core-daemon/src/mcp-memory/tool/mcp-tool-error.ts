import type { McpMemoryToolErrorCode } from "./tool-handler-types.js";

export type McpToolWorkflowErrorCode = Extract<
  McpMemoryToolErrorCode,
  "NOT_FOUND" | "VALIDATION" | "NEEDS_CONTEXT" | "UNAVAILABLE"
>;

export class McpToolError extends Error {
  public readonly code: McpMemoryToolErrorCode;

  public constructor(code: McpMemoryToolErrorCode, message: string) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
  }
}

export function createWorkflowError(
  code: McpToolWorkflowErrorCode,
  message: string
): McpToolError {
  return new McpToolError(code, message);
}

export class ToolValidationError extends McpToolError {
  public constructor(message: string) {
    super("VALIDATION", message);
    this.name = "ToolValidationError";
  }
}

export class ToolUnavailableError extends McpToolError {
  public constructor(message: string) {
    super("UNAVAILABLE", message);
    this.name = "ToolUnavailableError";
  }
}

export class ToolNotFoundError extends McpToolError {
  public constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "ToolNotFoundError";
  }
}
