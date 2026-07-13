import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload
} from "@do-soul/alaya-protocol";

import {
  cleanupGardenMcpHarnesses,
  createEdgeClassifyPayload,
  createGardenMcpHarness,
  createTaskDescriptor,
  type GardenClaimTaskResponse,
  type GardenCompleteTaskResponse,
  type GardenListPendingTasksResponse,
  type GardenMcpHarness
} from "./garden-mcp-tools-fixture.js";

afterEach(cleanupGardenMcpHarnesses);

describe("Garden MCP tools", () => {

  it("renews the claim lease before candidate signal emission", async () => {
    let gcAttempted = false;
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        gcAttempted = true;
        const abandoned = context.gardenTaskRepo.peekAbandonedClaims(
          "2026-05-07T00:20:00.000Z",
          10 * 60 * 1000
        );
        expect(abandoned).toEqual([]);
        await expect(
          context.gardenTaskRepo.claimAtomic(
            "task-lease-race",
            "claude-code",
            "2026-05-07T00:20:01.000Z"
          )
        ).resolves.toBe("already-claimed");
        return await context.signalService.receiveSignal(signal);
      }
    });
    harness.enqueueTask("task-lease-race");
    await expect(
      harness.gardenTaskRepo.claimAtomic(
        "task-lease-race",
        "garden-worker",
        "2026-05-07T00:00:00.000Z"
      )
    ).resolves.toBe("claimed");

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-lease-race",
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
              raw_payload: { observation: "host worker extracted a preference" }
            }
          ]
        }
      })
    ).resolves.toMatchObject({ task_id: "task-lease-race", status: "completed" });

    expect(gcAttempted).toBe(true);
    expect(harness.getGardenTask("task-lease-race")).toMatchObject({ status: "completed" });
    const signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
  });

  it("retries a partial complete_task after signal persistence without duplicating the signal", async () => {
    let failOnce = true;
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        const received = await context.signalService.receiveSignal(signal);
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated failure after signal persistence");
        }
        return received;
      }
    });
    harness.enqueueTask("task-partial-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-partial-retry"
    });

    let firstFailure: unknown;
    try {
      await harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-partial-retry",
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
              raw_payload: { observation: "retry should reuse the deterministic Garden signal id" }
            }
          ]
        }
      });
    } catch (error) {
      firstFailure = error;
    }

    expect(firstFailure).toBeDefined();
    expect(harness.getGardenTask("task-partial-retry")).toMatchObject({
      status: "pending",
      claimed_by: null
    });
    let signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-partial-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-partial-retry",
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
              raw_payload: { observation: "retry should reuse the deterministic Garden signal id" }
            }
          ]
        }
      })
    ).resolves.toMatchObject({
      task_id: "task-partial-retry",
      status: "completed",
      events_appended: 1
    });

    signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
    const completedEvents = await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload_json).toMatchObject({
      task_id: "task-partial-retry",
      candidate_signals_count: 1
    });
  });
});
