import { describe, expect, it, vi } from "vitest";
import { SoulSignalHandler } from "@do-what/soul";
import type { ConversationRuntimeContext, ToolUseBlock } from "@do-what/protocol";

const validToolUse: ToolUseBlock = {
  type: "tool_use",
  id: "toolu_1",
  name: "soul.emit_candidate_signal",
  input: {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    signal_kind: "potential_claim",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["security"],
    confidence: 0.5,
    evidence_refs: ["msg-1"],
    raw_payload: {
      excerpt: "Never print secrets."
    }
  }
};

const runtimeContext: ConversationRuntimeContext = {
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: null,
  user_message_id: "msg_user_1"
};

describe("SoulSignalHandler", () => {
  it("validates input, generates a signal id, and forwards the signal to core", async () => {
    const receiveSignal = vi.fn(async () => {});
    const handler = new SoulSignalHandler({
      receiveSignal,
      generateSignalId: () => "signal-generated",
      now: () => "2026-03-18T00:00:00.000Z"
    });

    const result = await handler.handleToolUse(validToolUse, runtimeContext);

    expect(receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        signal_id: "signal-generated",
        source: "model_tool",
        signal_kind: "potential_claim"
      })
    );
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: JSON.stringify({ signal_id: "signal-generated", status: "emitted" })
    });
  });

  it("returns an error tool_result when required fields are missing", async () => {
    const handler = new SoulSignalHandler({
      receiveSignal: vi.fn(async () => {})
    });

    const result = await handler.handleToolUse({
      ...validToolUse,
      id: "toolu_2",
      input: {
        run_id: "run-1"
      }
    });

    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_2",
      is_error: true
    });
  });

  it("returns an error tool_result for invalid enum values", async () => {
    const handler = new SoulSignalHandler({
      receiveSignal: vi.fn(async () => {})
    });

    const result = await handler.handleToolUse({
      ...validToolUse,
      id: "toolu_3",
      input: {
        ...validToolUse.input,
        signal_kind: "potential_memory"
      }
    });

    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_3",
      is_error: true
    });
  });

  it("applies a session override when runtime context is available", async () => {
    const applyOverride = vi.fn(async () => ({
      runtime_id: "override-1"
    }));
    const handler = new SoulSignalHandler({
      receiveSignal: vi.fn(async () => {}),
      applyOverride
    });

    const result = await handler.handleToolUse(
      {
        type: "tool_use",
        id: "toolu_4",
        name: "soul.apply_override",
        input: {
          target_object: "memory:build-style",
          correction: "Use pnpm instead of npm.",
          priority: 2
        }
      },
      runtimeContext
    );

    expect(applyOverride).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1",
      surfaceId: null,
      targetObject: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 2,
      derivedFrom: "msg_user_1"
    });
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_4",
      content: JSON.stringify({ override_id: "override-1", status: "applied" })
    });
  });

  it("returns an error for soul.apply_override without runtime context", async () => {
    const handler = new SoulSignalHandler({
      receiveSignal: vi.fn(async () => {}),
      applyOverride: vi.fn(async () => ({
        runtime_id: "override-1"
      }))
    });

    const result = await handler.handleToolUse({
      type: "tool_use",
      id: "toolu_5",
      name: "soul.apply_override",
      input: {
        target_object: "memory:build-style",
        correction: "Use pnpm instead of npm."
      }
    });

    expect(result).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_5",
      is_error: true
    });
  });

  it("explores graph neighbors when graphExplorePort is wired", async () => {
    const graphExplorePort = {
      exploreOneHop: vi.fn(async () => [
        {
          memory_id: "memory-2",
          edge_type: "supports",
          direction: "outbound" as const,
          edge_id: "edge-1"
        }
      ])
    };
    const handler = new SoulSignalHandler({
      receiveSignal: vi.fn(async () => {}),
      graphExplorePort
    });

    const result = await handler.handleToolUse(
      {
        type: "tool_use",
        id: "toolu_6",
        name: "soul.explore_graph",
        input: {
          memory_id: "memory-1",
          workspace_id: "workspace-1",
          direction: "both"
        }
      },
      runtimeContext
    );

    expect(graphExplorePort.exploreOneHop).toHaveBeenCalledWith("memory-1", "workspace-1", {
      edgeTypes: undefined,
      direction: "both",
      runId: "run-1"
    });
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_6",
      content: JSON.stringify({
        source_memory_id: "memory-1",
        neighbors: [
          {
            memory_id: "memory-2",
            edge_type: "supports",
            direction: "outbound",
            edge_id: "edge-1"
          }
        ],
        count: 1
      })
    });
  });
});
