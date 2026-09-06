import { describe, expect, it } from "vitest";
import type {
  ContextDeliveryRecord,
  SoulReportContextUsageRequest
} from "@do-soul/alaya-protocol";
import { enqueuePostTurnExtractTask } from "../../../mcp-memory/garden-task/post-turn-extract-queue.js";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "../../../mcp-memory/recall/recall-usage-handlers.js";
import * as postTurnExtractQueue from "../../../mcp-memory/garden-task/post-turn-extract-queue.js";

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

describe("post-turn extract enqueue", () => {
  it("does not export recall-query extract enqueue", () => {
    expect("enqueueRecallExtractTask" in postTurnExtractQueue).toBe(false);
    expect("buildRecallExtractTaskId" in postTurnExtractQueue).toBe(false);
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
