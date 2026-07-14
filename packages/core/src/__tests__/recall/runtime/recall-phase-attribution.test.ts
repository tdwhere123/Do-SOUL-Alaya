import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecallServiceEmbeddingRecallPort } from "../../../recall/runtime/recall-service-types.js";
import { RecallService } from "../../../recall/recall-service.js";
import {
  createDependencies,
  createMemoryEntry,
  createPreparedQueryHandle,
  createTaskSurface,
  overridePolicy
} from "../recall-service-test-fixtures.js";

const clock = vi.hoisted(() => ({
  value: 0,
  assessmentCost: 0,
  deliveryCost: 0,
  assessmentCalls: vi.fn(),
  deliveryCalls: vi.fn()
}));

vi.mock("../../../recall/delivery/fine-assessment.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../recall/delivery/fine-assessment.js")
  >();
  const prepare = (...args: Parameters<typeof actual.prepareFineAssessment>) => {
    clock.assessmentCalls();
    clock.value += clock.assessmentCost;
    return actual.prepareFineAssessment(...args);
  };
  const deliver = (...args: Parameters<typeof actual.deliverFineAssessment>) => {
    clock.deliveryCalls();
    clock.value += clock.deliveryCost;
    return actual.deliverFineAssessment(...args);
  };
  return {
    ...actual,
    prepareFineAssessment: prepare,
    deliverFineAssessment: deliver,
    fineAssess: (...args: Parameters<typeof actual.fineAssess>) =>
      deliver(args[0], prepare(args[0]))
  };
});

describe("recall phase attribution", () => {
  beforeEach(() => {
    clock.value = 0;
    clock.assessmentCost = 5;
    clock.deliveryCost = 11;
    clock.assessmentCalls.mockClear();
    clock.deliveryCalls.mockClear();
    vi.spyOn(performance, "now").mockImplementation(() => clock.value);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attributes snapshot materialization, assessment, cross, and delivery once", verifySnapshotAttribution);
  it("keeps custom fallback work in exclusive phase durations", verifyCustomAttribution);
  it("deduplicates legacy preparation overlap without cross reranking", verifyLegacyAttribution);
  it("assigns concurrent synthesis work to the earlier coarse owner", verifyCoarseOwnership);
});

async function verifySnapshotAttribution() {
  const memory = createMemoryEntry({ content: "Snapshot phase procedure" });
  const { dependencies } = createDependencies([memory]);
  const service = new RecallService({
    ...dependencies,
    embeddingRecallService: createSnapshotPort(memory.object_id),
    answerRerankService: createCrossReranker(7),
    manifestationSidecarPort: createManifestationSidecar(13)
  });
  const result = await runEmbeddingRecall(service, "Snapshot phase procedure", "phase-run");

  expect(result.diagnostics?.phase_latency_ms).toEqual({
    coarse: 0, synthesis: 0, embedding: 5, assessment: 5,
    cross_rerank: 7, delivery: 11, manifestation: 13
  });
  expect(clock.assessmentCalls).toHaveBeenCalledOnce();
  expect(clock.deliveryCalls).toHaveBeenCalledOnce();
}

async function verifyCustomAttribution() {
  const memory = createMemoryEntry({ content: "Custom fallback procedure" });
  const { dependencies } = createDependencies([memory]);
  const service = new RecallService({
    ...dependencies,
    embeddingRecallService: createCustomPort(memory.object_id),
    answerRerankService: createCrossReranker(7)
  });
  const result = await runEmbeddingRecall(service, "Custom fallback procedure");

  expect(result.diagnostics?.phase_latency_ms).toEqual({
    coarse: 0, synthesis: 0, embedding: 10, assessment: 10,
    cross_rerank: 7, delivery: 22, manifestation: 0
  });
  expect(clock.assessmentCalls).toHaveBeenCalledTimes(2);
  expect(clock.deliveryCalls).toHaveBeenCalledTimes(2);
}

async function verifyLegacyAttribution() {
  const memory = createMemoryEntry({ content: "Legacy adapter procedure" });
  const { dependencies } = createDependencies([memory]);
  const service = new RecallService({
    ...dependencies,
    embeddingRecallService: createLegacyPort(memory.object_id)
  });
  const result = await runEmbeddingRecall(service, "Legacy adapter procedure");

  expect(result.diagnostics?.phase_latency_ms).toEqual({
    coarse: 0, synthesis: 0, embedding: 17, assessment: 10,
    cross_rerank: 0, delivery: 22, manifestation: 0
  });
  expect(clock.assessmentCalls).toHaveBeenCalledTimes(2);
  expect(clock.deliveryCalls).toHaveBeenCalledTimes(2);
}

async function verifyCoarseOwnership() {
  const memory = createMemoryEntry({ content: "Concurrent synthesis procedure" });
  const { dependencies } = createDependencies([memory]);
  const synthesisSearch = vi.fn(async () => {
    if (synthesisSearch.mock.calls.length === 1) clock.value += 13;
    return [];
  });
  const service = new RecallService({
    ...dependencies,
    synthesisSearchPort: {
      searchByKeyword: synthesisSearch,
      findByIds: vi.fn(async () => [])
    }
  });
  const result = await runRecall(service, "Concurrent synthesis procedure");

  expect(synthesisSearch).toHaveBeenCalled();
  expect(result.diagnostics?.phase_latency_ms).toEqual({
    coarse: 13, synthesis: 0, embedding: 0, assessment: 5,
    cross_rerank: 0, delivery: 11, manifestation: 0
  });
}

function createSnapshotPort(memoryId: string): RecallServiceEmbeddingRecallPort {
  return {
    prepareRecallEmbeddingSnapshot: vi.fn(async () => {
      clock.value += 2;
      return Object.freeze({
        workspaceId: "workspace-1",
        runId: null,
        queryId: "snapshot-phase-query",
        poolScoresByObjectId: Object.freeze({ [memoryId]: 0.8 }),
        scoringLatencyMs: 2,
        workspaceNeighbors: Object.freeze({
          hits: Object.freeze([]),
          embedding_inference_calls: 1,
          query_embedding_cache_hit: false,
          query_embedding_status: "provider_returned" as const,
          query_embedding_degradation_reason: null
        }),
        degradedReason: null
      });
    }),
    materializeEmbeddingSupplementFromSnapshot: vi.fn(async () => {
      clock.value += 3;
      return embeddingSupplement(memoryId, 0.8);
    }),
    querySupplement: vi.fn(async () => embeddingSupplement(memoryId, 0))
  };
}

function createCustomPort(memoryId: string): RecallServiceEmbeddingRecallPort {
  return {
    prepareQuerySupplement: vi.fn(async () => {
      clock.value += 2;
      return Object.freeze({
        preparedQuery: createPreparedQueryHandle("custom-phase-query"),
        storedVectors: Object.freeze([]),
        degradedReason: null
      });
    }),
    querySupplementIfReady: vi.fn(async () => {
      clock.value += 3;
      return embeddingSupplement(memoryId, 0.7);
    }),
    scorePoolCandidates: vi.fn(async () => {
      clock.value += 5;
      return new Map([[memoryId, 0.8]]);
    }),
    querySupplement: vi.fn(async () => embeddingSupplement(memoryId, 0))
  };
}

function createLegacyPort(memoryId: string): RecallServiceEmbeddingRecallPort {
  return {
    hasStoredVectors: vi.fn(async () => {
      clock.value += 2;
      return true;
    }),
    prepareQueryEmbedding: vi.fn(() => {
      clock.value += 3;
      return createPreparedQueryHandle("legacy-phase-query");
    }),
    querySupplementIfReady: vi.fn(async () => {
      clock.value += 5;
      return embeddingSupplement(memoryId, 0.7);
    }),
    scorePoolCandidates: vi.fn(async () => {
      clock.value += 7;
      return new Map([[memoryId, 0.8]]);
    }),
    querySupplement: vi.fn(async () => embeddingSupplement(memoryId, 0))
  };
}

function createCrossReranker(cost: number) {
  return {
    score: vi.fn(async (_query: string, passages: readonly string[]) => {
      clock.value += cost;
      return passages.map(() => 0.6);
    })
  };
}

function createManifestationSidecar(cost: number) {
  return {
    buildBiasSidecar: vi.fn(async () => {
      clock.value += cost;
      return [];
    })
  };
}

function embeddingSupplement(memoryId: string, score: number) {
  return {
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: score === 0
      ? Object.freeze({})
      : Object.freeze({
          [memoryId]: Object.freeze({ object_id: memoryId, normalized_similarity: score })
        })
  };
}

async function runEmbeddingRecall(
  service: RecallService,
  displayName: string,
  runId?: string
) {
  const taskSurface = { ...createTaskSurface(), display_name: displayName };
  const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
  const policyOverride = overridePolicy(basePolicy, {
    coarse_filter: {
      ...basePolicy.coarse_filter,
      semantic_supplement: {
        ...basePolicy.coarse_filter.semantic_supplement,
        embedding_enabled: true,
        max_supplement: 5
      }
    }
  });
  return service.recall({
    taskSurface,
    workspaceId: "workspace-1",
    strategy: "analyze",
    policyOverride,
    ...(runId === undefined ? {} : { runId })
  });
}

function runRecall(service: RecallService, displayName: string) {
  return service.recall({
    taskSurface: { ...createTaskSurface(), display_name: displayName },
    workspaceId: "workspace-1",
    strategy: "analyze"
  });
}
