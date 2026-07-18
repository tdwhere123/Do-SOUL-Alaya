import { describe, expect, it } from "vitest";
import { createDaemonMcpRuntimeRegistry } from "../../../mcp/mcp-runtime-registry.js";

const warn = (_message: string, _meta: Record<string, unknown>): void => undefined;

describe("daemon MCP runtime request timeout", () => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects an injected Node timer delay outside the supported integer range: %s",
    (requestTimeoutMs) => {
      expect(() => createDaemonMcpRuntimeRegistry({
        serverConfigs: {},
        requestTimeoutMs,
        warn
      })).toThrow("MCP runtime request timeout must be a safe integer between 1 and 2147483647");
    }
  );
});
