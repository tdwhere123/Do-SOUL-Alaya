import { describe, expect, it } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import {
  McpToolError,
  ToolNotFoundError,
  ToolUnavailableError,
  ToolValidationError,
  createWorkflowError
} from "../../../mcp-memory/tool/mcp-tool-error.js";
import { classifyError } from "../../../mcp-memory/tool/tool-handler-support.js";
import {
  GardenTaskNotFoundError,
  GardenTaskUnavailableError,
  GardenTaskValidationError
} from "../../../mcp-memory/garden-task/garden-task-handler-support.js";
import { SourceDeliveryAnchorValidationError } from
  "../../../mcp-memory/proposal/proposal-workflow-types.js";
import { SoulResolveScopeError } from "../../../mcp-memory/tool/resolve-handler.js";
import {
  ContextUsageNotFoundError,
  ContextUsageValidationError
} from "../../../mcp-memory/usage/recall-usage-object-validation.js";

describe("McpToolError", () => {
  it.each([
    [createWorkflowError("VALIDATION", "Invalid reviewer token."), "VALIDATION"],
    [new ToolValidationError("Invalid reviewer token."), "VALIDATION"],
    [new ToolUnavailableError("queue down"), "UNAVAILABLE"],
    [new ToolNotFoundError("Proposal not found."), "NOT_FOUND"],
    [createWorkflowError("NEEDS_CONTEXT", "need context"), "NEEDS_CONTEXT"],
    [new GardenTaskValidationError("bad garden task"), "VALIDATION"],
    [new GardenTaskUnavailableError("queue missing"), "UNAVAILABLE"],
    [new GardenTaskNotFoundError("missing task"), "NOT_FOUND"],
    [new SourceDeliveryAnchorValidationError("need validator"), "VALIDATION"],
    [new SoulResolveScopeError("VALIDATION", "out of scope"), "VALIDATION"],
    [new SoulResolveScopeError("NEEDS_CONTEXT", "wrong agent"), "NEEDS_CONTEXT"],
    [new ContextUsageValidationError("bad usage"), "VALIDATION"],
    [new ContextUsageNotFoundError("missing memory"), "NOT_FOUND"]
  ] as const)("classifyError(%s) maps instanceof to the protocol code", (error, code) => {
    expect(error).toBeInstanceOf(McpToolError);
    expect(classifyError(error)).toBe(code);
  });

  it("does not classify a duck-typed code as a tool error", () => {
    const error = Object.assign(new Error("spoof"), { code: "VALIDATION" });
    expect(classifyError(error)).toBe("INTERNAL");
  });

  it("classifies CoreError VALIDATION and NOT_FOUND by instanceof AlayaError", () => {
    expect(classifyError(new CoreError("VALIDATION", "denied by policy"))).toBe("VALIDATION");
    expect(classifyError(new CoreError("NOT_FOUND", "missing"))).toBe("NOT_FOUND");
    expect(classifyError(new CoreError("CONFLICT", "lost race"))).toBe("INTERNAL");
  });
});
