import { describe, expect, it } from "vitest";
import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../recall/runtime/query/field-query-session.js";
import {
  SnapshotCoherenceContractError,
  capturePreparedSnapshotCoherenceReceipt
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { RecallService } from "../../../../recall/recall-service.js";
import { CANONICAL_CAPTURE_IDENTITY } from
  "../../../../recall/shadow/canonical-delivery.js";
import { buildRecallPolicy } from "../../../../shared/recall-policy.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import {
  CLOCK_AS_OF,
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
  it("captures an unavailable receipt at prepare without changing public delivery", async () => {
    const prepared = await prepareSample();
    expect(prepared.snapshotCoherenceReceipt.coherence_state).toBe("unavailable");
    expect(prepared.snapshotCoherenceReceipt.reasons).toContain("source_unavailable");
    expect(Object.isFrozen(prepared.snapshotCoherenceReceipt)).toBe(true);
    const digest = prepared.snapshotCoherenceReceipt.receipt_digest;
    const mutatedPin = { ...prepared.projectionPin, generation_id: SHA_A };
    expect(mutatedPin.generation_id).not.toBe(prepared.projectionPin.generation_id);
    expect(prepared.snapshotCoherenceReceipt.receipt_digest).toBe(digest);
    prepared.releaseProjectionPin();
    prepared.projectionPinLease.stop();
  });

  it("is deterministic for the same pinned prepare inputs", async () => {
    const first = await prepareSample();
    const second = await prepareSample();
    expect(first.snapshotCoherenceReceipt.receipt_digest)
      .toBe(second.snapshotCoherenceReceipt.receipt_digest);
    first.releaseProjectionPin();
    first.projectionPinLease.stop();
    second.releaseProjectionPin();
    second.projectionPinLease.stop();
  });

  it("rejects mixed workspace pins and ignores malformed snapshot digests", () => {
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
    const captured = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin,
      snapshotDigest: "not-a-digest"
    });
    expect(captured.coherence_state).toBe("unavailable");
    const withStore = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin,
      snapshotDigest: SHA_A
    });
    expect(withStore.vector_digest).not.toBe(captured.vector_digest);
    expect(withStore.coherence_state).toBe("unavailable");
  });

  it("keeps canonical membership, order, and public receipt identity", async () => {
    const memory = createMemoryEntry({
      object_id: "memory-canonical",
      content: "I take yoga classes at Serenity Yoga."
    });
    const { dependencies } = createDependencies([memory]);
    const service = new RecallService({
      ...dependencies,
      defaultPolicyDecorator: (policy) => policy
    });
    const result = await service.recall({
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Where do I take yoga classes?"
      },
      workspaceId: "workspace-1",
      strategy: "analyze"
    });
    expect(result.delivery_path).toBe("canonical");
    expect(result.ranking_authority).toBe("prefix_sk");
    expect(result.capture_identity).toEqual(CANONICAL_CAPTURE_IDENTITY);
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(
      result.candidates.map((candidate) => candidate.object_id)
    );
  });
});

async function prepareSample() {
  const { dependencies } = createDependencies([]);
  const taskSurface = createTaskSurface();
  const policy = buildRecallPolicy({
    runtimeId: "00000000-0000-0000-0000-000000000000",
    taskSurfaceId: taskSurface.runtime_id,
    maxResults: 10,
    filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
    conflictAwareness: false,
    maxTotalTokens: 1_000
  });
  const time = captureRecallRequestTime({ now: () => CLOCK_AS_OF });
  return await prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => CLOCK_AS_OF,
    buildDefaultPolicy: () => policy,
    fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
      fieldContractSha256,
      "workspace-1"
    ),
    sha256: fieldContractSha256
  }, {
    taskSurface,
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, time);
}
