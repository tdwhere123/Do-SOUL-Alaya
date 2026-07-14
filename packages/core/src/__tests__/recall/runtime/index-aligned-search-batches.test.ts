import { describe, expect, it, vi } from "vitest";
import { loadIndexAlignedSearchBatches } from "../../../recall/runtime/orchestration/index-aligned-search-batches.js";

type Lookup = Readonly<{ readonly key: string; readonly limit: number }>;
type Hit = Readonly<{ readonly object_id: string }>;

const LOOKUPS: readonly Lookup[] = [
  { key: "alpha", limit: 1 },
  { key: "beta", limit: 1 }
];

describe("index-aligned search batch validation", () => {
  it.each([
    ["a sparse outer batch", createSparseOuterBatch],
    ["a sparse inner hit batch", createSparseInnerBatch]
  ] as const)("restarts the complete scalar reference after %s", async (_name, createBatch) => {
    const result = await runFallbackProof(createBatch());

    expect(result.batches).toEqual([[hit("scalar-alpha")], [hit("scalar-beta")]]);
    expect(result.searchOne).toHaveBeenCalledTimes(2);
    expect(result.onBatchFailure).toHaveBeenCalledWith({
      failureClass: "result_shape_mismatch",
      returnedCount: 2,
      validBatchCount: 1,
      invalidIndex: 1
    }, true);
  });

  it("restarts the complete scalar reference after one batch exceeds its lookup limit", async () => {
    const result = await runFallbackProof(createOverLimitBatch());

    expect(result.batches).toEqual([[hit("scalar-alpha")], [hit("scalar-beta")]]);
    expect(result.searchOne).toHaveBeenCalledTimes(2);
    expect(result.onBatchFailure).toHaveBeenCalledWith({
      failureClass: "result_limit_exceeded",
      returnedCount: 2,
      validBatchCount: 1,
      invalidIndex: 1
    }, true);
  });
});

describe("index-aligned batches without a scalar fallback", () => {
  it.each([
    ["sparse", createSparseOuterBatch, "result_shape_mismatch"],
    ["over-limit", createOverLimitBatch, "result_limit_exceeded"]
  ] as const)("admits no partial results from a %s batch", async (_name, createBatch, failureClass) => {
    const onBatchFailure = vi.fn();
    const batches = await loadIndexAlignedSearchBatches({
      lookups: LOOKUPS,
      searchMany: async () => createBatch(),
      isHit,
      maxHitsForLookup: (lookup) => lookup.limit,
      onBatchFailure
    });

    expect(batches).toEqual([[], []]);
    expect(onBatchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass, invalidIndex: 1 }),
      false
    );
  });
});

async function runFallbackProof(batchResult: unknown) {
  const searchOne = vi.fn(async (lookup: Lookup) => [hit(`scalar-${lookup.key}`)]);
  const onBatchFailure = vi.fn();
  const batches = await loadIndexAlignedSearchBatches({
    lookups: LOOKUPS,
    searchMany: async () => batchResult,
    searchOne,
    isHit,
    maxHitsForLookup: (lookup) => lookup.limit,
    onBatchFailure
  });
  return { batches, searchOne, onBatchFailure };
}

function createSparseOuterBatch(): unknown {
  const batches = new Array<readonly Hit[]>(2);
  batches[0] = [hit("batch-alpha")];
  return batches;
}

function createSparseInnerBatch(): unknown {
  const sparseHits = new Array<Hit>(1);
  return [[hit("batch-alpha")], sparseHits];
}

function createOverLimitBatch(): unknown {
  return [
    [hit("batch-alpha")],
    [hit("batch-beta-1"), hit("batch-beta-2")]
  ];
}

function isHit(value: unknown): value is Hit {
  return typeof value === "object" && value !== null &&
    typeof (value as Readonly<{ object_id?: unknown }>).object_id === "string";
}

function hit(objectId: string): Hit {
  return Object.freeze({ object_id: objectId });
}
