import { describe, expect, it, vi } from "vitest";
import type {
  ContextDeliveryRecord,
  SoulMemorySearchRequest,
  SoulReportContextUsageRequest
} from "@do-soul/alaya-protocol";
import {
  enqueuePostTurnExtractTask,
  enqueueRecallExtractTask
} from "../../mcp-memory/post-turn-extract-queue.js";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "../../mcp-memory/recall-usage-handlers.js";

// invariant: the two enqueue paths are DELIBERATELY asymmetric on failure —
// the recall path is best-effort passive ingestion (§17) so it WARNS and
// returns; the report path is caller-driven so a real enqueue failure THROWS.
// see also: apps/core-daemon/src/mcp-memory/post-turn-extract-queue.ts

const context: RecallUsageToolCallContext = {
  workspaceId: "ws-1",
  runId: "run-1",
  agentTarget: "claude-code",
  sessionId: "sess-1"
};

function failingGardenTaskRepo(): NonNullable<RecallUsageHandlerDependencies["gardenTaskRepo"]> {
  return {
    enqueue: () => {
      throw new Error("storage unavailable");
    },
    findById: () => null,
    peekPending: () => []
  };
}

const recallRequest = {
  query: "where did the user say they live this past year",
  max_results: 5
} as unknown as SoulMemorySearchRequest;

const linkedDelivery = {
  delivery_id: "delivery-1",
  agent_target: "claude-code",
  workspace_id: "ws-1",
  run_id: "run-1",
  delivered_object_ids: [],
  delivered_objects: [],
  delivered_at: "2026-06-23T00:00:00.000Z"
} as unknown as ContextDeliveryRecord;

const reportRequest = {
  delivery_id: "delivery-1",
  usage_state: "used",
  turn_index: 3,
  turn_digest: {
    last_messages: [
      { role: "user", content_excerpt: "I moved to Berlin in March of this year." }
    ]
  }
} as unknown as SoulReportContextUsageRequest;

describe("post-turn extract enqueue failure asymmetry", () => {
  it("recall enqueue WARNS (does not throw) on a non-duplicate enqueue failure", () => {
    const warn = vi.fn();
    const deps = { gardenTaskRepo: failingGardenTaskRepo() } as unknown as RecallUsageHandlerDependencies;

    expect(() =>
      enqueueRecallExtractTask(
        { deps, now: () => "2026-06-23T00:00:00.000Z", warn },
        recallRequest,
        context,
        []
      )
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      "recall-driven extract task enqueue failed; skipping.",
      expect.objectContaining({ workspace_id: "ws-1", run_id: "run-1" })
    );
  });

  it("report enqueue THROWS on a non-duplicate enqueue failure", () => {
    const deps = { gardenTaskRepo: failingGardenTaskRepo() } as unknown as RecallUsageHandlerDependencies;

    expect(() =>
      enqueuePostTurnExtractTask(
        { deps, now: () => "2026-06-23T00:00:00.000Z" },
        reportRequest,
        context,
        linkedDelivery
      )
    ).toThrow("storage unavailable");
  });
});
