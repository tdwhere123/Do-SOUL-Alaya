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
  it("releases completion claim after completeWithEvents fails so the same signal can retry", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-complete-failure-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-complete-failure-retry"
    });

    const completeArgs = {
      task_id: "task-complete-failure-retry",
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
            raw_payload: { observation: "retry after completeWithEvents failure" }
          }
        ]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", completeArgs)
    ).rejects.toThrow("Tool call failed for garden.complete_task");
    expect(harness.getGardenTask("task-complete-failure-retry")).toMatchObject({
      status: "pending",
      claimed_by: null
    });

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-complete-failure-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", completeArgs)
    ).resolves.toMatchObject({
      task_id: "task-complete-failure-retry",
      status: "completed"
    });
    const signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
  });

  it("rejects a shortened completion retry after a partial completion failure", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-shortened-envelope-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-shortened-envelope-retry"
    });

    const twoSignalCompletion = {
      task_id: "task-shortened-envelope-retry",
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
            raw_payload: { observation: "first signal from original envelope" }
          },
          {
            signal_kind: "potential_claim",
            object_kind: "memory_entry",
            scope_hint: "project",
            domain_tags: ["garden"],
            confidence: 0.8,
            evidence_refs: ["memory-2"],
            raw_payload: { observation: "second signal from original envelope" }
          }
        ]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", twoSignalCompletion)
    ).rejects.toThrow("Tool call failed for garden.complete_task");
    expect(harness.getGardenTask("task-shortened-envelope-retry")).toMatchObject({
      status: "pending",
      claimed_by: null
    });
    expect(harness.gardenTaskRepo.findById("task-shortened-envelope-retry")?.completion_envelope_json)
      .toEqual(expect.stringContaining("\"candidate_signal_count\":2"));

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-shortened-envelope-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-shortened-envelope-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [twoSignalCompletion.result_envelope.candidate_signals[0]]
        }
      })
    ).rejects.toThrow("candidate_signals changed after a previous partial completion attempt");
    expect(harness.getGardenTask("task-shortened-envelope-retry")).toMatchObject({
      status: "claimed",
      claimed_by: "garden-worker"
    });

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", twoSignalCompletion)
    ).resolves.toMatchObject({
      task_id: "task-shortened-envelope-retry",
      status: "completed"
    });
    const completedEvents = await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    );
    expect(completedEvents[0]?.payload_json).toMatchObject({
      task_id: "task-shortened-envelope-retry",
      candidate_signals_count: 2
    });
  });

  it("rejects an omitted completion envelope retry after a partial completion failure", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-omitted-envelope-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-omitted-envelope-retry"
    });

    const oneSignalCompletion = {
      task_id: "task-omitted-envelope-retry",
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
            raw_payload: { observation: "original envelope signal" }
          }
        ]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-omitted-envelope-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-omitted-envelope-retry",
        status: "completed"
      })
    ).rejects.toThrow("candidate_signals changed after a previous partial completion attempt");

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).resolves.toMatchObject({
      task_id: "task-omitted-envelope-retry",
      status: "completed"
    });
  });

  it("rejects an empty completion envelope retry after a partial completion failure", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-empty-envelope-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-empty-envelope-retry"
    });

    const oneSignalCompletion = {
      task_id: "task-empty-envelope-retry",
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
            raw_payload: { observation: "original envelope signal" }
          }
        ]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-empty-envelope-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-empty-envelope-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: []
        }
      })
    ).rejects.toThrow("candidate_signals changed after a previous partial completion attempt");

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).resolves.toMatchObject({
      task_id: "task-empty-envelope-retry",
      status: "completed"
    });
  });

  it("rejects an extended completion retry after a partial completion failure", async () => {
    let failCompleteOnce = true;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (taskId, result, events, claimedBy, original) => {
        if (failCompleteOnce) {
          failCompleteOnce = false;
          throw new Error("simulated completion persistence failure");
        }
        await original(taskId, result, events, claimedBy);
      }
    });
    harness.enqueueTask("task-extended-envelope-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-extended-envelope-retry"
    });

    const firstSignal = {
      signal_kind: "potential_preference",
      object_kind: "memory_entry",
      scope_hint: "project",
      domain_tags: ["garden"],
      confidence: 0.9,
      evidence_refs: ["memory-1"],
      raw_payload: { observation: "only original signal" }
    } as const;
    const oneSignalCompletion = {
      task_id: "task-extended-envelope-retry",
      status: "completed",
      result_envelope: {
        candidate_signals: [firstSignal]
      }
    } as const;

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-extended-envelope-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-extended-envelope-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            firstSignal,
            {
              signal_kind: "potential_claim",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden"],
              confidence: 0.8,
              evidence_refs: ["memory-2"],
              raw_payload: { observation: "extra retry signal" }
            }
          ]
        }
      })
    ).rejects.toThrow("candidate_signals changed after a previous partial completion attempt");

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", oneSignalCompletion)
    ).resolves.toMatchObject({
      task_id: "task-extended-envelope-retry",
      status: "completed"
    });
  });

  it("rejects a Garden completion retry with changed candidate content for the same signal id", async () => {
    let failOnce = true;
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        const received = await context.signalService.receiveSignal(signal);
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated failure after first signal");
        }
        return received;
      }
    });
    harness.enqueueTask("task-mismatched-retry");
    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-mismatched-retry"
    });

    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-mismatched-retry",
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
              raw_payload: { observation: "first durable signal" }
            }
          ]
        }
      })
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    await harness.callTool<GardenClaimTaskResponse>("garden.claim_task", {
      task_id: "task-mismatched-retry"
    });
    await expect(
      harness.callTool<GardenCompleteTaskResponse>("garden.complete_task", {
        task_id: "task-mismatched-retry",
        status: "completed",
        result_envelope: {
          candidate_signals: [
            {
              signal_kind: "potential_claim",
              object_kind: "memory_entry",
              scope_hint: "project",
              domain_tags: ["garden", "changed"],
              confidence: 0.9,
              evidence_refs: ["memory-1"],
              raw_payload: { observation: "changed durable signal" }
            }
          ]
        }
      })
    ).rejects.toThrow("Tool call failed for garden.complete_task");

    expect(harness.getGardenTask("task-mismatched-retry")).toMatchObject({
      status: "claimed",
      claimed_by: "garden-worker"
    });
    const signalRows = (
      harness.database.connection
        .prepare("SELECT COUNT(*) AS n FROM signals")
        .get() as { readonly n: number }
    ).n;
    expect(signalRows).toBe(1);
  });

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
