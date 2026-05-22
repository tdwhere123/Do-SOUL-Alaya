import { describe, expect, it, vi } from "vitest";
import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../mcp-memory-tool-handler.js";

// invariant: the registrar must be called once per
// (workspace, agent_target) per process so the first MCP call from each
// attached agent lands a single surface_identities row.

function makeMinimalDeps(
  attachSurfaceRegistrar: NonNullable<
    McpMemoryToolHandlerDependencies["attachSurfaceRegistrar"]
  >
): McpMemoryToolHandlerDependencies {
  return {
    recallService: {
      recall: vi.fn(async () => ({
        candidates: [],
        active_constraints: [],
        active_constraints_count: 0,
        total_scanned: 0,
        coarse_filter_count: 0,
        fine_assessment_count: 0
      }))
    },
    memoryService: {
      findById: vi.fn(async () => null),
      findByIdScoped: vi.fn(async () => null),
      update: vi.fn()
    },
    signalService: {
      receiveSignal: vi.fn(async (signal) => ({ signal }))
    },
    graphExploreService: {
      exploreOneHop: vi.fn(async () => [])
    },
    sessionOverrideService: {
      apply: vi.fn(async () => ({ runtime_id: "ov-1" }))
    },
    trustStateRecorder: {
      recordDelivery: vi.fn(async () => ({} as never)),
      recordUsage: vi.fn(async () => ({} as never)),
      findDeliveryById: vi.fn(async () => null)
    },
    attachSurfaceRegistrar
  };
}

describe("mcp memory tool handler · attachSurfaceRegistrar", () => {
  it("calls ensureAgentSurface exactly once per (workspaceId, agentTarget)", async () => {
    const ensureAgentSurface = vi.fn(async () => undefined);
    const handler = createMcpMemoryToolHandler(makeMinimalDeps({ ensureAgentSurface }));

    const baseContext = {
      workspaceId: "ws1",
      runId: "run1",
      agentTarget: "codex",
      sessionId: "sess-1"
    };
    const callArgs = {
      query: "any",
      scope_class: null,
      dimension: null,
      domain_tags: null,
      max_results: 1
    };
    await handler.call({ toolName: "soul.recall", arguments: callArgs, context: baseContext });
    await handler.call({ toolName: "soul.recall", arguments: callArgs, context: baseContext });
    expect(ensureAgentSurface).toHaveBeenCalledTimes(1);
    expect(ensureAgentSurface).toHaveBeenCalledWith({ workspaceId: "ws1", agentTarget: "codex" });

    await handler.call({
      toolName: "soul.recall",
      arguments: callArgs,
      context: { ...baseContext, agentTarget: "claude-code" }
    });
    await handler.call({
      toolName: "soul.recall",
      arguments: callArgs,
      context: { ...baseContext, workspaceId: "ws2" }
    });
    expect(ensureAgentSurface).toHaveBeenCalledTimes(3);
  });

  it("retries on next call when ensureAgentSurface throws", async () => {
    let failNext = true;
    const ensureAgentSurface = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw new Error("db transient");
      }
    });
    const handler = createMcpMemoryToolHandler(makeMinimalDeps({ ensureAgentSurface }));
    const ctx = {
      workspaceId: "ws1",
      runId: "run1",
      agentTarget: "codex",
      sessionId: "sess-1"
    };
    const args = { query: "q", scope_class: null, dimension: null, domain_tags: null, max_results: 1 };
    await handler.call({ toolName: "soul.recall", arguments: args, context: ctx });
    await handler.call({ toolName: "soul.recall", arguments: args, context: ctx });
    expect(ensureAgentSurface).toHaveBeenCalledTimes(2);
  });

  it("never fails a tool call because of a registrar error", async () => {
    const ensureAgentSurface = vi.fn(async () => {
      throw new Error("create failed");
    });
    const handler = createMcpMemoryToolHandler(makeMinimalDeps({ ensureAgentSurface }));
    const result = await handler.call({
      toolName: "soul.recall",
      arguments: { query: "q", scope_class: null, dimension: null, domain_tags: null, max_results: 1 },
      context: { workspaceId: "ws1", runId: "run1", agentTarget: "codex", sessionId: "s" }
    });
    expect(result.ok).toBe(true);
  });
});
