import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PUBLIC_ERROR_CODE_MESSAGES } from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  buildAttachedAgentMcpChildEnv,
  stripReviewerCredentialsFromAgentMcpEnv
} from "../../attach/attached-agent-mcp-child-env.js";
import {
  HOST_INTERPRETATION_AGENT_TARGET
} from "../../mcp-memory/proposal/reviewer-surfaces.js";
import {
  ATTACHED_AGENT_MEMORY_TOOL_NAMES,
  HOST_INTERPRETATION_ONLY_MEMORY_TOOL_NAMES,
  isMemoryToolAllowedForAgentTarget,
  listAlayaMemoryToolsForAgentTarget,
  resolveToolCatalogProfileForAgentTarget
} from "../../mcp-memory/tool/attach-profile-tool-allowlist.js";
import { ALAYA_MEMORY_TOOL_NAMES } from "../../mcp-memory/tool/tool-catalog.js";
import { builtinConversationToolRequiresConfirmation } from "../../mcp/server/builtin-conversation-tool-specs.js";
import {
  callAlayaMcpMemoryTool,
  createAlayaMcpServer
} from "../../mcp/server/mcp-server.js";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool/tool-handler.js";

describe("attach-profile memory tool allowlist", () => {
  it("hides review tools and soul.interpretation from consumer catalogs while keeping host/human surfaces", () => {
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).not.toContain("soul.review_memory_proposal");
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).not.toContain("soul.batch_review_edge_proposals");
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).not.toContain("soul.interpretation");
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).toHaveLength(15);
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).toContain("soul.propose_memory_update");
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).toContain("soul.emit_candidate_signal");
    expect(HOST_INTERPRETATION_ONLY_MEMORY_TOOL_NAMES).toEqual(["soul.interpretation"]);
    expect(isMemoryToolAllowedForAgentTarget("soul.review_memory_proposal", "codex")).toBe(false);
    expect(isMemoryToolAllowedForAgentTarget("soul.review_memory_proposal", HOST_INTERPRETATION_AGENT_TARGET)).toBe(false);
    expect(isMemoryToolAllowedForAgentTarget("soul.review_memory_proposal", "cli")).toBe(true);
    expect(isMemoryToolAllowedForAgentTarget("soul.interpretation", "codex")).toBe(true);
    expect(isMemoryToolAllowedForAgentTarget("soul.interpretation", HOST_INTERPRETATION_AGENT_TARGET)).toBe(true);
    expect(resolveToolCatalogProfileForAgentTarget("codex")).toBe("consumer");
    expect(resolveToolCatalogProfileForAgentTarget("claude-code")).toBe("consumer");
    expect(resolveToolCatalogProfileForAgentTarget("mcp")).toBe("consumer");
    expect(resolveToolCatalogProfileForAgentTarget("garden-worker")).toBe("consumer");
    expect(resolveToolCatalogProfileForAgentTarget("bench-runner")).toBe("consumer");
    expect(resolveToolCatalogProfileForAgentTarget("inspector")).toBe("host");
    expect(resolveToolCatalogProfileForAgentTarget("cli")).toBe("host");
    expect(resolveToolCatalogProfileForAgentTarget(HOST_INTERPRETATION_AGENT_TARGET)).toBe("host");
    expect(resolveToolCatalogProfileForAgentTarget("codex", "host")).toBe("host");
    expect(resolveToolCatalogProfileForAgentTarget("inspector", "consumer")).toBe("consumer");
    expect(listAlayaMemoryToolsForAgentTarget("codex").map((tool) => tool.name)).toEqual([
      ...ATTACHED_AGENT_MEMORY_TOOL_NAMES
    ]);
    const hostInterpretationTools = listAlayaMemoryToolsForAgentTarget(HOST_INTERPRETATION_AGENT_TARGET).map(
      (tool) => tool.name
    );
    expect(hostInterpretationTools).toHaveLength(16);
    expect(hostInterpretationTools).toContain("soul.interpretation");
    expect(hostInterpretationTools).not.toContain("soul.review_memory_proposal");
    expect(hostInterpretationTools).not.toContain("soul.batch_review_edge_proposals");
    expect(listAlayaMemoryToolsForAgentTarget("inspector").map((tool) => tool.name)).toEqual([
      ...ALAYA_MEMORY_TOOL_NAMES
    ]);
  });

  it("omits soul.interpretation from codex tools/list with >60% schema byte savings while preserving host dispatch", async () => {
    const handler = {
      call: vi.fn(async (input: { readonly toolName: string }) => {
        if (input.toolName === "soul.review_memory_proposal") {
          throw new Error("review handler must not run for attached agents");
        }
        return {
          ok: true as const,
          tool_name: input.toolName,
          output: { operation: "prepare_source", source_handle: "h1" }
        };
      })
    } as unknown as McpMemoryToolHandler;
    let activeTarget = "codex";
    const server = createAlayaMcpServer({
      memoryToolHandler: handler,
      contextProvider: () => ({
        workspaceId: "ws1",
        runId: null,
        agentTarget: activeTarget,
        sessionId: "attach-allowlist-session"
      })
    });
    const client = new Client({ name: "attach-allowlist", version: "test" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const consumerListed = await client.listTools();
      const names = consumerListed.tools.map((tool) => tool.name);
      expect(names).toEqual([...ATTACHED_AGENT_MEMORY_TOOL_NAMES]);
      expect(names).not.toContain("soul.review_memory_proposal");
      expect(names).not.toContain("soul.interpretation");

      activeTarget = "inspector";
      const inspectorListed = await client.listTools();
      const consumerBytes = Buffer.byteLength(JSON.stringify(consumerListed.tools), "utf8");
      const inspectorBytes = Buffer.byteLength(JSON.stringify(inspectorListed.tools), "utf8");
      expect(inspectorBytes - consumerBytes).toBeGreaterThanOrEqual(75_000);
      expect((inspectorBytes - consumerBytes) / inspectorBytes).toBeGreaterThan(0.6);

      activeTarget = "codex";
      const dispatched = await client.callTool({
        name: "soul.interpretation",
        arguments: { operation: "prepare_source" }
      });
      expect(dispatched.isError).toBeUndefined();
      expect(dispatched.structuredContent).toMatchObject({
        ok: true,
        tool_name: "soul.interpretation"
      });
      expect(handler.call).toHaveBeenCalledTimes(1);

      const review = await client.callTool({
        name: "soul.review_memory_proposal",
        arguments: {
          proposal_id: "prop-1",
          verdict: "accept",
          reason: "should not review",
          reviewer_identity: "user:spoof"
        }
      });
      expect(review.isError).toBe(true);
      expect(review.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: "UNKNOWN_TOOL",
          message: PUBLIC_ERROR_CODE_MESSAGES.UNKNOWN_TOOL
        }
      });
      expect(handler.call).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("supports explicit toolCatalogProfile: 'host' while keeping human-review tools blocked", async () => {
    const handler = {
      call: vi.fn(async () => {
        throw new Error("review handler must not run for host profile on codex");
      })
    } as unknown as McpMemoryToolHandler;
    const server = createAlayaMcpServer({
      memoryToolHandler: handler,
      toolCatalogProfile: "host",
      contextProvider: () => ({
        workspaceId: "ws1",
        runId: null,
        agentTarget: "codex",
        sessionId: "host-profile-session"
      })
    });
    const client = new Client({ name: "host-profile", version: "test" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toHaveLength(16);
      expect(names).toContain("soul.interpretation");
      expect(names).not.toContain("soul.review_memory_proposal");
      expect(names).not.toContain("soul.batch_review_edge_proposals");

      const review = await client.callTool({
        name: "soul.review_memory_proposal",
        arguments: {
          proposal_id: "prop-1",
          verdict: "accept",
          reason: "should not review",
          reviewer_identity: "user:spoof"
        }
      });
      expect(review.isError).toBe(true);
      expect(review.structuredContent).toMatchObject({
        ok: false,
        error: {
          code: "UNKNOWN_TOOL",
          message: PUBLIC_ERROR_CODE_MESSAGES.UNKNOWN_TOOL
        }
      });
      expect(handler.call).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lets attached agents propose without write_file confirmation", async () => {
    const handler = {
      call: vi.fn(async () => ({
        ok: true,
        tool_name: "soul.propose_memory_update",
        output: { proposal_id: "prop-1", status: "created" }
      }))
    } as unknown as McpMemoryToolHandler;

    const result = await callAlayaMcpMemoryTool(
      {
        memoryToolHandler: handler,
        contextProvider: () => ({
          workspaceId: "ws1",
          runId: null,
          agentTarget: "codex",
          sessionId: "propose-without-confirmation"
        })
      },
      "soul.propose_memory_update",
      {
        target_object_id: "mem1",
        proposed_changes: { content: "next" },
        reason: "propose-only"
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      tool_name: "soul.propose_memory_update",
      output: { proposal_id: "prop-1", status: "created" }
    });
    expect(handler.call).toHaveBeenCalledTimes(1);
    expect(builtinConversationToolRequiresConfirmation("tools.write_file")).toBe(true);
    expect(builtinConversationToolRequiresConfirmation("tools.exec_shell")).toBe(true);
  });

  it("stamps attach MCP env with agent target only and strips HTTP tokens from stdio env", () => {
    expect(buildAttachedAgentMcpChildEnv("codex")).toEqual({ ALAYA_AGENT_TARGET: "codex" });
    expect(buildAttachedAgentMcpChildEnv("claude-code")).not.toHaveProperty("ALAYA_REQUEST_TOKEN");
    const env: NodeJS.ProcessEnv = {
      ALAYA_AGENT_TARGET: "codex",
      ALAYA_REQUEST_TOKEN: "http-token",
      ALAYA_REQUEST_TOKEN_WORKSPACES: "ws1",
      ALAYA_REVIEWER_TOKEN: "review-token",
      ALAYA_REVIEWER_IDENTITY: "user:reviewer"
    };
    stripReviewerCredentialsFromAgentMcpEnv(env);
    expect(env.ALAYA_REQUEST_TOKEN).toBeUndefined();
    expect(env.ALAYA_REQUEST_TOKEN_WORKSPACES).toBeUndefined();
    expect(env.ALAYA_REVIEWER_TOKEN).toBeUndefined();
    expect(env.ALAYA_REVIEWER_IDENTITY).toBeUndefined();
    expect(env.ALAYA_AGENT_TARGET).toBe("codex");
  });
});
