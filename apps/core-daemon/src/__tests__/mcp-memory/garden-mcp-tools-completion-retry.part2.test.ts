import { afterEach, describe, expect, it } from "vitest";

import { GardenEventType } from "@do-soul/alaya-protocol";

import {
  cleanupGardenMcpHarnesses,
  createGardenMcpHarness,
  type GardenClaimTaskResponse,
  type GardenCompleteTaskResponse
} from "./garden-mcp-tools-fixture.js";

afterEach(cleanupGardenMcpHarnesses);

describe("Garden MCP tools", () => {

  it("rejects duplicate same-claimant complete_task before a second signal can persist", async () => {
    let resolveFirstSignalStarted!: () => void;
    const firstSignalStarted = new Promise<void>((resolve) => {
      resolveFirstSignalStarted = resolve;
    });
    let unblockFirstSignal!: () => void;
    const firstSignalGate = new Promise<void>((resolve) => {
      unblockFirstSignal = resolve;
    });
    let receiveCount = 0;
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        receiveCount += 1;
        if (receiveCount === 1) {
          resolveFirstSignalStarted();
          await firstSignalGate;
        }
        return await context.signalService.receiveSignal(signal);
      }
    });
    harness.enqueueTask("task-same-claimant-race");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-same-claimant-race"
    });

    const firstCompletion = harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
      task_id: "task-same-claimant-race",
      status: "completed",
      result_envelope: {
        candidate_signals: [
          {
            signal_kind: "potential_preference",
            object_kind: "memory_entry",
            scope_hint: "project",
            domain_tags: ["garden"],
            confidence: 0.9,
            evidence_refs: ["memory-1"],
            raw_payload: { observation: "first completion result" }
          }
        ]
      }
    });
    await firstSignalStarted;

    let duplicate: unknown;
    try {
      await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-same-claimant-race",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_preference",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "duplicate completion result" }
            }
          ]
        }
      });
    } catch (error) {
      duplicate = error;
    }

    expect(duplicate).toBeDefined();
    let signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(0);

    unblockFirstSignal();
    await expect(firstCompletion).resolves.toMatchObject({
      task_id: "task-same-claimant-race",
      status: "completed"
    });
    expect(receiveCount).toBe(1);
    signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
  });
});
