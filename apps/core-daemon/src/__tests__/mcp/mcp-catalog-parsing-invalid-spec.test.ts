import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseDaemonMcpServerRuntimeConfigs,
  readDaemonMcpCatalogEnvironment
} from "../../mcp/mcp-catalog-parsing.js";

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

  it("drops stdio server configs with non-absolute commands or blocked env propagation", () => {
    const warn = vi.fn();

    const configs = parseDaemonMcpServerRuntimeConfigs(
      JSON.stringify({
        relativeCommand: {
          transport_type: "stdio",
          command: "node",
          args: ["./mock-server.js"]
        },
        blockedEnv: {
          transport_type: "stdio",
          command: process.execPath,
          env: {
            PATH: process.env.PATH ?? "/usr/bin",
            OPENAI_API_KEY: "sk-test"
          }
        },
        shellCommand: {
          transport_type: "stdio",
          command: "/bin/sh",
          args: ["-c", "echo unsafe"]
        }
      }),
      warn
    );

    expect(configs).toEqual({});
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("accepts stdio server configs only when command, cwd, and env are strict-safe", () => {
    const warn = vi.fn();

    const configs = parseDaemonMcpServerRuntimeConfigs(
      JSON.stringify({
        filesystem: {
          transport_type: "stdio",
          command: process.execPath,
          args: ["./mock-filesystem-server.js"],
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH ?? "/usr/bin",
            HOME: process.env.HOME ?? "/tmp"
          }
        }
      }),
      warn
    );

    expect(configs).toEqual({
      filesystem: {
        transportType: "stdio",
        command: process.execPath,
        args: ["./mock-filesystem-server.js"],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "/usr/bin",
          HOME: process.env.HOME ?? "/tmp"
        }
      }
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
