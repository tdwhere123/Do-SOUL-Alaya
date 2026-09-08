import { describe, expect, it } from "vitest";
import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
import { RecallService } from "../../../../recall/recall-service.js";
import {
  SnapshotCoherenceContractError,
  capturePreparedSnapshotCoherenceReceipt,
  unavailableProducerDigest
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import {
  CLOCK_AS_OF,
  OTHER_GENERATION_ID,
  conditionDraft,
  testPin,
  testSha256
} from "../../query/query-condition-test-fixtures.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../../recall-service-test-fixtures.js";

const SHA_A = `sha256:${"a".repeat(64)}`;

describe("snapshot freeze integration", () => {
  it("rejects mixed workspace pins and malformed snapshot digests", () => {
    const pin = testPin();
    const receipt = captureQueryCondition(conditionDraft(), {
      sha256: testSha256(),
      now: () => CLOCK_AS_OF,
      pin
    });
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin: { ...pin, workspace_id: "workspace-other" }
    })).toThrow(SnapshotCoherenceContractError);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin: { ...pin, generation_id: OTHER_GENERATION_ID }
    })).toThrow(SnapshotCoherenceContractError);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin,
      snapshotDigest: "not-a-digest"
    })).toThrow(SnapshotCoherenceContractError);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin,
      snapshotDigest: unavailableProducerDigest("base_store")
    })).toThrow(expect.objectContaining({ code: "malformed_digest" }));
    const captured = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin
    });
    const withStore = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin,
      snapshotDigest: SHA_A
    });
    expect(withStore.vector_digest).not.toBe(captured.vector_digest);
    expect(withStore.coherence_state).toBe("unavailable");
  });

  it("live delivery has no prefix_sk ranking_authority and is not the retired f29002ba trace", async () => {
    const { dependencies } = createDependencies([
      createMemoryEntry({
        object_id: "memory-canonical",
        content: "I take yoga classes at Serenity Yoga."
      })
    ]);
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Where do I take yoga classes?"
      },
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    expect(result.ranking_authority).not.toBe("prefix_sk");
    expect(result.capture_execution).toBeUndefined();
    expect(result.delivery_path).not.toBe("canonical");
    expect(JSON.stringify(result)).not.toContain("prefix_sk");
    expect(JSON.stringify(result)).not.toContain("safe-dominance-capture");
    expect(result.provider_calls).toBe(0);
    expect(result.garden_enqueue).toBe(0);
    expect(result.index).toBeDefined();
    expect(result.index.completeness.logical_index === "complete"
      || result.index.completeness.logical_index === "open"
      || result.index.completeness.logical_index === "unavailable").toBe(true);
  });
});
