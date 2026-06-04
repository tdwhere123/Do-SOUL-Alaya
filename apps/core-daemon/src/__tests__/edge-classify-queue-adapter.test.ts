import { describe, expect, it, vi } from "vitest";
import { EdgeClassifyTaskPayloadSchema, GardenTaskKind } from "@do-soul/alaya-protocol";
import type { GardenTaskEnqueueInput } from "@do-soul/alaya-storage";
import {
  buildEdgeClassifyTaskId,
  createEdgeClassifyQueueAdapter
} from "../edge-classify-queue-adapter.js";

const enqueueFn = () =>
  vi.fn((_input: GardenTaskEnqueueInput): { readonly task_id: string } => ({ task_id: "x" }));

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-1",
    runId: "run-1",
    sourceSignalId: "signal-1",
    dimension: "fact",
    scopeClass: "project",
    source: {
      object_id: "memory-new",
      content: "RTK wrapper is required for shell commands.",
      domainTags: ["rtk", "workflow"]
    },
    neighbor: {
      object_id: "memory-existing",
      content: "Repository shell commands must use the RTK wrapper.",
      domainTags: ["rtk", "workflow"]
    },
    ...overrides
  };
}

describe("edge-classify-queue-adapter", () => {
  it("enqueues a schema-valid EDGE_CLASSIFY task with the pair payload", async () => {
    const enqueue = enqueueFn();
    const adapter = createEdgeClassifyQueueAdapter({
      gardenTaskRepo: { enqueue, findById: () => null },
      now: () => "2026-05-07T00:00:00.000Z"
    });

    await adapter.enqueueEdgeClassify(makeInput());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const call = enqueue.mock.calls[0]![0]!;
    expect(call.kind).toBe(GardenTaskKind.EDGE_CLASSIFY);
    expect(call.workspace_id).toBe("workspace-1");
    // The enqueued payload is the EDGE_CLASSIFY payload contract.
    const parsed = EdgeClassifyTaskPayloadSchema.parse(call.payload);
    expect(parsed.source_memory.object_id).toBe("memory-new");
    expect(parsed.neighbor_memory.object_id).toBe("memory-existing");
    expect(parsed.source_signal_id).toBe("signal-1");
    expect(parsed.task_id).toBe(call.id);
  });

  it("dedups a pair already queued (findById hit -> no enqueue)", async () => {
    const enqueue = enqueueFn();
    const adapter = createEdgeClassifyQueueAdapter({
      gardenTaskRepo: { enqueue, findById: () => ({ id: "already-here" }) }
    });

    await adapter.enqueueEdgeClassify(makeInput());

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("swallows a duplicate-insert race (PK collision) without throwing", async () => {
    const enqueue = vi.fn(() => {
      throw new Error("UNIQUE constraint failed: garden_tasks.id");
    });
    const adapter = createEdgeClassifyQueueAdapter({
      gardenTaskRepo: { enqueue, findById: () => null }
    });

    await expect(adapter.enqueueEdgeClassify(makeInput())).resolves.toBeUndefined();
  });

  it("re-throws a non-duplicate enqueue error so the best-effort caller can warn", async () => {
    const enqueue = vi.fn(() => {
      throw new Error("disk is full");
    });
    const adapter = createEdgeClassifyQueueAdapter({
      gardenTaskRepo: { enqueue, findById: () => null }
    });

    await expect(adapter.enqueueEdgeClassify(makeInput())).rejects.toThrow("disk is full");
  });

  it("buildEdgeClassifyTaskId is deterministic per (workspace, source, neighbor)", () => {
    const a = buildEdgeClassifyTaskId("ws", "src", "nbr");
    const b = buildEdgeClassifyTaskId("ws", "src", "nbr");
    const c = buildEdgeClassifyTaskId("ws", "nbr", "src");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("edge_classify_")).toBe(true);
  });
});
