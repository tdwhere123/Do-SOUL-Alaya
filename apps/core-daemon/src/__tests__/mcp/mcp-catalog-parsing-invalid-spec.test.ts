import { afterEach, describe, expect, it, vi } from "vitest";
import { readDaemonMcpCatalogEnvironment } from "../../mcp/mcp-catalog-parsing.js";

// invariant: an invalid tool spec in ALAYA_MCP_TOOL_CATALOG_JSON is dropped
// (correct), but the drop must be observable via ALAYA_MCP_TOOL_SPEC_INVALID
// rather than vanishing silently.
// see also: apps/core-daemon/src/mcp/mcp-catalog-parsing.ts (parseMcpToolSpec)

describe("readDaemonMcpCatalogEnvironment invalid tool spec", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns ALAYA_MCP_TOOL_SPEC_INVALID and drops a tool that fails the spec schema", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const env = {
      ALAYA_MCP_TOOL_CATALOG_JSON: JSON.stringify({
        filesystem: [
          { tool_id: "fs.read", name: "fs_read", description: "ok" },
          // missing required fields → schema parse fails → dropped + warned
          { tool_id: "", name: 123, description: null }
        ]
      })
    };

    const snapshot = readDaemonMcpCatalogEnvironment(env, () => undefined);

    const tools = snapshot.rawToolCatalog.get("filesystem") ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.spec.tool_id).toBe("fs.read");
    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_MCP_TOOL_SPEC_INVALID" })
    );
  });
});
