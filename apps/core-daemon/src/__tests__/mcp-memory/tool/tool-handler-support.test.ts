import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PUBLIC_ERROR_CODE_MESSAGES } from "@do-soul/alaya-protocol";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import {
  McpToolError,
  ToolValidationError,
  classifyError,
  fail,
  sanitizeError
} from "../../../mcp-memory/tool/tool-handler-support.js";
import { context, createDeps } from "./mcp-memory-tool-handler-fixture.js";

describe("sanitizeError", () => {
  it("does not leak Zod received values or raw Error.message", () => {
    const secret = "sk-test-leaked-secret";
    const zodLike = Object.assign(new Error(`Invalid input: received "${secret}"`), { name: "ZodError" });
    const zodMessage = sanitizeError(zodLike);
    expect(zodMessage).toBe(PUBLIC_ERROR_CODE_MESSAGES.VALIDATION);
    expect(zodMessage).not.toContain(secret);
    expect(zodMessage).not.toContain("received");
    let parsedZod: unknown;
    try {
      z.number().parse(secret);
    } catch (error) {
      parsedZod = error;
    }
    expect(sanitizeError(parsedZod)).toBe(PUBLIC_ERROR_CODE_MESSAGES.VALIDATION);
    expect(sanitizeError(parsedZod)).not.toContain(secret);

    expect(sanitizeError(new Error(`upstream failed: ${secret}`))).toBe(PUBLIC_ERROR_CODE_MESSAGES.INTERNAL);
    expect(sanitizeError(new Error(`upstream failed: ${secret}`))).not.toContain(secret);
    expect(sanitizeError(new ToolValidationError("Invalid reviewer token."))).toBe("Invalid reviewer token.");
    expect(sanitizeError(new McpToolError("NOT_FOUND", `Proposal not found: ${secret}`))).toBe(
      "Proposal not found."
    );
  });

  it("maps MCP handler Zod failures to catalog copy", async () => {
    const secret = "sk-test-leaked-secret";
    const handler = createMcpMemoryToolHandler(createDeps());
    const result = await handler.call({
      toolName: "soul.recall",
      arguments: {
        protocol_version: 1,
        supported_result_kinds: ["memory_entry", "source_evidence"],
        supports_source_evidence: true,
        supports_product_updates: true,
        query: "deployment rules",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: secret
      },
      context
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toBe(PUBLIC_ERROR_CODE_MESSAGES.VALIDATION);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("received");
  });

  it("classifies Zod errors as VALIDATION and unknown tools as catalog UNKNOWN_TOOL", () => {
    let classified: unknown;
    try {
      z.number().parse("not-a-number");
    } catch (error) {
      classified = error;
    }
    expect(classifyError(classified)).toBe("VALIDATION");
    const unknown = fail("not.a.tool", "UNKNOWN_TOOL", "Unsupported Alaya memory tool: not.a.tool");
    expect(unknown).toEqual({
      ok: false,
      tool_name: "not.a.tool",
      error: {
        code: "UNKNOWN_TOOL",
        message: PUBLIC_ERROR_CODE_MESSAGES.UNKNOWN_TOOL
      }
    });
  });
});
