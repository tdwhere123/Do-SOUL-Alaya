import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PUBLIC_ERROR_CODE_MESSAGES } from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  buildAttachedAgentMcpChildEnv,
  stripReviewerCredentialsFromAgentMcpEnv
} from "../../attach/attached-agent-mcp-child-env.js";
import {
  ATTACHED_AGENT_MEMORY_TOOL_NAMES,
  isMemoryToolAllowedForAgentTarget,
  listAlayaMemoryToolsForAgentTarget
} from "../../mcp-memory/tool/attach-profile-tool-allowlist.js";
import { ALAYA_MEMORY_TOOL_NAMES } from "../../mcp-memory/tool/tool-catalog.js";
import { builtinConversationToolRequiresConfirmation } from "../../mcp/server/builtin-conversation-tool-specs.js";
import {
  callAlayaMcpMemoryTool,
  createAlayaMcpServer
} from "../../mcp/server/mcp-server.js";
import type { McpMemoryToolHandler } from "../../mcp-memory/tool/tool-handler.js";

describe("attach-profile memory tool allowlist", () => {
  it("hides review tools from attached agents and keeps them on human surfaces", () => {
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).not.toContain("soul.review_memory_proposal");
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).not.toContain("soul.batch_review_edge_proposals");
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).toContain("soul.propose_memory_update");
    expect(ATTACHED_AGENT_MEMORY_TOOL_NAMES).toContain("soul.emit_candidate_signal");
    expect(isMemoryToolAllowedForAgentTarget("soul.review_memory_proposal", "codex")).toBe(false);
    expect(isMemoryToolAllowedForAgentTarget("soul.review_memory_proposal", "cli")).toBe(true);
    expect(listAlayaMemoryToolsForAgentTarget("codex").map((tool) => tool.name)).toEqual([
      ...ATTACHED_AGENT_MEMORY_TOOL_NAMES
    ]);
    expect(listAlayaMemoryToolsForAgentTarget("inspector").map((tool) => tool.name)).toEqual([
      ...ALAYA_MEMORY_TOOL_NAMES
    ]);
  });

  it("lists and rejects review tools for an attached MCP session", async () => {
    const handler = {
      call: vi.fn(async () => {
        throw new Error("review handler must not run for attached agents");
      })
    } as unknown as McpMemoryToolHandler;
    const server = createAlayaMcpServer({
      memoryToolHandler: handler,
      contextProvider: () => ({
        workspaceId: "ws1",
        runId: null,
        agentTarget: "codex",
        sessionId: "attach-allowlist-session"
      })
    });
    const client = new Client({ name: "attach-allowlist", version: "test" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual([...ATTACHED_AGENT_MEMORY_TOOL_NAMES]);
      expect(names).not.toContain("soul.review_memory_proposal");

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
