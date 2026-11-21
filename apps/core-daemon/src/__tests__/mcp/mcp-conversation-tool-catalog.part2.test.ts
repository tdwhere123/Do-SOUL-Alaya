import { describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import type { ToolProvider, ToolSpec } from "@do-soul/alaya-protocol";
import { bootstrapDaemonConversationTooling } from "../../mcp/catalog/mcp-catalog.js";

function createToolSpec(toolId: string): ToolSpec {
  return {
    tool_id: toolId,
    category: toolId === "tools.read_file" ? "read" : "exec",
    description: `Spec for ${toolId}`,
    scope_guard: toolId === "tools.read_file" ? "workspace" : "project",
    read_only: toolId === "tools.read_file",
    destructive: false,
    concurrency_safe: toolId === "tools.read_file",
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: toolId === "tools.read_file"
  };
}

describe("daemon conversation tool catalog", () => {

  it("bootstraps the builtin conversation provider through the daemon helper onto extension descriptors", async () => {
    const registerProvider = vi.fn(async (provider: Readonly<ToolProvider>) => provider);
    const toolSpecService = {
      findById: vi.fn(async (toolId: string) => {
        throw new CoreError("NOT_FOUND", `Missing ${toolId}`);
      }),
      register: vi.fn(async (spec: Readonly<ToolSpec>) => spec),
      update: vi.fn(async (spec: Readonly<ToolSpec>) => spec)
    };

    await bootstrapDaemonConversationTooling({
      now: () => "2026-04-21T00:00:00.000Z",
      extensionRegistry: {
        listProviders: vi.fn(async () => []),
        registerProvider
      },
      mcpToolDiscoveryService: {
        discoverAndRegister: vi.fn(async () => [])
      },
      runtimeRegistry: {
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined),
        getServerTools: vi.fn(() => []),
        listServerInfos: vi.fn(() => []),
        listServerTools: vi.fn(async () => []),
        refresh: vi.fn(async () => undefined),
        getHealth: vi.fn(() => ({ servers: [] }))
      },
      toolSpecService
    });

    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_id: "provider.builtin.conversation_engine"
      })
    );
    expect(toolSpecService.register).toHaveBeenCalled();
  });

  it("keeps builtin tools out of the live daemon catalog when descriptor authority does not expose them", async () => {
    const tooling = await bootstrapDaemonConversationTooling({
      now: () => "2026-04-21T00:00:00.000Z",
      extensionRegistry: {
        listProviders: vi.fn(async () => []),
        registerProvider: vi.fn(async (provider: Readonly<ToolProvider>) => provider)
      },
      mcpToolDiscoveryService: {
        discoverAndRegister: vi.fn(async () => [])
      },
      runtimeRegistry: {
        callTool: vi.fn(async () => ({ content: [] })),
        close: vi.fn(async () => undefined),
        getServerTools: vi.fn(() => []),
        listServerInfos: vi.fn(() => []),
        listServerTools: vi.fn(async () => []),
        refresh: vi.fn(async () => undefined),
        getHealth: vi.fn(() => ({ servers: [] }))
      },
      toolSpecService: {
        findById: vi.fn(async (toolId: string) => createToolSpec(toolId)),
        register: vi.fn(async (spec: Readonly<ToolSpec>) => spec),
        update: vi.fn(async (spec: Readonly<ToolSpec>) => spec)
      }
    });

    expect(tooling.conversationToolCatalog.getSpecs()).toEqual([]);
  });
});
