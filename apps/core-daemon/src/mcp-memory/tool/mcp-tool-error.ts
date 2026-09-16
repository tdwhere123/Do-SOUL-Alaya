import { AlayaError, type AlayaErrorOptions } from "@do-soul/alaya-protocol";
import type { McpMemoryToolErrorCode } from "./tool-handler-types.js";

export type McpToolWorkflowErrorCode = Extract<
  McpMemoryToolErrorCode,
  "NOT_FOUND" | "VALIDATION" | "NEEDS_CONTEXT" | "UNAVAILABLE"
>;

const MCP_TOOL_ERROR_BRAND = Symbol.for("do-soul.alaya.McpToolError");

export class McpToolError extends AlayaError {
  declare public readonly code: McpMemoryToolErrorCode;
  public readonly [MCP_TOOL_ERROR_BRAND] = true as const;

  public constructor(code: McpMemoryToolErrorCode, message: string, options?: AlayaErrorOptions) {
    super(code, message, options);
    this.name = "McpToolError";
    Object.setPrototypeOf(this, new.target.prototype);
  }

  // Brand is Symbol.for, so instanceof still holds across src/dist copies.
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && MCP_TOOL_ERROR_BRAND in value;
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
