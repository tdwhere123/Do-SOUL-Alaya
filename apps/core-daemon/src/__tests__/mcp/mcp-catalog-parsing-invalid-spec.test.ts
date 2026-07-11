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

  it("drops environment-sourced stdio server configs instead of spawning local commands", () => {
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
        },
        arbitraryAbsoluteCommand: {
          transport_type: "stdio",
          command: "/usr/bin/python3",
          args: ["./untrusted-mcp-server.py"]
        }
      }),
      warn
    );

    expect(configs).toEqual({});
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("accepts only local HTTP runtime configs from the environment", () => {
    const warn = vi.fn();

    const configs = parseDaemonMcpServerRuntimeConfigs(
      JSON.stringify({
        filesystem: {
          transport_type: "http",
          endpoint: "http://127.0.0.1:3765/mcp",
          headers: {
            "x-alaya-runtime": "test"
          }
        }
      }),
      warn
    );

    expect(configs).toEqual({
      filesystem: {
        transportType: "http",
        endpoint: "http://127.0.0.1:3765/mcp",
        headers: {
          "x-alaya-runtime": "test"
        }
      }
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops remote HTTP runtime configs from the environment", () => {
    const warn = vi.fn();

    const configs = parseDaemonMcpServerRuntimeConfigs(
      JSON.stringify({
        filesystem: {
          transport_type: "http",
          endpoint: "https://attacker.example/mcp",
          headers: {
            authorization: "Bearer x"
          }
        }
      }),
      warn
    );

    expect(configs).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      "dropping MCP HTTP runtime config with non-local endpoint",
      {
        serverName: "filesystem",
        endpoint: "https://attacker.example/mcp"
      }
    );
  });

  it("ignores MCP runtime config when the JSON envelope is not an object", () => {
    const warn = vi.fn();

    const configs = parseDaemonMcpServerRuntimeConfigs(JSON.stringify(["not", "an", "object"]), warn);

    expect(configs).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      "failed to parse ALAYA_MCP_SERVER_CONFIG_JSON; ignoring MCP runtime config",
      expect.objectContaining({ error: expect.anything() })
    );
  });

  it("ignores MCP tool catalog when the JSON envelope is not an object", () => {
    const warn = vi.fn();

    const snapshot = readDaemonMcpCatalogEnvironment(
      { ALAYA_MCP_TOOL_CATALOG_JSON: JSON.stringify(42) },
      warn
    );

    expect(snapshot.rawToolCatalog.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "failed to parse ALAYA_MCP_TOOL_CATALOG_JSON; ignoring MCP discovery catalog",
      expect.objectContaining({ error: expect.anything() })
    );
  });
});
