import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRuntimeContext, ToolSpec, ToolUseBlock } from "@do-soul/alaya-protocol";
import { soulToolDefs } from "../provider/soul-tool-specs.js";
import * as mcpBridgeModule from "../mcp-bridge.js";
import { McpBridge } from "../mcp-bridge.js";

// workspace_id / run_id / surface_id are bound server-side from the
// trusted MCP context; they are not in the public
// soul.emit_candidate_signal request schema.
const toolUse: ToolUseBlock = {
  type: "tool_use",
  id: "toolu_1",
  name: "soul.emit_candidate_signal",
  input: {
    signal_kind: "potential_claim",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["security"],
    confidence: 0.5,
    evidence_refs: ["msg-1"],
    raw_payload: { excerpt: "Never print secrets." }
  }
};

const runtimeContext: ConversationRuntimeContext = {
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: null,
  user_message_id: "msg_user_1"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("McpBridge", () => {
  it("routes soul.* calls to the injected soul handler", async () => {
    const soulHandler = vi.fn().mockResolvedValue({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify({ signal_id: "signal-1", status: "emitted" })
    });
    const bridge = new McpBridge({ soulHandler });

    const result = await bridge.executeToolUse(toolUse, runtimeContext);

    expect(soulHandler).toHaveBeenCalledWith(toolUse, runtimeContext);
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify({ signal_id: "signal-1", status: "emitted" })
    });
  });

  it("routes allowed tools.* calls to the injected tools handler", async () => {
    const toolsHandler = vi.fn().mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_write",
      content: JSON.stringify({ ok: true, bytesWritten: 5 })
    });
    const bridge = new McpBridge({
      hasConversationToolName: (toolName) => toolName === "tools.write_file",
      soulHandler: vi.fn(),
      toolsHandler
    });

    const toolUse = {
      type: "tool_use",
      id: "toolu_write",
      name: "tools.write_file",
      input: {
        path: "notes.txt",
        content: "hello"
      }
    } satisfies ToolUseBlock;

    const result = await bridge.executeToolUse(toolUse, runtimeContext);

    expect(toolsHandler).toHaveBeenCalledWith(toolUse, runtimeContext);
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_write",
      content: JSON.stringify({ ok: true, bytesWritten: 5 })
    });
  });

  it("accepts dynamically registered non-tools namespace ids and routes them to toolsHandler", async () => {
    const dynamicToolSpec: ToolSpec = {
      tool_id: "mcp__filesystem__read_file",
      category: "exec",
      description: "Read file through filesystem MCP.",
      scope_guard: "project",
      read_only: false,
      destructive: false,
      concurrency_safe: false,
      interrupt_behavior: "wait",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: false
    };
    const toolsHandler = vi.fn().mockResolvedValue({
      type: "tool_result",
      tool_use_id: "toolu_mcp_read",
      content: JSON.stringify({ ok: true, content: "hello" })
    });
    const bridge = new McpBridge({
      hasConversationToolName: (toolName) => toolName === dynamicToolSpec.tool_id,
      soulHandler: vi.fn(),
      toolsHandler
    });

    const result = await bridge.executeToolUse(
      {
        type: "tool_use",
        id: "toolu_mcp_read",
        name: "mcp__filesystem__read_file",
        input: { path: "README.md" }
      },
      runtimeContext
    );

    expect(toolsHandler).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp__filesystem__read_file" }),
      runtimeContext
    );
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_mcp_read",
      content: JSON.stringify({ ok: true, content: "hello" })
    });
  });

  it.each(["tools.exec_shell", "tools.write_file"] as const)(
    "does not infer builtin %s routing without a daemon predicate",
    async (name) => {
      const bridge = new McpBridge({
        soulHandler: vi.fn()
      });

      const result = await bridge.executeToolUse({
        ...toolUse,
        id: `toolu_${name}`,
        name
      });

      expect(result).toMatchObject({
        type: "tool_result",
        tool_use_id: `toolu_${name}`,
        content: JSON.stringify({ error: "unsupported tool" }),
        is_error: true
      });
    }
  );

  it("returns the tools handler stub only when hasConversationToolName opts a builtin tool in", async () => {
    const bridge = new McpBridge({
      hasConversationToolName: (toolName) => toolName === "tools.exec_shell",
      soulHandler: vi.fn()
    });

    const result = await bridge.executeToolUse({
      ...toolUse,
      id: "toolu_tools.exec_shell",
      name: "tools.exec_shell"
    });

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_tools.exec_shell",
      content: JSON.stringify({ error: "tools.* is deferred to #BL-008." }),
      is_error: true
    });
  });

  it("rejects hallucinated tools.* tool names before dispatching to handlers", async () => {
    const toolsHandler = vi.fn();
    const bridge = new McpBridge({
      soulHandler: vi.fn(),
      toolsHandler
    });

    const result = await bridge.executeToolUse({
      ...toolUse,
      id: "toolu_fake_tool",
      name: "tools.fake_tool"
    });

    expect(toolsHandler).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_fake_tool",
      content: JSON.stringify({ error: "unsupported tool" }),
      is_error: true
    });
  });

  it("returns an error result for unknown namespaces", async () => {
    const bridge = new McpBridge({
      soulHandler: vi.fn()
    });

    const result = await bridge.executeToolUse({
      ...toolUse,
      id: "toolu_3",
      name: "memory.store"
    });

    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_3",
      is_error: true
    });
  });

  it("returns an empty list when no tool_uses are present", async () => {
    const bridge = new McpBridge({
      soulHandler: vi.fn()
    });

    await expect(bridge.executeToolUses([])).resolves.toEqual([]);
  });

  it("sanitizes handler exceptions before surfacing them to the model", async () => {
    const bridge = new McpBridge({
      soulHandler: vi.fn(async () => {
        throw new Error("query failed on db.internal:5432 with token abcd1234");
      })
    });

    const result = await bridge.executeToolUse(toolUse, runtimeContext);

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify({ error: "MCP tool execution failed." }),
      is_error: true
    });
  });

  it("rejects hallucinated soul.* tool names before dispatching to handlers", async () => {
    const soulHandler = vi.fn();
    const bridge = new McpBridge({ soulHandler });

    const result = await bridge.executeToolUse({
      ...toolUse,
      id: "toolu_fake",
      name: "soul.fake_tool"
    });

    expect(soulHandler).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_fake",
      content: JSON.stringify({ error: "unsupported tool" }),
      is_error: true
    });
  });

  it("passes through structured validation errors so the model can retry", async () => {
    const bridge = new McpBridge({
      soulHandler: vi.fn(async () => {
        throw {
          error_code: "invalid_input",
          field: "signal_kind"
        };
      })
    });

    const result = await bridge.executeToolUse(toolUse, runtimeContext);

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify({
        error: {
          error_code: "invalid_input",
          field: "signal_kind"
        }
      }),
      is_error: true
    });
  });

  it.each([
    ["string", "boom"],
    ["number", 42],
    ["plain object", { boom: true }]
  ])("collapses %s throws to the generic tool failure string", async (_label, thrownValue) => {
    const bridge = new McpBridge({
      soulHandler: vi.fn(async () => {
        throw thrownValue;
      })
    });

    const result = await bridge.executeToolUse(toolUse, runtimeContext);

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify({ error: "MCP tool execution failed." }),
      is_error: true
    });
  });

  it("defines provider-neutral SOUL tool specs for the stable public memory surface", () => {
    expect(soulToolDefs.map((toolDef) => toolDef.name)).toEqual([
      "soul.recall",
      "soul.open_pointer",
      "soul.emit_candidate_signal",
      "soul.propose_memory_update",
      "soul.review_memory_proposal",
      "soul.list_pending_proposals",
      "soul.apply_override",
      "soul.explore_graph",
      "soul.report_context_usage",
      "soul.resolve",
      "garden.list_pending_tasks",
      "garden.claim_task",
      "garden.complete_task"
    ]);
  });

  it("allows first-party recall tools through the soul namespace gate", async () => {
    const recallToolUse = {
      type: "tool_use",
      id: "toolu_recall",
      name: "soul.recall",
      input: {
        query: "build command",
        scope_class: "project",
        dimension: "procedure",
        domain_tags: ["repo"],
        max_results: 5
      }
    } satisfies ToolUseBlock;
    const soulHandler = vi.fn().mockResolvedValue({
      type: "tool_result",
      tool_use_id: recallToolUse.id,
      content: JSON.stringify({
        delivery_id: "delivery-1",
        results: [],
        total_count: 0
      })
    });
    const bridge = new McpBridge({ soulHandler });

    const result = await bridge.executeToolUse(recallToolUse, runtimeContext);

    expect(soulHandler).toHaveBeenCalledWith(recallToolUse, runtimeContext);
    expect(result.tool_use_id).toBe("toolu_recall");
  });

  it("no longer exports openAIMcpTools, anthropicMcpTools, or SOUL_TOOL_DEFS from mcp-bridge", () => {
    expect("openAIMcpTools" in mcpBridgeModule).toBe(false);
    expect("anthropicMcpTools" in mcpBridgeModule).toBe(false);
    expect("SOUL_TOOL_DEFS" in mcpBridgeModule).toBe(false);
  });

  it("keeps soul tool definitions backed by protocol schemas", () => {
    const emitCandidateSignal = soulToolDefs.find(
      (toolDef) => toolDef.name === "soul.emit_candidate_signal"
    );

    expect(emitCandidateSignal).toMatchObject({
      description: expect.stringContaining("candidate memory signal")
    });
    expect(emitCandidateSignal?.parametersSchema.parse(toolUse.input)).toEqual(toolUse.input);
  });
});
