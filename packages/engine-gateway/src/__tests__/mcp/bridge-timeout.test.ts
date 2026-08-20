import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  McpBridge,
  resolveMcpToolTimeoutMs
} from "../../mcp/bridge.js";

const TIMEOUT_ENV = "ALAYA_MCP_TOOL_TIMEOUT_MS";

afterEach(() => {
  delete process.env[TIMEOUT_ENV];
});

describe("resolveMcpToolTimeoutMs", () => {
  it("uses the 30s default when unset", () => {
    expect(resolveMcpToolTimeoutMs(undefined)).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30_000);
  });

  it("throws on a suffixed or non-positive written timeout", () => {
    expect(() => resolveMcpToolTimeoutMs("60000ms")).toThrow(
      /ALAYA_MCP_TOOL_TIMEOUT_MS must be a positive integer/
    );
    expect(() => resolveMcpToolTimeoutMs("0")).toThrow(
      /ALAYA_MCP_TOOL_TIMEOUT_MS must be a positive integer/
    );
    expect(() => resolveMcpToolTimeoutMs("-1")).toThrow(
      /ALAYA_MCP_TOOL_TIMEOUT_MS must be a positive integer/
    );
  });

  it("fails bridge construction when the process env is written-invalid", () => {
    process.env[TIMEOUT_ENV] = "60000ms";
    expect(() => new McpBridge({
      soulHandler: async () => {
        throw new Error("unused");
      }
    })).toThrow(/ALAYA_MCP_TOOL_TIMEOUT_MS must be a positive integer/);
  });
});
