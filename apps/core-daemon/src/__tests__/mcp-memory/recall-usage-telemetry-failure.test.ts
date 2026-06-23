import { afterEach, describe, expect, it, vi } from "vitest";
import { emitRecallDeliveredTelemetry } from "../../mcp-memory/recall-usage-telemetry.js";
import type {
  RecallUsageHandlerDependencies,
  RecallUsageToolCallContext
} from "../../mcp-memory/recall-usage-handlers.js";

// invariant: telemetry append never throws to the MCP caller, but a failed
// append is no longer fully silent — it is audited via the async side-effect
// auditor when the audit port is wired, else surfaced as a process warning
// (ALAYA_RECALL_TELEMETRY_APPEND_FAILED).
// see also: apps/core-daemon/src/mcp-memory/recall-usage-telemetry.ts

const context: RecallUsageToolCallContext = {
  workspaceId: "ws-1",
  runId: "run-1",
  agentTarget: "claude-code",
  sessionId: "sess-1"
};

const deliveredInput = {
  deliveryId: "delivery-1",
  query: "where do I live",
  pointerCount: 2,
  latencyMs: 12,
  context
} as const;

function throwingEventPublisher(): NonNullable<RecallUsageHandlerDependencies["eventPublisher"]> {
  return {
    appendManyWithMutation: async () => {
      throw new Error("event log offline");
    }
  };
}

describe("recall telemetry append failure visibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never throws and warns when no audit port is wired", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const deps = { eventPublisher: throwingEventPublisher() } as unknown as RecallUsageHandlerDependencies;

    await expect(
      emitRecallDeliveredTelemetry({ deps, now: () => "2026-06-23T00:00:00.000Z" }, deliveredInput)
    ).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_RECALL_TELEMETRY_APPEND_FAILED" })
    );
  });

  it("routes the failure through the async side-effect auditor when the audit port is wired", async () => {
    const append = vi.fn(async (_entry: Record<string, unknown>) => ({
      event_id: "evt-1",
      created_at: "2026-06-23T00:00:00.000Z",
      revision: 1
    }));
    const notifyEntry = vi.fn();
    const deps = {
      eventPublisher: throwingEventPublisher(),
      asyncSideEffectAudit: {
        eventLogRepo: { append },
        runtimeNotifier: { notifyEntry }
      }
    } as unknown as RecallUsageHandlerDependencies;

    await expect(
      emitRecallDeliveredTelemetry({ deps, now: () => "2026-06-23T00:00:00.000Z" }, deliveredInput)
    ).resolves.toBeUndefined();

    // auditor appended a RUNTIME_SIDE_EFFECT_FAILED event and notified
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![0]).toMatchObject({
      entity_type: "context_delivery",
      entity_id: "delivery-1",
      workspace_id: "ws-1"
    });
    expect(notifyEntry).toHaveBeenCalledTimes(1);
  });
});
