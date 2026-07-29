import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { buildGardenTurnEvidenceSearchProjections } from "@do-soul/alaya-soul";
import { describe, expect, it, vi } from "vitest";
import { finalizePostTurnEvidence } from "../../garden/post-turn-extract/evidence-finalizer.js";
import { buildGardenTaskEvidenceFallbackSignalId } from "../../garden/support/task-signal-id.js";

const CREATED_AT = "2026-07-27T12:00:00.000Z";

describe("post-turn evidence finalizer", () => {
  it("retains a trusted Assistant-only turn as a receipt-bound v2 projection", async () => {
    const observation = "Use the TrailShell pack for rain. Its roll-top protects a laptop.";
    const receiveSignal = vi.fn(async (signal: CandidateMemorySignal) => ({
      signal,
      materialization: {
        created_objects: [{ object_kind: "evidence_capsule", object_id: "evidence-1" }]
      }
    }));

    await expect(finalizePostTurnEvidence({
      taskId: "task-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      createdAt: CREATED_AT,
      turnContent: "legacy flattened content",
      turnMessages: [{ message_id: "a1", role: "assistant", content: observation }],
      sourceObservation: {
        observed_at: CREATED_AT,
        authority: "trusted_host_event",
        source_event_id: "event-1"
      },
      candidates: [],
      signalReceiver: {
        receiveSignal,
        hasCreatedEvidence: vi.fn(async () => true)
      }
    })).resolves.toEqual([buildGardenTaskEvidenceFallbackSignalId("task-1")]);

    const signal = receiveSignal.mock.calls[0]![0];
    expect(signal.raw_payload).toMatchObject({
      full_turn_content: `Assistant: ${observation}`,
      source_role_spans: [
        { role: "assistant", start: "Assistant: ".length, end: observation.length + 11 }
      ],
      evidence_preservation: { version: 2 }
    });
    expect(buildGardenTurnEvidenceSearchProjections(signal)).toEqual([{
      projection_id: 1,
      projection_kind: "assistant_observation",
      content: observation
    }]);
  });
});
