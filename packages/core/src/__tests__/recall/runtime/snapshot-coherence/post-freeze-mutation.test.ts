import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";
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
const PLANTED_EVIDENCE_ID = "evidence-planted-after-freeze";
const DISTINCT_QUERY = "How many different doctors did I visit?";

describe("post-freeze mutable source isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not ingest live memory planted after Sigma_q freeze", async () => {
    const original = createMemoryEntry({
      object_id: FROZEN_EVIDENCE_ID,
      evidence_refs: [FROZEN_EVIDENCE_ID],
      content: "frozen pin object"
    });
    const planted = createMemoryEntry({
      object_id: PLANTED_EVIDENCE_ID,
      evidence_refs: [FROZEN_EVIDENCE_ID],
      content: "planted after freeze"
    });
    const live: MemoryEntry[] = [original];
    let frozen = false;
    const findByEvidenceRefs = vi.fn(async (
      _workspaceId: string,
      ids: readonly string[]
    ) => {
      expect(frozen).toBe(false);
      return live.filter((entry) =>
        ids.includes(entry.object_id)
        || entry.evidence_refs.some((ref) => ids.includes(ref))
      );
    });
    const capture = snapshotCoherence.capturePreparedSnapshotCoherenceReceipt;
    vi.spyOn(snapshotCoherence, "capturePreparedSnapshotCoherenceReceipt")
      .mockImplementation((input) => {
        const receipt = capture(input);
        frozen = true;
        live.push(planted);
        return receipt;
      });
    const prepared = await preparePinnedMemories(live, findByEvidenceRefs);
    expect(snapshotCoherence.capturePreparedSnapshotCoherenceReceipt)
      .toHaveBeenCalled();
    expect(frozen).toBe(true);
    expect(live.map((entry) => entry.object_id)).toContain(PLANTED_EVIDENCE_ID);
    expect(findByEvidenceRefs).toHaveBeenCalled();
    const loadedIds = prepared.fieldProjectionMemories.map((entry) => entry.object_id);
    expect(loadedIds).toEqual([FROZEN_EVIDENCE_ID]);
    expect(loadedIds).not.toContain(PLANTED_EVIDENCE_ID);
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
});

async function preparePinnedMemories(
  live: readonly MemoryEntry[],
  findByEvidenceRefs: MemoryRepoFindByEvidenceRefs,
  displayName?: string
) {
  const { dependencies: base } = createDependencies([...live]);
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
