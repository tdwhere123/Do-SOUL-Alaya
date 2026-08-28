import { describe, expect, it } from "vitest";
import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import {
  SEALED_EMPTY_FRONTIER,
  createSeededTestOnlyInMemoryFieldQuerySession
} from "../../../../recall/runtime/query/field-query-session.js";
import { InMemoryProjectionGenerationStore } from
  "../../../../recall/field/retrieval/projection/generation-store.js";
import {
  activateProjectionGeneration,
  buildProjectionGeneration,
  verifyProjectionGeneration
} from "../../../../recall/field/retrieval/projection/generation-lifecycle.js";
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
  it("captures an unavailable receipt at prepare without changing public delivery", async () => {
    const { prepared, session, store } = await prepareSample();
    expect(prepared.snapshotCoherenceReceipt.coherence_state).toBe("unavailable");
    expect(prepared.snapshotCoherenceReceipt.reasons).toContain("source_unavailable");
    expect(prepared.canonicalQueryCompilation.snapshot_receipt_digest)
      .toBe(prepared.snapshotCoherenceReceipt.receipt_digest);
    expect(Object.isFrozen(prepared.snapshotCoherenceReceipt)).toBe(true);
    expect(Object.isFrozen(prepared.projectionPin)).toBe(true);
    const digest = prepared.snapshotCoherenceReceipt.receipt_digest;
    const originalKeys = prepared.fieldProjectionSelection.candidate_keys;
    const frozenGeneration = prepared.projectionPin.generation_id;
    const frozenArtifacts = store.readArtifacts("workspace-1", frozenGeneration);
    expect(frozenArtifacts).not.toBeNull();
    expect(() => store.putArtifacts("workspace-1", frozenArtifacts!))
      .toThrow(/immutable/u);
    const later = verifyProjectionGeneration(store, buildProjectionGeneration({
      store,
      sha256: fieldContractSha256,
      workspace_id: "workspace-1",
      input_event_frontier: "later-frontier",
      governance_frontier: SEALED_EMPTY_FRONTIER,
      recorded_at: CLOCK_AS_OF,
      sliceKeys: []
    }).generation, fieldContractSha256);
    activateProjectionGeneration(store, {
      workspace_id: "workspace-1",
      active_generation_id: later.generation.generation_id,
      activated_at: CLOCK_AS_OF
    });
    expect(later.generation.generation_id).not.toBe(frozenGeneration);
    const reread = session.selectCandidates(
      prepared.queryCondition,
      prepared.projectionPin,
      CLOCK_AS_OF
    );
    expect(reread.candidate_keys).toEqual(originalKeys);
    const rebuiltFrozen = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: prepared.queryCondition,
      pin: prepared.projectionPin
    });
    expect(rebuiltFrozen.receipt_digest).toBe(digest);
    const laterPin = session.pinActiveGeneration("workspace-1", CLOCK_AS_OF);
    expect(laterPin.generation_id).toBe(later.generation.generation_id);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: prepared.queryCondition,
      pin: laterPin
    })).toThrow(SnapshotCoherenceContractError);
    prepared.releaseProjectionPin();
    expect(() => session.selectCandidates(
      prepared.queryCondition,
      prepared.projectionPin,
      CLOCK_AS_OF
    )).toThrow(/released|missing/u);
    expect(prepared.snapshotCoherenceReceipt.receipt_digest).toBe(digest);
    prepared.projectionPinLease.stop();
  });

  it("is deterministic for the same pinned prepare inputs", async () => {
    const first = await prepareSample();
    const second = await prepareSample();
    expect(first.prepared.snapshotCoherenceReceipt.receipt_digest)
      .toBe(second.prepared.snapshotCoherenceReceipt.receipt_digest);
    first.prepared.releaseProjectionPin();
    first.prepared.projectionPinLease.stop();
    second.prepared.releaseProjectionPin();
    second.prepared.projectionPinLease.stop();
  });

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
    const params = {
      taskSurface: {
        ...createTaskSurface(),
        display_name: "Where do I take yoga classes?"
      },
      workspaceId: "workspace-1" as const,
      strategy: "analyze" as const
    };
    const first = await service.recall(params);
    const second = await service.recall(params);
    expect(first.delivery_path).toBe("canonical");
    expect(first.ranking_authority).toBe("prefix_sk");
    expect(first.capture_identity).toEqual(CANONICAL_CAPTURE_IDENTITY);
    expect(second.capture_identity).toEqual(first.capture_identity);
    const firstKeys = first.candidates.map((candidate) => candidate.object_id);
    expect(second.candidates.map((candidate) => candidate.object_id)).toEqual(firstKeys);
    expect(firstKeys).toEqual(["memory-canonical"]);
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
  const store = new InMemoryProjectionGenerationStore(fieldContractSha256);
  const session = createSeededTestOnlyInMemoryFieldQuerySession(
    fieldContractSha256,
    "workspace-1",
    "1970-01-01T00:00:00.000Z",
    store
  );
  const prepared = await prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => CLOCK_AS_OF,
    buildDefaultPolicy: () => policy,
    fieldQuerySession: session,
    sha256: fieldContractSha256
  }, {
    taskSurface,
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, time);
  return { prepared, session, store };
}
