import { describe, expect, it, vi } from "vitest";

import {
  MemoryDimension,
  ScopeClass,
} from "@do-soul/alaya-protocol";

import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";

import {
  context,
  createActiveConstraint,
  createDeliveryRecord,
  createDeps,
  createMemory,
  createRecallCandidate
} from "./mcp-memory-tool-handler-fixture.js";

describe("mcp memory tool handler", () => {

  it("recall-hit-tier-promotion refreshes used memory access while promoting to hot", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1", "mem1"],
        per_anchor_usage: [{ object_id: "mem1", anchor_role: "target" }],
        reason: "cited"
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.memoryService.findByIdsScoped).toHaveBeenCalledWith(["mem1"], "ws1");
    expect(deps.memoryService.findByIdScoped).not.toHaveBeenCalled();
    expect(deps.memoryService.updateScoped).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.updateScoped).toHaveBeenCalledWith(
      "mem1",
      "ws1",
      {
        storage_tier: "hot",
        last_used_at: "2026-04-30T00:00:00.000Z",
        last_hit_at: "2026-04-30T00:00:00.000Z"
      },
      "recall_usage_reported"
    );
  });

  it("rejects report_context_usage when scoped batch lookup cannot resolve a used memory", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async (deliveryId: string) => ({
      ...createDeliveryRecord(deliveryId),
      delivered_object_ids: ["mem1", "mem2"]
    }));
    deps.memoryService.findByIdsScoped = vi.fn(async () => [createMemory({ object_id: "mem1" })]);
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1", "mem2"],
        reason: "missing memory"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" }
    });
    expect(deps.memoryService.findByIdsScoped).toHaveBeenCalledWith(["mem1", "mem2"], "ws1");
    expect(deps.memoryService.findByIdScoped).not.toHaveBeenCalled();
  });

  it("does not refresh recall access for skipped reports", async () => {
    const deps = createDeps();
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "skipped",
        used_object_ids: [],
        reason: "not relevant"
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });

  it("maps trust-state usage validation failures to MCP validation errors", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.recordUsage = vi.fn(async () => {
      const error = new Error("Per-anchor usage references object_id that was not delivered: mem2");
      (error as Error & { code: "VALIDATION" }).code = "VALIDATION";
      throw error;
    });
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        used_object_ids: ["mem1"],
        per_anchor_usage: [{ object_id: "mem2", anchor_role: "target" }],
        reason: "spoofed"
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Per-anchor usage references object_id that was not delivered: mem2"
      }
    });
  });
});
