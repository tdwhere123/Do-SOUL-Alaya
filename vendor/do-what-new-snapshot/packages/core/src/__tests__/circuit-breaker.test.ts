import type { EventLogEntry } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../index.js";

describe("CircuitBreaker", () => {
  it("does not fire before the spam threshold is crossed", async () => {
    const harness = createHarness();

    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-a", "ask");
    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-a", "ask");

    expect(harness.appendedEntries).toEqual([]);
    expect(harness.broadcastEntries).toEqual([]);
    expect(harness.circuitBreaker.getState()).toMatchObject({
      postureLevel: 0,
      additionalDeniedCategories: [],
      cooldownUntil: null
    });
  });

  it("fires governance_spam_fault on the first threshold crossing and degrades posture to guarded", async () => {
    const harness = createHarness();

    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-a", "ask");
    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-a", "deny");
    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-a", "ask");

    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      event_type: "governance_spam_fault",
      workspace_id: "workspace-1",
      payload_json: {
        runId: "run-1",
        nodeId: "node-1"
      }
    });
    expect(harness.operations).toEqual([
      "append:governance_spam_fault",
      "broadcast:governance_spam_fault"
    ]);
    expect(harness.circuitBreaker.getState()).toMatchObject({
      postureLevel: 1
    });
  });

  it("expires old outcomes outside the rolling window", async () => {
    const harness = createHarness({
      nowSequence: [
        "2026-04-12T10:00:00.000Z",
        "2026-04-12T10:00:10.000Z",
        "2026-04-12T10:02:00.000Z"
      ]
    });

    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-a", "ask");
    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-a", "ask");
    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-a", "ask");

    expect(harness.appendedEntries).toEqual([]);
    expect(harness.circuitBreaker.getState().postureLevel).toBe(0);
  });

  it("reaches strict posture on the second distinct fault and then starts denying fixed categories", async () => {
    const harness = createHarness({
      nowSequence: [
        "2026-04-12T10:00:00.000Z",
        "2026-04-12T10:00:01.000Z",
        "2026-04-12T10:00:02.000Z",
        "2026-04-12T10:00:20.000Z",
        "2026-04-12T10:00:21.000Z",
        "2026-04-12T10:00:22.000Z",
        "2026-04-12T10:00:40.000Z",
        "2026-04-12T10:00:41.000Z",
        "2026-04-12T10:00:42.000Z"
      ]
    });

    await crossThreshold(harness.circuitBreaker, "run-1", "workspace-1", "node-1", "subject-a");
    expect(harness.circuitBreaker.getState()).toMatchObject({ postureLevel: 1 });

    await crossThreshold(harness.circuitBreaker, "run-1", "workspace-1", "node-1", "subject-b");
    expect(harness.circuitBreaker.getState()).toMatchObject({ postureLevel: 2 });

    await crossThreshold(harness.circuitBreaker, "run-1", "workspace-1", "node-1", "subject-c");
    expect(harness.circuitBreaker.getState()).toMatchObject({
      postureLevel: 2,
      additionalDeniedCategories: ["exec"]
    });
  });

  it("resets posture after cooldown expiry", async () => {
    const harness = createHarness({
      nowSequence: [
        "2026-04-12T10:00:00.000Z",
        "2026-04-12T10:00:01.000Z",
        "2026-04-12T10:00:02.000Z",
        "2026-04-12T10:01:03.000Z"
      ]
    });

    await crossThreshold(harness.circuitBreaker, "run-1", "workspace-1", "node-1", "subject-a");

    expect(harness.circuitBreaker.getState()).toMatchObject({
      postureLevel: 0,
      additionalDeniedCategories: [],
      cooldownUntil: null
    });
  });

  it("starts the degradation chain from guarded again after cooldown expiry", async () => {
    const harness = createHarness({
      nowSequence: [
        "2026-04-12T10:00:00.000Z",
        "2026-04-12T10:00:01.000Z",
        "2026-04-12T10:00:02.000Z",
        "2026-04-12T10:01:03.000Z",
        "2026-04-12T10:01:04.000Z",
        "2026-04-12T10:01:05.000Z",
        "2026-04-12T10:01:06.000Z"
      ]
    });

    await crossThreshold(harness.circuitBreaker, "run-1", "workspace-1", "node-1", "subject-a");
    expect(harness.circuitBreaker.getState().postureLevel).toBe(0);

    await crossThreshold(harness.circuitBreaker, "run-1", "workspace-1", "node-1", "subject-a");
    expect(harness.circuitBreaker.getState()).toMatchObject({
      postureLevel: 1,
      additionalDeniedCategories: []
    });
  });

  it("evicts stale subject keys older than twice the rolling window while recording outcomes", async () => {
    const harness = createHarness({
      nowSequence: [
        "2026-04-12T10:00:00.000Z",
        "2026-04-12T10:00:30.000Z",
        "2026-04-12T10:02:01.000Z"
      ]
    });

    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-stale", "ask");
    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-fresh", "ask");
    await harness.circuitBreaker.recordOutcome("run-1", "workspace-1", "node-1", "subject-fresh", "deny");

    const outcomeHistory = (
      harness.circuitBreaker as unknown as {
        outcomeHistory: Map<string, number[]>;
      }
    ).outcomeHistory;

    expect([...outcomeHistory.keys()]).toEqual(["subject-fresh"]);
    expect(outcomeHistory.get("subject-fresh")).toHaveLength(1);
  });
});

async function crossThreshold(
  circuitBreaker: CircuitBreaker,
  runId: string,
  workspaceId: string,
  nodeId: string,
  governanceSubjectKey: string
) {
  await circuitBreaker.recordOutcome(runId, workspaceId, nodeId, governanceSubjectKey, "ask");
  await circuitBreaker.recordOutcome(runId, workspaceId, nodeId, governanceSubjectKey, "deny");
  await circuitBreaker.recordOutcome(runId, workspaceId, nodeId, governanceSubjectKey, "ask");
}

function createHarness(options: {
  readonly nowSequence?: readonly string[];
} = {}) {
  const operations: string[] = [];
  const appendedEntries: EventLogEntry[] = [];
  const broadcastEntries: EventLogEntry[] = [];
  let eventId = 0;
  let nowIndex = 0;
  let lastNow = "2026-04-12T10:00:00.000Z";

  const now = () => {
    lastNow =
      options.nowSequence?.[Math.min(nowIndex, (options.nowSequence?.length ?? 1) - 1)] ??
      "2026-04-12T10:00:00.000Z";
    nowIndex += 1;
    return lastNow;
  };

  const circuitBreaker = new CircuitBreaker({
    config: {
      spamThreshold: 3,
      windowMs: 60_000
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        operations.push(`append:${entry.event_type}`);
        const appended = {
          ...entry,
          event_id: `event-${++eventId}`,
          created_at: lastNow
        } satisfies EventLogEntry;
        appendedEntries.push(appended);
        return appended;
      })
    },
    sseBroadcaster: {
      broadcastEntry: vi.fn(async (entry: EventLogEntry) => {
        operations.push(`broadcast:${entry.event_type}`);
        broadcastEntries.push(entry);
      })
    },
    now
  });

  return {
    circuitBreaker,
    operations,
    appendedEntries,
    broadcastEntries
  };
}
