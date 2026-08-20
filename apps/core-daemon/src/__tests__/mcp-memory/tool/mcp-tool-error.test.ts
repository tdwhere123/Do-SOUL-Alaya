import { describe, expect, it } from "vitest";
import {
  McpToolError,
  ToolNotFoundError,
  ToolValidationError,
  createWorkflowError
} from "../../../mcp-memory/tool/mcp-tool-error.js";
import { classifyError } from "../../../mcp-memory/tool/tool-handler-support.js";

describe("McpToolError", () => {
  it("is the single factory for workflow and tool validation failures", () => {
    const workflow = createWorkflowError("VALIDATION", "Invalid reviewer token.");
    const validation = new ToolValidationError("Invalid reviewer token.");
    const missing = new ToolNotFoundError("Proposal not found.");

    expect(workflow).toBeInstanceOf(McpToolError);
    expect(validation).toBeInstanceOf(McpToolError);
    expect(missing).toBeInstanceOf(McpToolError);
    expect(classifyError(workflow)).toBe("VALIDATION");
    expect(classifyError(validation)).toBe("VALIDATION");
    expect(classifyError(missing)).toBe("NOT_FOUND");
    expect(classifyError(createWorkflowError("NEEDS_CONTEXT", "need context"))).toBe(
      "NEEDS_CONTEXT"
    );
  });
});
