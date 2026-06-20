import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry, McpServerInfo, ToolProvider } from "@do-soul/alaya-protocol";
import { McpToolDiscoveryService } from "../../tooling/mcp-tool-discovery-service.js";

import { createServer, validTimestamp } from "./mcp-tool-discovery-service.test-support.js";

describe("McpToolDiscoveryService", () => {
it("discovers active servers in parallel before awaiting any single server response", async () => {
    const filesystemServer = createServer({ server_name: "filesystem" });
    const githubServer = createServer({
      server_name: "github",
      transport_type: "http",
      endpoint: "http://127.0.0.1:3040/mcp"
    });
    let resolveFilesystemTools:
      | ((
          tools: ReadonlyArray<{
            readonly tool_id: string;
            readonly name: string;
            readonly description: string;
          }>
        ) => void)
      | undefined;
    let resolveGithubTools:
      | ((
          tools: ReadonlyArray<{
            readonly tool_id: string;
            readonly name: string;
            readonly description: string;
          }>
        ) => void)
      | undefined;
    const listServerTools = vi.fn(
      async (server: McpServerInfo) =>
        await new Promise<
          ReadonlyArray<{
            readonly tool_id: string;
            readonly name: string;
            readonly description: string;
          }>
        >((resolve) => {
          if (server.server_name === "filesystem") {
            resolveFilesystemTools = resolve;
            return;
          }

          resolveGithubTools = resolve;
        })
    );
    const registerProvider = vi.fn(async (provider: ToolProvider) => provider);

    const service = new McpToolDiscoveryService({
      extensionRegistry: {
        registerProvider,
        listProviders: vi.fn(async () => [])
      },
      mcpToolCatalog: {
        listServerTools
      },
      eventLogWriter: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          ...entry,
          event_id: "event-1",
          created_at: validTimestamp,
          revision: 0
        }))
      },
      now: () => validTimestamp
    });

    const discoveryPromise = service.discoverAndRegister([filesystemServer, githubServer]);

    await Promise.resolve();

    expect(listServerTools).toHaveBeenCalledTimes(2);
    expect(registerProvider).not.toHaveBeenCalled();

    resolveFilesystemTools?.([
      {
        tool_id: "mcp__filesystem__read_file",
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      }
    ]);
    resolveGithubTools?.([
      {
        tool_id: "mcp__github__search_repos",
        name: "github.search_repos",
        description: "Search repositories through GitHub MCP."
      }
    ]);

    await expect(discoveryPromise).resolves.toHaveLength(2);
    expect(registerProvider).toHaveBeenCalledTimes(2);
  });
});
