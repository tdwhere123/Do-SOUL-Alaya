import { afterEach, describe, expect, it } from "vitest";
import { GardenRole, GardenTaskKind, GardenTier } from "@do-soul/alaya-protocol";
import {
  buildGardenTaskEvidenceFallbackSignalId,
  buildGardenTaskSignalId
} from "../../garden/index.js";
import {
  cleanupGardenMcpHarnesses,
  createGardenMcpHarness
} from "./garden-mcp-tools-fixture.js";

afterEach(async () => {
  await cleanupGardenMcpHarnesses();
});

describe("external post-turn evidence finalization", () => {
  it("emits a stable evidence fallback when extraction returns no candidates", async () => {
    const taskId = "post-turn-empty";
    const fallbackId = buildGardenTaskEvidenceFallbackSignalId(taskId);
    const harness = await createGardenMcpHarness({
      hasCreatedEvidence: async (result) => result.signal.signal_id === fallbackId
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId, [])).resolves.toMatchObject({
      status: "completed"
    });

    await expect(harness.signalRepo.getById(fallbackId)).resolves.toMatchObject({
      signal_id: fallbackId,
      raw_payload: { evidence_preservation: { reason: "empty_extraction" } }
    });
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "completed" });
  });

  it("adds a fallback when every candidate is deferred without durable evidence", async () => {
    const taskId = "post-turn-deferred";
    const fallbackId = buildGardenTaskEvidenceFallbackSignalId(taskId);
    const harness = await createGardenMcpHarness({
      hasCreatedEvidence: async (result) => result.signal.signal_id === fallbackId
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await completeTask(harness, taskId, [candidateSignal()]);

    await expect(harness.signalRepo.getById(buildGardenTaskSignalId(taskId, 0))).resolves.toBeTruthy();
    await expect(harness.signalRepo.getById(fallbackId)).resolves.toMatchObject({
      raw_payload: { evidence_preservation: { reason: "no_evidence_created" } }
    });
  });

  it("does not complete when the fallback lacks confirmed durable evidence", async () => {
    const taskId = "post-turn-no-durable-evidence";
    const harness = await createGardenMcpHarness({
      hasCreatedEvidence: async () => false
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId, [])).rejects.toThrow(
      "evidence fallback did not create durable evidence"
    );
    expect(harness.getGardenTask(taskId)).toMatchObject({
      status: "pending",
      completed_at: null
    });
  });

  it("freezes an empty completion envelope before fallback side effects", async () => {
    const taskId = "post-turn-empty-retry";
    let completionAttempts = 0;
    const harness = await createGardenMcpHarness({
      completeWithEvents: async (_taskId, _result, _events, _claimedBy, original) => {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("completion event unavailable");
        await original(_taskId, _result, _events, _claimedBy);
      }
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId, [])).rejects.toThrow("completion event unavailable");
    await claimTask(harness, taskId);
    await expect(completeTask(harness, taskId, [candidateSignal()])).rejects.toThrow(
      "candidate_signals changed after a previous partial completion attempt"
    );
  });

  it("fails closed when the durable receiver is unavailable", async () => {
    const taskId = "post-turn-missing-receiver";
    const harness = await createGardenMcpHarness({ omitPostTurnSignalReceiver: true });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId, [])).rejects.toThrow(
      "without a durable signal receiver"
    );
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "pending" });
  });

  it("detects a completion claim reclaimed during signal materialization", async () => {
    const taskId = "post-turn-claim-reclaimed";
    const harness = await createGardenMcpHarness({
      receiveSignal: async (signal, context) => {
        await context.gardenTaskRepo.releaseClaim(
          taskId,
          "garden-worker:complete:00000000-0000-4000-8000-000000000001"
        );
        return { signal };
      },
      hasCreatedEvidence: async () => true
    });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId, [candidateSignal()])).rejects.toThrow(
      "completion claim changed before candidate signal emission"
    );
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "pending" });
  });

  it("allows a failed post-turn task to complete without fabricating evidence", async () => {
    const taskId = "post-turn-failed";
    const harness = await createGardenMcpHarness({ omitPostTurnSignalReceiver: true });
    enqueuePostTurnTask(harness, taskId);
    await claimTask(harness, taskId);

    await expect(completeTask(harness, taskId, [], "failed")).resolves.toMatchObject({
      status: "failed"
    });
    expect(harness.getGardenTask(taskId)).toMatchObject({ status: "failed" });
    await expect(harness.signalRepo.getById(
      buildGardenTaskEvidenceFallbackSignalId(taskId)
    )).resolves.toBeNull();
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
  candidateSignals: readonly ReturnType<typeof candidateSignal>[],
  status: "completed" | "failed" = "completed"
): Promise<unknown> {
  return await harness.callTool("garden.complete_task", {
    task_id: taskId,
    status,
    result_envelope: { candidate_signals: candidateSignals }
  });
}

function candidateSignal() {
  return {
    signal_kind: "potential_claim" as const,
    object_kind: "memory_entry" as const,
    scope_hint: "project" as const,
    domain_tags: ["evidence"],
    confidence: 0.8,
    evidence_refs: [],
    raw_payload: { observation: "Extraction produced a deferred memory candidate." }
  };
}
