import { afterEach, describe, expect, it } from "vitest";
import { GardenRole, GardenTaskKind, GardenTier } from "@do-soul/alaya-protocol";
import { buildGardenTaskEvidenceFallbackSignalId } from "../../../garden/support/task-signal-id.js";
import { readRetainedPostTurnSource } from "./post-turn-source-fixture.js";
import {
  cleanupGardenMcpHarnesses,
  createGardenMcpHarness
} from "./garden-mcp-tools-fixture.js";

afterEach(async () => {
  await cleanupGardenMcpHarnesses();
});

describe("external post-turn evidence finalization", () => {
  it("keeps the admitted original without a synthetic fallback when extraction returns no candidates", async () => {
    const taskId = "post-turn-empty";
    const fallbackId = buildGardenTaskEvidenceFallbackSignalId(taskId);
    const harness = await createGardenMcpHarness({
      hasCreatedEvidence: async (result) => result.signal.signal_id === fallbackId
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId)).resolves.toMatchObject({
      status: "completed"
    });

    await expect(harness.signalRepo.getById(fallbackId)).resolves.toBeNull();
    expect(readRetainedPostTurnSource(harness.database, taskId)?.source_body)
      .toBe("User: Remember that evidence must survive extraction.");
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "completed" });
  });

  it("completes from already retained evidence without claiming synthetic evidence was created", async () => {
    const taskId = "post-turn-no-durable-evidence";
    const harness = await createGardenMcpHarness({
      hasCreatedEvidence: async () => false
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId)).resolves.toMatchObject({ status: "completed" });
    expect(readRetainedPostTurnSource(harness.database, taskId)?.source_body)
      .toBe("User: Remember that evidence must survive extraction.");
    expect(harness.database.connection.prepare("SELECT count(*) AS count FROM signals").get()).toEqual({ count: 0 });
  });

  it("retries a post-turn completion after its completion audit failed", async () => {
    const taskId = "post-turn-empty-retry";
    let completionAttempts = 0;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (_taskId, _result, _events, _claimedBy, workspaceId, original) => {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("completion event unavailable");
        await original(_taskId, _result, _events, _claimedBy, workspaceId);
      }
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId)).rejects.toThrow("MCP memory tool call failed.");
    await claimTask(harness, taskId);
    await expect(completeTask(harness, taskId)).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects model results on post-turn work, which only retains its admitted source", async () => {
    const taskId = "post-turn-model-result";
    const harness = await createGardenMcpHarness();
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(harness.callTool("garden.complete_task", { task_id: taskId, status: "completed",
      result_envelope: { source_statement_responses: [{ chunk_index: 0, raw_json: "{\"messages\":[]}" }] } }))
      .rejects.toThrow("source_statement_responses are only valid for SOURCE_STATEMENT_SESSION");
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "claimed" });
  });

  it("fails closed when the durable receiver is unavailable", async () => {
    const taskId = "post-turn-missing-receiver";
    const harness = await createGardenMcpHarness({ omitPostTurnSignalReceiver: true });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId)).rejects.toThrow(
      "without a durable signal receiver"
    );
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "pending" });
  });

  it("failed post-turn complete retains the original turn and does not mint memory entries", async () => {
    const taskId = "post-turn-failed";
    const fallbackId = buildGardenTaskEvidenceFallbackSignalId(taskId);
    const harness = await createGardenMcpHarness({
      hasCreatedEvidence: async (result) => result.signal.signal_id === fallbackId
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId, "failed")).resolves.toMatchObject({
      status: "failed"
    });
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "failed" });
    await expect(harness.signalRepo.getById(fallbackId)).resolves.toBeNull();
    expect(readRetainedPostTurnSource(harness.database, taskId)?.source_body)
      .toBe("User: Remember that evidence must survive extraction.");
  });

  it("failed post-turn complete without a durable receiver fails closed", async () => {
    const taskId = "post-turn-failed-no-receiver";
    const harness = await createGardenMcpHarness({ omitPostTurnSignalReceiver: true });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId, "failed")).rejects.toThrow(
      "without a durable signal receiver"
    );
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "pending" });
  });
});

function enqueuePostTurnTask(
  harness: Awaited<ReturnType<typeof createGardenMcpHarness>>,
  taskId: string
): void {
  harness.enqueueTask(taskId, {
    role: GardenRole.LIBRARIAN,
    kind: GardenTaskKind.POST_TURN_EXTRACT,
    payload: {
      task_id: taskId,
      task_kind: GardenTaskKind.POST_TURN_EXTRACT,
      required_tier: GardenTier.TIER_2,
      run_id: "run-a",
      workspace_id: "workspace-a",
      target_object_refs: [],
      priority: 20,
      created_at: "2026-05-07T00:00:00.000Z",
      source_observation: null,
      turn_index: 4,
      turn_digest: {
        last_messages: [
          { role: "user", content_excerpt: "Remember that evidence must survive extraction." }
        ]
      }
    }
  });
}

async function claimTask(
  harness: Awaited<ReturnType<typeof createGardenMcpHarness>>,
  taskId: string
): Promise<void> {
  await harness.callTool("garden.claim_task", { task_id: taskId });
}

async function completeTask(
  harness: Awaited<ReturnType<typeof createGardenMcpHarness>>,
  taskId: string,
  status: "completed" | "failed" = "completed"
): Promise<unknown> {
  return await harness.callTool("garden.complete_task", { task_id: taskId, status });
}
