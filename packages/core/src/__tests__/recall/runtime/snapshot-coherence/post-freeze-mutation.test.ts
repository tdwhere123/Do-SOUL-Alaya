import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import {
  SEALED_EMPTY_FRONTIER,
  createSeededTestOnlyInMemoryFieldQuerySessionWithStore
} from "../../../../recall/runtime/query/field-query-session.js";
import { InMemoryProjectionGenerationStore } from
  "../../../../recall/field/retrieval/projection/generation-store.js";
import {
  activateProjectionGeneration,
  buildProjectionGeneration,
  verifyProjectionGeneration
} from "../../../../recall/field/retrieval/projection/generation-lifecycle.js";
import {
  PREPARE_RETRIEVAL_CHANNEL_OWNERS,
  SnapshotCoherenceContractError,
  capturePreparedSnapshotCoherenceReceipt,
  capturePreparedSnapshotVector
} from "../../../../recall/runtime/snapshot-coherence/index.js";
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

const RETRIEVAL_OWNERS = PREPARE_RETRIEVAL_CHANNEL_OWNERS;

describe("prepared snapshot retrieval declarations", () => {
  it("declares five FieldPrefix channels as unavailable without empty-retrieval logic", () => {
    const pin = testPin();
    const queryCondition = captureQueryCondition(conditionDraft(), {
      sha256: testSha256(),
      now: () => CLOCK_AS_OF,
      pin
    });
    const input = { queryCondition, pin, retrieval_channel_owners: RETRIEVAL_OWNERS };
    const vector = capturePreparedSnapshotVector(input);
    const receipt = capturePreparedSnapshotCoherenceReceipt(input);
    expect(receipt.coherence_state).toBe("unavailable");
    expect(receipt.vector_digest).toBe(vector.vector_digest);
    expect(receipt.reasons).toContain("source_unavailable");
    expect(receipt.reasons).not.toContain("retrieval_undeclared");
    expect(receipt.reasons).not.toContain("decision_contract_unknown");
    expect(vector.retrieval_channel_snapshots).toHaveLength(5);
    expect(vector.retrieval_channel_snapshots.map((channel) => channel.source_owner))
      .toEqual([...RETRIEVAL_OWNERS].sort((left, right) => left.localeCompare(right)));
    for (const channel of vector.retrieval_channel_snapshots) {
      expect(channel.lag_bound.kind).toBe("unavailable");
    }
    expect(vector.embedding_generation_and_model.lag_bound.kind).toBe("unavailable");
    expect(vector.path_graph_generation.lag_bound.kind).toBe("unavailable");
    expect(vector.temporal_index_generation.lag_bound.kind).toBe("unavailable");
    expect(vector.governance_frontier.lag_bound.kind).toBe("unavailable");
    expect(vector.projection_generation.lag_bound.kind).toBe("exact");
    const undeclared = capturePreparedSnapshotCoherenceReceipt({ queryCondition, pin });
    expect(undeclared.reasons).toContain("retrieval_undeclared");
    expect(undeclared.receipt_digest).not.toBe(receipt.receipt_digest);
  });
});

describe("post-freeze mutable source isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the frozen receipt digest after a live store mutation", async () => {
    const memories: MemoryEntry[] = [];
    const { prepared, session, store, dependencies } = await prepareSample(memories);
    const digest = prepared.snapshotCoherenceReceipt.receipt_digest;
    const originalKeys = prepared.fieldProjectionSelection.candidate_keys;
    memories.push(createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      content: "planted after freeze"
    }));
    const laterGeneration = activateLaterGeneration(store);
    expect(laterGeneration).not.toBe(prepared.projectionPin.generation_id);
    expect(prepared.snapshotCoherenceReceipt.receipt_digest).toBe(digest);
    const findByWorkspaceId = dependencies.memoryRepo.findByWorkspaceId;
    vi.mocked(findByWorkspaceId).mockClear();
    expect(prepared.snapshotCoherenceReceipt.reasons).not.toContain("retrieval_undeclared");
    const rebuilt = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: prepared.queryCondition,
      pin: prepared.projectionPin,
      retrieval_channel_owners: PREPARE_RETRIEVAL_CHANNEL_OWNERS
    });
    expect(rebuilt.receipt_digest).toBe(digest);
    expect(findByWorkspaceId).not.toHaveBeenCalled();
    const laterPin = session.pinActiveGeneration("workspace-1", CLOCK_AS_OF);
    expect(laterPin.generation_id).toBe(laterGeneration);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: prepared.queryCondition,
      pin: laterPin
    })).toThrow(SnapshotCoherenceContractError);
    const reread = session.selectCandidates(
      prepared.queryCondition,
      prepared.projectionPin,
      CLOCK_AS_OF
    );
    expect(reread.candidate_keys).toEqual(originalKeys);
    prepared.releaseProjectionPin();
    prepared.projectionPinLease.stop();
  });
});

async function prepareSample(memories: MemoryEntry[] = []) {
  const { dependencies } = createDependencies(memories);
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
  const session = createSeededTestOnlyInMemoryFieldQuerySessionWithStore(
    fieldContractSha256,
    "workspace-1",
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
  return { prepared, session, store, dependencies };
}

function activateLaterGeneration(store: InMemoryProjectionGenerationStore): string {
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
  return later.generation.generation_id;
}
