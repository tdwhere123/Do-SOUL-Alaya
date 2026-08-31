import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { EmbeddingNeighborHit } from "../../../../embedding-recall/embedding-recall-service.js";
import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import { createSeededTestOnlyInMemoryFieldQuerySessionWithStore } from
  "../../../../recall/runtime/query/field-query-session.js";
import { InMemoryProjectionGenerationStore } from
  "../../../../recall/field/retrieval/projection/generation-store.js";
import {
  PREPARE_RETRIEVAL_CHANNEL_OWNERS,
  capturePreparedSnapshotCoherenceReceipt,
  capturePreparedSnapshotVector,
  digestRecallDecisionContractV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import * as snapshotCoherence from "../../../../recall/runtime/snapshot-coherence/index.js";
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
import { keywordFieldResult } from "../../fixtures/keyword-field-fixture.js";

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
    expect(vector.decision_contract_digest).toBe(digestRecallDecisionContractV1());
    expect(vector.decision_contract_digest).not.toBe(queryCondition.identity);
    const otherCondition = captureQueryCondition(
      conditionDraft({ query_task_factors: ["task:other"] }),
      { sha256: testSha256(), now: () => CLOCK_AS_OF, pin }
    );
    expect(otherCondition.identity).not.toBe(queryCondition.identity);
    expect(capturePreparedSnapshotVector({
      queryCondition: otherCondition,
      pin,
      retrieval_channel_owners: RETRIEVAL_OWNERS
    }).decision_contract_digest).toBe(vector.decision_contract_digest);
    const undeclared = capturePreparedSnapshotCoherenceReceipt({ queryCondition, pin });
    expect(undeclared.reasons).toContain("retrieval_undeclared");
    expect(undeclared.receipt_digest).not.toBe(receipt.receipt_digest);
  });
});

const FROZEN_EVIDENCE_ID = "evidence-frozen";
const DISTINCT_QUERY = "How many different doctors did I visit?";

describe("post-freeze mutable source isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps frozen entries isolated from post-freeze source mutation", async () => {
    const original = mutableMemory({
      object_id: FROZEN_EVIDENCE_ID,
      evidence_refs: [FROZEN_EVIDENCE_ID],
      content: "frozen pin object",
      facet_tags: [{ facet: "location_place", value: "seattle" }]
    });
    const findByEvidenceRefs = vi.fn(async () => [original]);
    const prepared = await preparePinnedMemories([original], findByEvidenceRefs);
    const loaded = prepared.fieldProjectionMemories[0];
    expect(loaded?.content).toBe("frozen pin object");
    original.content = "mutated after freeze";
    original.domain_tags.push("planted-tag");
    const facet = original.facet_tags?.[0];
    if (facet !== undefined) facet.value = "mutated";
    expect(loaded?.content).toBe("frozen pin object");
    expect(loaded?.domain_tags).toEqual(["repo"]);
    expect(loaded?.facet_tags?.[0]?.value).toBe("seattle");
    expect(Object.isFrozen(loaded)).toBe(true);
    prepared.releaseProjectionPin();
    prepared.projectionPinLease.stop();
  });

  it("finalizes the source lease before loading pin-view memories", async () => {
    const original = createMemoryEntry({
      object_id: FROZEN_EVIDENCE_ID,
      evidence_refs: [FROZEN_EVIDENCE_ID],
      content: "frozen pin object"
    });
    const live: MemoryEntry[] = [original];
    const order: string[] = [];
    const findByEvidenceRefs = vi.fn(async (
      _workspaceId: string,
      ids: readonly string[]
    ) => {
      order.push("load");
      return live.filter((entry) =>
        ids.includes(entry.object_id)
        || entry.evidence_refs.some((ref) => ids.includes(ref))
      );
    });
    const capture = snapshotCoherence.capturePreparedSnapshotVector;
    vi.spyOn(snapshotCoherence, "capturePreparedSnapshotVector")
      .mockImplementation((input) => {
        order.push("lease");
        return capture(input);
      });
    const prepared = await preparePinnedMemories(live, findByEvidenceRefs);
    expect(order).toEqual(["lease", "load"]);
    expect(prepared.snapshotReadLease.state).toBe("finalized");
    expect(findByEvidenceRefs).toHaveBeenCalled();
    prepared.releaseProjectionPin();
    prepared.projectionPinLease.stop();
  });

  it("binds observer_universe to pinned Sigma_q objects, not query_operator_id", async () => {
    const original = createMemoryEntry({
      object_id: FROZEN_EVIDENCE_ID,
      evidence_refs: [FROZEN_EVIDENCE_ID]
    });
    const findByEvidenceRefs = vi.fn(async () => [original]);
    const withObjects = await preparePinnedMemories(
      [original],
      findByEvidenceRefs,
      DISTINCT_QUERY
    );
    const universes = allObservableUniverses(withObjects.canonicalQueryCompilation);
    expect(universes).toEqual([[FROZEN_EVIDENCE_ID]]);
    expect(universes.flat()).not.toContain(
      withObjects.queryCondition.query_operator_id
    );
    expect(withObjects.canonicalQueryCompilation.compile_status)
      .not.toBe("certified_program");
    withObjects.releaseProjectionPin();
    withObjects.projectionPinLease.stop();

    const empty = await prepareSample([], DISTINCT_QUERY);
    expect(allObservableUniverses(empty.prepared.canonicalQueryCompilation)).toEqual([]);
    expect(empty.prepared.canonicalQueryCompilation.holes.some((hole) =>
      hole.code === "unknown_scope"
    )).toBe(true);
    expect(empty.prepared.canonicalQueryCompilation.compile_status)
      .not.toBe("certified_program");
    empty.prepared.releaseProjectionPin();
    empty.prepared.projectionPinLease.stop();
  });

  it("does not upgrade Sigma_q slots when live ports mutate after freeze", async () => {
    const original = createMemoryEntry({
      object_id: FROZEN_EVIDENCE_ID,
      evidence_refs: [FROZEN_EVIDENCE_ID],
      content: "frozen pin object"
    });
    const { dependencies: base } = createDependencies([original]);
    const spies = attachLivePortSpies(base);
    const findByEvidenceRefs = vi.fn(async () => [original]);
    const prepared = await preparePinnedMemories(
      [original],
      findByEvidenceRefs,
      undefined,
      spies.dependencies
    );
    expect(spies.searchMemory).not.toHaveBeenCalled();
    expect(spies.searchEvidence).not.toHaveBeenCalled();
    expect(spies.searchEvidenceField).not.toHaveBeenCalled();
    expect(spies.searchSynthesisField).not.toHaveBeenCalled();
    expect(spies.querySupplement).not.toHaveBeenCalled();
    expect(spies.collectWorkspaceNeighbors).not.toHaveBeenCalled();
    const receiptDigest = prepared.snapshotCoherenceReceipt.receipt_digest;
    const cqDigest = prepared.canonicalQueryCompilation.digest;
    expectFrozenUnavailable(prepared);
    mutateLivePortSpies(spies);
    expect(prepared.snapshotCoherenceReceipt.receipt_digest).toBe(receiptDigest);
    expect(prepared.canonicalQueryCompilation.digest).toBe(cqDigest);
    expectFrozenUnavailable(prepared);
    const memoryHits = await prepared.retrievalFieldBundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "planted",
      limit: 1,
      scope: {}
    });
    expect(spies.searchMemory).toHaveBeenCalled();
    expect(memoryHits.map((hit) => hit.object_id)).toEqual(["planted-memory"]);
    const evidenceHits = await prepared.retrievalFieldBundle.searchEvidenceKeyword({
      queryText: "planted",
      limit: 1
    });
    expect(spies.searchEvidenceField).toHaveBeenCalled();
    expect(evidenceHits.map((hit) => hit.object_id)).toEqual(["planted-evidence"]);
    prepared.releaseProjectionPin();
    prepared.projectionPinLease.stop();
  });
});

async function preparePinnedMemories(
  live: readonly MemoryEntry[],
  findByEvidenceRefs: MemoryRepoFindByEvidenceRefs,
  displayName?: string,
  extra?: ReturnType<typeof createDependencies>["dependencies"]
) {
  const base = extra ?? createDependencies([...live]).dependencies;
  const store = new InMemoryProjectionGenerationStore(fieldContractSha256);
  const session = createSeededTestOnlyInMemoryFieldQuerySessionWithStore(
    fieldContractSha256,
    "workspace-1",
    store
  );
  return prepareRecallRequest(
    prepareContext({
      ...base,
      memoryRepo: { ...base.memoryRepo, findByEvidenceRefs }
    }, pinSession(session, FROZEN_EVIDENCE_ID)),
    prepareParams(displayName),
    captureRecallRequestTime({ now: () => CLOCK_AS_OF })
  );
}

async function prepareSample(memories: MemoryEntry[] = [], displayName?: string) {
  const { dependencies } = createDependencies(memories);
  const store = new InMemoryProjectionGenerationStore(fieldContractSha256);
  const session = createSeededTestOnlyInMemoryFieldQuerySessionWithStore(
    fieldContractSha256,
    "workspace-1",
    store
  );
  const prepared = await prepareRecallRequest(
    prepareContext(dependencies, session),
    prepareParams(displayName),
    captureRecallRequestTime({ now: () => CLOCK_AS_OF })
  );
  return { prepared, session, store, dependencies };
}

function pinSession(
  session: ReturnType<typeof createSeededTestOnlyInMemoryFieldQuerySessionWithStore>,
  evidenceId: string
) {
  return {
    ...session,
    selectCandidates(
      condition: Parameters<typeof session.selectCandidates>[0],
      pin: Parameters<typeof session.selectCandidates>[1],
      selectedAt: string
    ) {
      const base = session.selectCandidates(condition, pin, selectedAt);
      return Object.freeze({
        ...base,
        candidate_keys: Object.freeze([evidenceId])
      });
    }
  };
}

function prepareContext(
  dependencies: ReturnType<typeof createDependencies>["dependencies"],
  session: ReturnType<typeof createSeededTestOnlyInMemoryFieldQuerySessionWithStore>
    | ReturnType<typeof pinSession>
) {
  const taskSurface = createTaskSurface();
  const policy = buildRecallPolicy({
    runtimeId: "00000000-0000-0000-0000-000000000000",
    taskSurfaceId: taskSurface.runtime_id,
    maxResults: 10,
    filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
    conflictAwareness: false,
    maxTotalTokens: 1_000
  });
  return {
    dependencies,
    warn: () => undefined,
    now: () => CLOCK_AS_OF,
    buildDefaultPolicy: () => policy,
    fieldQuerySession: session,
    sha256: fieldContractSha256
  };
}

function prepareParams(displayName?: string) {
  const taskSurface = displayName === undefined
    ? createTaskSurface()
    : { ...createTaskSurface(), display_name: displayName };
  return {
    taskSurface,
    workspaceId: "workspace-1" as const,
    strategy: "analyze" as const
  };
}

function allObservableUniverses(
  compilation: Awaited<ReturnType<typeof prepareRecallRequest>>["canonicalQueryCompilation"]
): readonly (readonly string[])[] {
  return compilation.hypotheses.flatMap((query) => {
    const answer = query.answer;
    if (
      (answer.kind === "distinct" || answer.kind === "sequence")
      && answer.completion.kind === "all_observable"
    ) {
      return [answer.completion.observer_universe];
    }
    return [];
  });
}

type MemoryRepoFindByEvidenceRefs = (
  workspaceId: string,
  ids: readonly string[]
) => Promise<readonly MemoryEntry[]>;

function hit(objectId: string) {
  return { object_id: objectId, normalized_rank: 1 };
}

function expectFrozenUnavailable(
  prepared: Awaited<ReturnType<typeof prepareRecallRequest>>
): void {
  const receipt = prepared.snapshotCoherenceReceipt;
  expect(receipt.coherence_state).toBe("unavailable");
  expect(receipt.coherence_state).not.toBe("coherent_exact");
  // Slot kinds live on the vector, not the receipt body.
  const vector = capturePreparedSnapshotVector({
    queryCondition: prepared.queryCondition,
    pin: prepared.projectionPin,
    retrieval_channel_owners: RETRIEVAL_OWNERS
  });
  expect(vector.vector_digest).toBe(receipt.vector_digest);
  expect(vector.projection_generation.lag_bound.kind).toBe("exact");
  for (const channel of vector.retrieval_channel_snapshots) {
    expect(channel.lag_bound.kind).toBe("unavailable");
    expect(channel.lag_bound.kind).not.toBe("exact");
  }
  for (const slot of [
    vector.embedding_generation_and_model,
    vector.path_graph_generation,
    vector.temporal_index_generation,
    vector.governance_frontier
  ]) {
    expect(slot.lag_bound.kind).toBe("unavailable");
    expect(slot.lag_bound.kind).not.toBe("exact");
  }
}

type MemoryMutationPlant = Omit<MemoryEntry, "content" | "domain_tags" | "facet_tags" | "evidence_refs"> & {
  content: string;
  domain_tags: string[];
  evidence_refs: string[];
  facet_tags: Array<{ facet: string; value?: string }> | null | undefined;
};

function mutableMemory(overrides: Partial<MemoryEntry> = {}): MemoryMutationPlant {
  const entry = createMemoryEntry(overrides);
  return {
    ...entry,
    content: entry.content,
    domain_tags: [...entry.domain_tags],
    evidence_refs: [...entry.evidence_refs],
    facet_tags: entry.facet_tags == null
      ? entry.facet_tags
      : entry.facet_tags.map((tag) => ({ facet: tag.facet, value: tag.value }))
  };
}

function createLivePortSpies() {
  return {
    searchMemory: vi.fn(async () => keywordFieldResult([hit("pre-freeze-memory")])),
    searchEvidence: vi.fn(async () => [hit("pre-freeze-evidence")]),
    searchEvidenceField: vi.fn(async () => keywordFieldResult([hit("pre-freeze-evidence")])),
    searchSynthesisField: vi.fn(async () =>
      keywordFieldResult([hit("pre-freeze-synthesis")])
    ),
    querySupplement: vi.fn(async () => ({
      supplementaryEntries: Object.freeze([]),
      similarityHintsByObjectId: Object.freeze({})
    })),
    collectWorkspaceNeighbors: vi.fn(
      async (): Promise<readonly Readonly<EmbeddingNeighborHit>[]> => []
    ),
    findByAnchors: vi.fn(async () => []),
    getStrengthByMemoryId: vi.fn(async () => new Map<string, number>()),
    findByEventTimeWindow: vi.fn(async () => []),
    findActiveConstraints: vi.fn(async () => ({ constraints: [], total_count: 0 }))
  };
}

function attachLivePortSpies(
  base: ReturnType<typeof createDependencies>["dependencies"]
) {
  const spies = createLivePortSpies();
  return { ...spies, dependencies: withLiveSpyPorts(base, spies) };
}

function withLiveSpyPorts(
  base: ReturnType<typeof createDependencies>["dependencies"],
  spies: ReturnType<typeof createLivePortSpies>
) {
  return {
    ...base,
    memoryRepo: {
      ...base.memoryRepo,
      searchByKeywordField: spies.searchMemory,
      findByEventTimeWindow: spies.findByEventTimeWindow
    },
    evidenceSearchPort: {
      searchByKeyword: spies.searchEvidence,
      searchByKeywordField: spies.searchEvidenceField
    },
    synthesisSearchPort: {
      searchByKeyword: vi.fn(async () => []),
      searchByKeywordField: spies.searchSynthesisField,
      findByIds: vi.fn(async () => [])
    },
    embeddingRecallService: {
      querySupplement: spies.querySupplement,
      collectWorkspaceNeighbors: spies.collectWorkspaceNeighbors
    },
    pathExpansionPort: { findByAnchors: spies.findByAnchors },
    pathPlasticityPort: { getStrengthByMemoryId: spies.getStrengthByMemoryId },
    activeConstraintsPort: { findActiveConstraints: spies.findActiveConstraints }
  };
}

function mutateLivePortSpies(spies: ReturnType<typeof attachLivePortSpies>): void {
  spies.searchMemory.mockResolvedValue(keywordFieldResult([hit("planted-memory")]));
  spies.searchEvidence.mockResolvedValue([hit("planted-evidence")]);
  spies.searchEvidenceField.mockResolvedValue(
    keywordFieldResult([hit("planted-evidence")])
  );
  spies.searchSynthesisField.mockResolvedValue(
    keywordFieldResult([hit("planted-synthesis")])
  );
  spies.querySupplement.mockResolvedValue({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({
      "planted-embed": { object_id: "planted-embed", normalized_similarity: 1 }
    })
  });
  spies.collectWorkspaceNeighbors.mockResolvedValue([
    { object_id: "planted-neighbor", normalized_similarity: 1 }
  ]);
  spies.findByAnchors.mockResolvedValue([]);
  spies.getStrengthByMemoryId.mockResolvedValue(new Map([["planted-path", 1]]));
  spies.findByEventTimeWindow.mockResolvedValue([]);
  spies.findActiveConstraints.mockResolvedValue({
    constraints: [],
    total_count: 7
  });
}
