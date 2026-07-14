import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import type { RecallServiceEmbeddingRecallPort } from "../../recall/runtime/recall-service-types.js";
import { RecallService } from "../../recall/recall-service.js";
import {
  createEmbeddingRecord,
  createProvider,
  hashMemoryContent
} from "../embedding-recall/embedding-recall-test-helpers.js";
import {
  createDependencies,
  createMemoryEntry,
  createPreparedQueryHandle,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

const completeAssessmentCalls = vi.hoisted(() => vi.fn());
const deliveryCalls = vi.hoisted(() => vi.fn());
const fineAssessCalls = vi.hoisted(() => vi.fn());

vi.mock("../../recall/delivery/fine-assessment.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../recall/delivery/fine-assessment.js")
  >();
  return {
    ...actual,
    fineAssess: (...args: Parameters<typeof actual.fineAssess>) => {
      fineAssessCalls();
      return actual.fineAssess(...args);
    },
    prepareFineAssessment: (...args: Parameters<typeof actual.prepareFineAssessment>) => {
      completeAssessmentCalls();
      return actual.prepareFineAssessment(...args);
    },
    deliverFineAssessment: (...args: Parameters<typeof actual.deliverFineAssessment>) => {
      deliveryCalls();
      return actual.deliverFineAssessment(...args);
    }
  };
});

describe("RecallService embedding request score snapshot", () => {
  beforeEach(() => {
    completeAssessmentCalls.mockClear();
    deliveryCalls.mockClear();
    fineAssessCalls.mockClear();
  });

  it.each([
    { label: "cross-off", crossEnabled: false, expectedRerankStatus: "not_requested" },
    { label: "cross-on", crossEnabled: true, expectedRerankStatus: "returned" }
  ] as const)("uses exclusive snapshot phases with $label", async ({
    crossEnabled,
    expectedRerankStatus
  }) => {
    const memory = createMemoryEntry({
      object_id: "snapshot-pool-memory",
      content: "Snapshot query procedure"
    });
    const { dependencies } = createDependencies([memory]);
    const fixture = createExclusiveSnapshotPort(memory.object_id);
    const answerRerankScore = vi.fn(async (_query: string, passages: readonly string[]) =>
      passages.map(() => 0.75)
    );
    const service = new RecallService({
      ...dependencies,
      embeddingRecallService: fixture.port,
      ...(crossEnabled ? { answerRerankService: { score: answerRerankScore } } : {})
    });
    const run = await runSnapshotRecall(service, "Snapshot query", {
      maxSupplement: 5,
      injectionCap: 0
    });

    expectExclusiveSnapshotContract(
      fixture, run, memory.object_id, answerRerankScore, crossEnabled, expectedRerankStatus
    );
  });

  it("keeps built-in pool scoring when supplement and injection caps are zero", async () => {
    const memory = createMemoryEntry({
      object_id: "zero-cap-pool-memory",
      content: "Zero cap query procedure"
    });
    const { dependencies } = createDependencies([memory]);
    const listByObjectIds = vi.fn(async () => [
      createEmbeddingRecord({
        object_id: memory.object_id,
        content_hash: hashMemoryContent(memory.content),
        embedding: new Float32Array([1, 0])
      })
    ]);
    const embedTexts = vi.fn(async () => [new Float32Array([1, 0])]);
    const embeddingRecallService = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds },
      provider: createProvider({ embedTexts }),
      eventLogRepo: dependencies.eventLogRepo,
      generateQueryId: () => "zero-cap-query"
    });
    const service = new RecallService({ ...dependencies, embeddingRecallService });
    const taskSurface = { ...createTaskSurface(), display_name: "Zero cap query" };
    const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
    const policyOverride = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          ...basePolicy.coarse_filter.semantic_supplement,
          embedding_enabled: true,
          max_supplement: 0,
          injection_cap: 0
        }
      }
    });

    const result = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride
    });

    expect(listByObjectIds).toHaveBeenCalledOnce();
    expect(embedTexts).toHaveBeenCalledOnce();
    expect(result.candidates.find((candidate) => candidate.object_id === memory.object_id)
      ?.score_factors?.embedding_similarity).toBeCloseTo(1, 5);
  });

  it.each([
    ["provider_pending", "provider_pending", "query_embedding_pending"],
    ["provider_failed", "provider_failed", "provider_unavailable"],
    ["provider_not_requested", "provider_failed", "local_vector_lookup_failed"],
    ["provider_returned", "provider_returned", "local_vector_lookup_failed"]
  ] as const)(
    "projects snapshot %s diagnostics to %s without counting a second inference",
    async (snapshotProviderStatus, expectedProviderStatus, degradationReason) => {
      const memory = createMemoryEntry({ content: "Snapshot status query" });
      const { dependencies } = createDependencies([memory]);
      const embeddingRecallService = createStatusSnapshotPort(
        snapshotProviderStatus,
        degradationReason
      );
      const service = new RecallService({ ...dependencies, embeddingRecallService });
      const { result } = await runSnapshotRecall(service, "Snapshot status query", {
        maxSupplement: 5,
        injectionCap: 0
      });

      expect(result.diagnostics?.embedding_provider_status).toBe(expectedProviderStatus);
      expect(result.diagnostics?.provider_degradation_reason).toBe(degradationReason);
      expect(result.diagnostics?.token_economy?.embedding_inference_calls).toBe(0);
    }
  );

  it("injects a snapshot-only neighbor when injection is enabled", async () => {
    const pooled = createMemoryEntry({
      object_id: "snapshot-native-pool",
      content: "Snapshot native query"
    });
    const neighbor = createMemoryEntry({
      object_id: "snapshot-native-neighbor",
      content: "Lexically unrelated Helsinki ledger",
      activation_score: 0.01
    });
    const { dependencies } = createDependencies([pooled]);
    const fixture = createNeighborSnapshotPort(pooled.object_id, neighbor);
    const service = new RecallService({
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByIds: fixture.findByIds },
      embeddingRecallService: fixture.port
    });
    const { result } = await runSnapshotRecall(service, "Snapshot native query", {
      maxSupplement: 5,
      injectionCap: 1,
      minActivationScore: 0.5
    });

    expect(fixture.prepareRecallEmbeddingSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      maxNeighbors: 5
    }));
    expect(fixture.materializeEmbeddingSupplementFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        baseCandidateIds: [pooled.object_id]
      })
    );
    expect(fixture.findByIds).toHaveBeenCalledWith("workspace-1", [neighbor.object_id]);
    expect(result.candidates.find((candidate) => candidate.object_id === neighbor.object_id)
      ?.source_channels).toContain("semantic_supplement");
  });
});

type SnapshotRun = Awaited<ReturnType<typeof runSnapshotRecall>>;

function createExclusiveSnapshotPort(memoryId: string) {
  const prepareRecallEmbeddingSnapshot = vi.fn(async () => Object.freeze({
    workspaceId: "workspace-1", runId: null, queryId: "snapshot-query",
    poolScoresByObjectId: Object.freeze({ [memoryId]: 0.91 }), scoringLatencyMs: 0,
    workspaceNeighbors: Object.freeze({
      hits: Object.freeze([]), embedding_inference_calls: 1,
      query_embedding_cache_hit: false, query_embedding_status: "provider_returned" as const,
      query_embedding_degradation_reason: null
    }),
    degradedReason: null
  }));
  const materializeEmbeddingSupplementFromSnapshot = vi.fn(async () => ({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({
      [memoryId]: Object.freeze({ object_id: memoryId, normalized_similarity: 0.91 })
    })
  }));
  const prepareQuerySupplement = vi.fn(async () => ({
    preparedQuery: createPreparedQueryHandle("legacy-query"),
    storedVectors: Object.freeze([]), degradedReason: null
  }));
  const querySupplementIfReady = vi.fn(async () => ({
    supplementaryEntries: Object.freeze([]), similarityHintsByObjectId: Object.freeze({})
  }));
  const scorePoolCandidates = vi.fn(async () => new Map([[memoryId, 0.5]]));
  const port = {
    prepareRecallEmbeddingSnapshot, materializeEmbeddingSupplementFromSnapshot,
    prepareQuerySupplement, querySupplementIfReady, scorePoolCandidates,
    querySupplement: emptyEmbeddingSupplement
  } satisfies RecallServiceEmbeddingRecallPort;
  return {
    port, prepareRecallEmbeddingSnapshot, materializeEmbeddingSupplementFromSnapshot,
    prepareQuerySupplement, querySupplementIfReady, scorePoolCandidates
  };
}

function createStatusSnapshotPort(
  providerStatus: "provider_pending" | "provider_failed" | "provider_not_requested" | "provider_returned",
  degradationReason: string
): RecallServiceEmbeddingRecallPort {
  return {
    prepareRecallEmbeddingSnapshot: vi.fn(async () => ({
      workspaceId: "workspace-1", runId: null, queryId: `snapshot-${providerStatus}`,
      poolScoresByObjectId: Object.freeze({}), scoringLatencyMs: 0,
      workspaceNeighbors: Object.freeze({
        hits: Object.freeze([]), embedding_inference_calls: 0,
        query_embedding_cache_hit: false, query_embedding_status: providerStatus,
        query_embedding_degradation_reason: degradationReason
      }),
      degradedReason: degradationReason
    })),
    materializeEmbeddingSupplementFromSnapshot: emptyEmbeddingSupplement,
    querySupplement: emptyEmbeddingSupplement
  };
}

function createNeighborSnapshotPort(
  pooledId: string,
  neighbor: ReturnType<typeof createMemoryEntry>
) {
  const findByIds = vi.fn(async (_workspaceId: string, objectIds: readonly string[]) =>
    objectIds.includes(neighbor.object_id) ? [neighbor] : []
  );
  const prepareRecallEmbeddingSnapshot = vi.fn(async () => Object.freeze({
    workspaceId: "workspace-1", runId: null, queryId: "snapshot-native-query",
    poolScoresByObjectId: Object.freeze({ [pooledId]: 0.8 }), scoringLatencyMs: 0,
    workspaceNeighbors: Object.freeze({
      hits: Object.freeze([{
        object_id: neighbor.object_id, normalized_similarity: 0.96,
        content_hash: hashMemoryContent(neighbor.content)
      }]),
      embedding_inference_calls: 1, query_embedding_cache_hit: false,
      query_embedding_status: "provider_returned" as const,
      query_embedding_degradation_reason: null
    }),
    degradedReason: null
  }));
  const materializeEmbeddingSupplementFromSnapshot = vi.fn(emptyEmbeddingSupplement);
  const port = {
    prepareRecallEmbeddingSnapshot,
    materializeEmbeddingSupplementFromSnapshot,
    querySupplement: emptyEmbeddingSupplement
  } satisfies RecallServiceEmbeddingRecallPort;
  return { port, findByIds, prepareRecallEmbeddingSnapshot, materializeEmbeddingSupplementFromSnapshot };
}

function emptyEmbeddingSupplement() {
  return Promise.resolve({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({})
  });
}

async function runSnapshotRecall(
  service: RecallService,
  displayName: string,
  options: Readonly<{
    readonly maxSupplement: number;
    readonly injectionCap: number;
    readonly minActivationScore?: number;
  }>
) {
  const taskSurface = { ...createTaskSurface(), display_name: displayName };
  const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
  const policyOverride = overridePolicy(basePolicy, {
    coarse_filter: {
      ...basePolicy.coarse_filter,
      ...(options.minActivationScore === undefined ? {} : {
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          min_activation_score: options.minActivationScore
        }
      }),
      semantic_supplement: {
        ...basePolicy.coarse_filter.semantic_supplement,
        embedding_enabled: true,
        max_supplement: options.maxSupplement,
        injection_cap: options.injectionCap
      }
    }
  });
  const startedAt = performance.now();
  const result = await service.recall({
    taskSurface, workspaceId: "workspace-1", strategy: "analyze", policyOverride
  });
  return { result, elapsedMs: performance.now() - startedAt };
}

function expectExclusiveSnapshotContract(
  fixture: ReturnType<typeof createExclusiveSnapshotPort>,
  run: SnapshotRun,
  memoryId: string,
  answerRerankScore: ReturnType<typeof vi.fn>,
  crossEnabled: boolean,
  expectedRerankStatus: "not_requested" | "returned"
): void {
  expect(fineAssessCalls).not.toHaveBeenCalled();
  expect(completeAssessmentCalls).toHaveBeenCalledOnce();
  expect(deliveryCalls).toHaveBeenCalledOnce();
  expect(fixture.prepareRecallEmbeddingSnapshot).toHaveBeenCalledOnce();
  expect(fixture.prepareRecallEmbeddingSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ maxNeighbors: 0 })
  );
  expect(fixture.materializeEmbeddingSupplementFromSnapshot).toHaveBeenCalledOnce();
  expect(fixture.prepareQuerySupplement).not.toHaveBeenCalled();
  expect(fixture.querySupplementIfReady).not.toHaveBeenCalled();
  expect(fixture.scorePoolCandidates).not.toHaveBeenCalled();
  expect(run.result.diagnostics?.token_economy?.embedding_inference_calls).toBe(1);
  expect(run.result.diagnostics?.embedding_provider_status).toBe("provider_returned");
  expect(run.result.diagnostics?.answer_rerank_status).toBe(expectedRerankStatus);
  expect(answerRerankScore).toHaveBeenCalledTimes(crossEnabled ? 1 : 0);
  expectExclusivePhaseLatency(run.result.diagnostics?.phase_latency_ms, run.elapsedMs);
  expect(run.result.candidates.find((candidate) => candidate.object_id === memoryId)
    ?.score_factors?.embedding_similarity).toBeCloseTo(0.91, 5);
}

const EXCLUSIVE_PHASES = [
  "coarse",
  "synthesis",
  "embedding",
  "assessment",
  "cross_rerank",
  "delivery",
  "manifestation"
] as const;

function expectExclusivePhaseLatency(
  phaseLatencyMs: Readonly<Record<string, number>> | undefined,
  elapsedMs: number
): void {
  expect(phaseLatencyMs).toBeDefined();
  expect(Object.keys(phaseLatencyMs ?? {})).toEqual(EXCLUSIVE_PHASES);
  const values = Object.values(phaseLatencyMs ?? {});
  for (const value of values) {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(values.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(elapsedMs);
}
