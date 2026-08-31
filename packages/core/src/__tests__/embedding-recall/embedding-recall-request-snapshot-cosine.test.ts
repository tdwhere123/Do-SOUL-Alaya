import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";

import { resetCoreConfigForTests } from "../../config/index.js";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import {
  createEmbeddingRecord,
  createMemoryEntry,
  createProvider,
  hashMemoryContent
} from "./embedding-recall-test-helpers.js";

interface CosineParityCase {
  readonly name: string;
  readonly query: readonly number[];
  readonly stored: readonly number[];
  readonly observed: boolean;
  readonly queryValid?: boolean;
  readonly recordEligible?: boolean;
  readonly dimensions?: number;
  readonly modelId?: string;
  readonly stale?: boolean;
}

const COSINE_PARITY_CASES: readonly CosineParityCase[] = Object.freeze([
  { name: "finite vectors", query: [3, 4], stored: [4, 3], observed: true },
  { name: "finite mixed signs", query: [1, -2, 3], stored: [2, 1, 1], observed: true },
  { name: "finite fractions", query: [0.25, -0.5, 1.5], stored: [2, -1, 0.25], observed: true },
  { name: "an orthogonal cosine", query: [1, 0], stored: [0, 1], observed: true },
  { name: "a negative cosine", query: [1, 0], stored: [-1, 0], observed: true },
  { name: "a zero query", query: [0, 0], stored: [4, 3], observed: false, queryValid: false },
  { name: "a non-finite query", query: [Number.NaN, 1], stored: [4, 3], observed: false, queryValid: false },
  { name: "a zero document", query: [3, 4], stored: [0, 0], observed: false },
  { name: "a non-finite document", query: [3, 4], stored: [Number.POSITIVE_INFINITY, 1], observed: false },
  { name: "a dimension mismatch", query: [3, 4], stored: [4, 3], observed: false, recordEligible: false, dimensions: 3 },
  { name: "a provider mismatch", query: [3, 4], stored: [4, 3], observed: false, recordEligible: false, modelId: "other-model" },
  { name: "a stale content hash", query: [3, 4], stored: [4, 3], observed: false, recordEligible: false, stale: true }
]);

describe("EmbeddingRecallService request score snapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetCoreConfigForTests();
  });

  it.each(COSINE_PARITY_CASES)(
    "preserves independent cosine semantics for $name",
    async (testCase) => {
      const result = await prepareCosineParityCase(testCase);
      const expected = testCase.recordEligible === false
        ? 0
        : referenceRecallCosineScore(result.query, result.stored);

      expectSnapshotScore(
        result.snapshot.poolScoresByObjectId[result.memory.object_id],
        expected,
        testCase.observed
      );
      const queryFailure = testCase.queryValid === false;
      expect(result.snapshot.workspaceNeighbors.query_embedding_status).toBe(
        queryFailure
          ? "provider_failed"
          : testCase.modelId === "other-model"
            ? "provider_not_requested"
            : "provider_returned"
      );
      expect(result.snapshot.workspaceNeighbors.query_embedding_degradation_reason).toBe(
        queryFailure ? "query_embedding_failed" : null
      );
      expect(result.snapshot.degradedReason).toBe(
        queryFailure ? "query_embedding_failed" : null
      );
    }
  );
});

async function prepareCosineParityCase(testCase: CosineParityCase) {
  const memory = createMemoryEntry({ object_id: "cosine-candidate", content: "Current content." });
  const query = new Float32Array(testCase.query);
  const stored = new Float32Array(testCase.stored);
  const service = new EmbeddingRecallService({
    embeddingRepo: {
      listByObjectIds: vi.fn(async () => [createEmbeddingRecord({
        object_id: memory.object_id,
        content_hash: hashMemoryContent(testCase.stale ? "Stale content." : memory.content),
        model_id: testCase.modelId,
        dimensions: testCase.dimensions,
        embedding: stored
      })])
    },
    provider: createProvider({ embedTexts: vi.fn(async () => [query]) }),
    eventLogRepo: { append: createEventAppendSpy(), queryByEntity: vi.fn(async () => []) }
  });
  const snapshot = await service.prepareRecallEmbeddingSnapshot({
    workspaceId: "workspace-1",
    runId: null,
    queryText: "cosine query",
    poolMemories: [memory],
    maxNeighbors: 0
  });
  return { memory, query, stored, snapshot };
}

function referenceRecallCosineScore(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  const dot = Array.from(left).reduce(
    (total, value, index) => total + value * (right[index] ?? 0),
    0
  );
  const similarity = dot / (Math.hypot(...left) * Math.hypot(...right));
  return Number.isFinite(similarity)
    ? Math.min(1, Math.max(0, similarity))
    : 0;
}

function expectSnapshotScore(
  actual: number | undefined,
  expected: number,
  observed: boolean
): void {
  if (!observed) {
    expect(actual).toBeUndefined();
    return;
  }
  if (expected > 0) {
    expect(actual).toBeCloseTo(expected, 7);
    return;
  }
  expect(actual).toBe(0);
}

function createEventAppendSpy() {
  return vi.fn(async (
    entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ) => ({
    event_id: `event-${entry.event_type}`,
    created_at: "2026-07-14T00:00:00.000Z",
    revision: 0,
    ...entry
  }));
}
