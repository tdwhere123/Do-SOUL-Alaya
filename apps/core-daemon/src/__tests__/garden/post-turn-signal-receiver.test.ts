import { describe, expect, it } from "vitest";
import {
  SignalEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  createPostTurnSignalReceiver,
  receivedEvidenceCapsule,
} from "../../garden/post-turn-extract/signal-receiver.js";
import {
  buildGardenTaskEvidenceFallbackSignalId,
  buildGardenTaskSignalId
} from "../../garden/task-signal-id.js";

describe("post-turn evidence preservation decision", () => {
  it("detects evidence from actual created objects", () => {
    expect(receivedEvidenceCapsule({
      signal: { signal_id: "signal-1", workspace_id: "workspace-1" },
      materialization: {
        created_objects: [{ object_kind: "evidence_capsule", object_id: "evidence-1" }]
      }
    })).toBe(true);
  });

  it("recovers the durable evidence postcondition from a replayed materialization event", async () => {
    const receiver = createPostTurnSignalReceiver(
      { receiveSignal: async () => ({
        signal: { signal_id: "signal-1", workspace_id: "workspace-1" },
        materialization: null
      }) },
      { queryByEntity: async () => [materializedEvent("signal-1", "evidence_capsule")] },
      { findByArtifactRef: async () => null }
    );

    expect(await receiver.hasCreatedEvidence({
      signal: { signal_id: "signal-1", workspace_id: "workspace-1" },
      materialization: null
    })).toBe(true);
  });

  it("does not treat deferred or failed materialization as durable evidence", async () => {
    const receiver = createPostTurnSignalReceiver(
      { receiveSignal: async () => ({
        signal: { signal_id: "signal-1", workspace_id: "workspace-1" },
        materialization: null
      }) },
      { queryByEntity: async () => [] },
      { findByArtifactRef: async () => null }
    );

    expect(await receiver.hasCreatedEvidence({
      signal: { signal_id: "signal-1", workspace_id: "workspace-1" },
      materialization: null
    })).toBe(false);
  });

  it("recovers a fallback whose evidence committed before its materialization event", async () => {
    const receiver = createPostTurnSignalReceiver(
      { receiveSignal: async () => ({
        signal: { signal_id: "signal-1", workspace_id: "workspace-1" },
        materialization: null
      }) },
      { queryByEntity: async () => [] },
      { findByArtifactRef: async (workspaceId, artifactRef) =>
        workspaceId === "workspace-1" && artifactRef === "alaya:garden-turn-evidence:signal-1"
          ? { object_id: "evidence-1" }
          : null }
    );

    expect(await receiver.hasCreatedEvidence({
      signal: { signal_id: "signal-1", workspace_id: "workspace-1" },
      materialization: null
    })).toBe(true);
  });

  it("keeps fallback identity stable and disjoint from changing candidate counts", () => {
    const fallbackId = buildGardenTaskEvidenceFallbackSignalId("task-1");
    expect(buildGardenTaskEvidenceFallbackSignalId("task-1")).toBe(fallbackId);
    expect(fallbackId).not.toBe(buildGardenTaskSignalId("task-1", 0));
    expect(fallbackId).not.toBe(buildGardenTaskSignalId("task-1", 1));
    expect(fallbackId).not.toBe(buildGardenTaskSignalId("task-1", 32));
  });
});

function materializedEvent(signalId: string, objectKind: string): EventLogEntry {
  return {
    event_id: "event-1",
    event_type: SignalEventType.SOUL_SIGNAL_MATERIALIZED,
    entity_type: "candidate_memory_signal",
    entity_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    revision: 1,
    caused_by: "garden-runtime",
    created_at: "2026-07-21T00:00:00.000Z",
    payload_json: {
      signal_id: signalId,
      workspace_id: "workspace-1",
      run_id: "run-1",
      created_objects: [{ object_kind: objectKind, object_id: "object-1" }],
      success: true
    }
  };
}
