import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { buildGardenTurnEvidenceSearchProjections } from "@do-soul/alaya-soul";
import { describe, expect, it, vi } from "vitest";
import { finalizePostTurnEvidence } from "../../garden/post-turn-extract/evidence-finalizer.js";
import { buildGardenTaskEvidenceFallbackSignalId } from "../../garden/support/task-signal-id.js";

const CREATED_AT = "2026-07-27T12:00:00.000Z";

describe("post-turn evidence finalizer", () => {
  it("binds the complete verified delivery observation to ordinary candidates", async () => {
    const received: CandidateMemorySignal[] = [];
    const sourceObservation = {
      observed_at: CREATED_AT,
      authority: "verified_delivery_observation" as const,
      source_event_id: "delivery-event-一-🚀"
    };
    const candidate = {
      signal_id: "candidate-source-observation",
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source: "garden_compile",
      signal_kind: "potential_evidence_anchor",
      object_kind: "source_turn",
      signal_state: "emitted",
      scope_hint: null,
      domain_tags: [],
      confidence: 0.9,
      evidence_refs: [],
      source_memory_refs: [],
      supersedes_refs: [],
      exception_to_refs: [],
      contradicts_refs: [],
      incompatible_with_refs: [],
      raw_payload: { gist: "用户确认了发布 🚀" },
      source_observation: null,
      created_at: CREATED_AT
    } satisfies CandidateMemorySignal;

    await finalizePostTurnEvidence({
      taskId: "task-source-observation",
      workspaceId: candidate.workspace_id,
      runId: candidate.run_id,
      createdAt: CREATED_AT,
      turnContent: "User: 用户确认了发布 🚀",
      turnMessages: [{ message_id: "u1", role: "user", content: "用户确认了发布 🚀" }],
      sourceObservation,
      candidates: [candidate],
      signalReceiver: {
        async receiveSignal(signal) {
          received.push(signal);
          return {
            signal,
            materialization: {
              created_objects: [{ object_kind: "evidence_capsule", object_id: "evidence-1" }]
            }
          };
        },
        async hasCreatedEvidence() {
          return true;
        }
      }
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.source_observation).toEqual(sourceObservation);
  });

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

  it("keeps empty-semantic candidate evidence without a complete-form fallback", async () => {
    const receiveSignal = vi.fn(async (signal: CandidateMemorySignal) => ({
      signal,
      materialization: {
        created_objects: [{ object_kind: "evidence_capsule", object_id: "evidence-1" }]
      }
    }));
    const hasCreatedEvidence = vi.fn(async () => true);

    await expect(finalizePostTurnEvidence({
      taskId: "task-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      createdAt: CREATED_AT,
      turnContent: "Assistant: I use Atlas.",
      turnMessages: [{ message_id: "a1", role: "assistant", content: "I use Atlas." }],
      sourceObservation: {
        observed_at: CREATED_AT,
        authority: "trusted_host_event",
        source_event_id: "event-1"
      },
      candidates: [{
        signal_id: "candidate-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        surface_id: null,
        source: "garden_compile",
        signal_kind: "potential_claim",
        object_kind: "memory_entry",
        signal_state: "emitted",
        scope_hint: "project",
        domain_tags: [],
        confidence: 0.9,
        evidence_refs: [],
        source_memory_refs: [],
        supersedes_refs: [],
        exception_to_refs: [],
        contradicts_refs: [],
        incompatible_with_refs: [],
        created_at: CREATED_AT,
        raw_payload: { gist: "I use Atlas." },
        source_observation: null
      } satisfies CandidateMemorySignal],
      signalReceiver: { receiveSignal, hasCreatedEvidence }
    })).resolves.toEqual(["candidate-1"]);

    expect(receiveSignal).toHaveBeenCalledTimes(1);
    expect(receiveSignal.mock.calls[0]?.[0]?.signal_id).toBe("candidate-1");
  });
});
