import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  buildEvidenceSearchQueries,
  buildInformativeEvidenceSearchQueries,
  selectEvidenceSearchQueries
} from "../../recall/coarse-filter/evidence/search-query-planner.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-8factor-test-fixtures.js";

describe("evidence search query construction", () => {
  it("keeps the shared legacy query list unchanged", () => {
    const probes = {
      ...compileRecallQueryProbes(null),
      phrases: ["quoted phrase"],
      lexical_terms: ["alpha", "beta"],
      expanded_terms: ["alphas", "betas"],
      date_terms: ["2026-07-14"]
    };

    expect(buildEvidenceSearchQueries("the broad raw query", probes)).toEqual([
      "the broad raw query",
      "quoted phrase",
      "alpha beta",
      "alphas betas",
      "2026-07-14"
    ]);
  });

  it("builds informative probes without copying a broad natural query", () => {
    const rawQuery = "What was the deployment configuration for the database that we used and why?";
    const queries = buildInformativeEvidenceSearchQueries(
      compileRecallQueryProbes(rawQuery)
    );

    expect(queries).not.toContain(rawQuery);
    expect(queries.some((query) =>
      query.includes("deployment") && query.includes("database")
    )).toBe(true);
  });

  it("shares the legacy short-phrase filter with synthesis queries", () => {
    const probes = {
      ...compileRecallQueryProbes(null),
      phrases: ["ab", "abc"]
    };

    expect(buildInformativeEvidenceSearchQueries(probes)).toEqual(["abc"]);
    expect(buildEvidenceSearchQueries("raw fallback", probes)).toEqual([
      "raw fallback",
      "abc"
    ]);
  });
});

describe("evidence search query coverage", () => {
  it("retains direct keyword and CJK surface coverage", () => {
    expect(selectEvidenceSearchQueries(
      "zylphqorbex",
      compileRecallQueryProbes("zylphqorbex")
    )).toContain("zylphqorbex");

    const cjkQueries = selectEvidenceSearchQueries(
      "我喜欢咖啡",
      compileRecallQueryProbes("我喜欢咖啡")
    );
    expect(cjkQueries.some((query) => query.split(/\s+/u).includes("我喜欢咖啡"))).toBe(true);
  });

  it("omits the raw natural-language query when informative probes exist", () => {
    const rawQuery = "What was the deployment configuration for the database that we used and why?";
    const queries = selectEvidenceSearchQueries(rawQuery, compileRecallQueryProbes(rawQuery));

    expect(queries).not.toContain(rawQuery);
    expect(queries.length).toBeGreaterThan(0);
  });

  it("uses the raw query when no informative probe exists", () => {
    expect(selectEvidenceSearchQueries(
      "why and where",
      compileRecallQueryProbes("why and where")
    )).toEqual(["why and where"]);
  });
});

describe("evidence scalar reference", () => {
  it("uses informative evidence queries and preserves max-rank merging", async () => {
    const { evidenceSearch, rawQuery, service } = createReferenceQuerySetFixture();

    const result = await service.recall({
      taskSurface: createTaskSurface(rawQuery),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(evidenceSearch).toHaveBeenCalled();
    expect(evidenceSearch.mock.calls.map((call) => call[1])).not.toContain(rawQuery);
    const expectedQueries = selectEvidenceSearchQueries(rawQuery, compileRecallQueryProbes(rawQuery));
    const calledQueries = evidenceSearch.mock.calls.map((call) => call[1]);
    expect(calledQueries.length % expectedQueries.length).toBe(0);
    for (let offset = 0; offset < calledQueries.length; offset += expectedQueries.length) {
      expect(calledQueries.slice(offset, offset + expectedQueries.length)).toEqual(expectedQueries);
    }
    const diagnostics = result.diagnostics?.candidates ?? [];
    expect(diagnostics.find((candidate) => candidate.object_id === "memory-first")
      ?.per_stream_rank.evidence_fts).toBe(1);
    expect(diagnostics.find((candidate) => candidate.object_id === "memory-second")
      ?.per_stream_rank.evidence_fts).toBe(2);
  });
});

describe("evidence batch parity", () => {
  it("uses one index-aligned batch without changing reference results", async () => {
    const fixture = createEvidenceBatchFixture();
    const scalarResult = await fixture.run({ useBatch: false });
    const batchResult = await fixture.run({ useBatch: true });

    expect(batchResult.candidateRanks).toEqual(scalarResult.candidateRanks);
    expect(batchResult.batchSearch.mock.calls.length * fixture.queries.length).toBe(
      scalarResult.scalarSearch.mock.calls.length
    );
    expect(batchResult.scalarSearch).not.toHaveBeenCalled();
    for (const call of batchResult.batchSearch.mock.calls) {
      expect(call[1]).toEqual(
        fixture.queries.map((queryText) => ({ queryText, limit: expect.any(Number) }))
      );
    }
  });
});

describe("evidence batch failure fallback", () => {
  it.each([
    ["service_error", "throw"],
    ["result_count_mismatch", "count"],
    ["result_shape_mismatch", "shape"]
  ] as const)("retries the complete scalar reference after %s", async (failureClass, failureMode) => {
    const fixture = createEvidenceBatchFixture();
    const reference = await fixture.run({ useBatch: false });
    const fallback = await fixture.run({ useBatch: true, failureMode });

    expect(fallback.candidateRanks).toEqual(reference.candidateRanks);
    expect(fallback.scalarSearch.mock.calls).toEqual(reference.scalarSearch.mock.calls);
    expect(fallback.warn).toHaveBeenCalledWith(
      "evidence FTS batch lookup failed; using scalar lookups",
      {
        operation: "evidence_fts_batch_lookup",
        failure_class: failureClass,
        expected_count: fixture.queries.length,
        ...expectedBatchFailureDetails(failureMode, fixture.queries.length)
      }
    );
  });
});

describe("evidence batch hit validation", () => {
  it.each([
    ["a non-string object id", { object_id: 42, normalized_rank: 0.8 }],
    ["an empty object id", { object_id: " ", normalized_rank: 0.8 }],
    ["a non-finite normalized rank", { object_id: "evidence-second", normalized_rank: Number.NaN }],
    ["a non-finite trigram rank", {
      object_id: "evidence-second",
      normalized_rank: 0.8,
      trigram_rank: Number.POSITIVE_INFINITY
    }]
  ])("retries the complete scalar reference after %s", async (_caseName, malformedHit) => {
    const fixture = createEvidenceBatchFixture();
    const reference = await fixture.run({ useBatch: false });
    const fallback = await fixture.run({ useBatch: true, malformedHit });

    expect(fallback.candidateRanks).toEqual(reference.candidateRanks);
    expect(fallback.scalarSearch.mock.calls).toEqual(reference.scalarSearch.mock.calls);
    expect(fallback.warn).toHaveBeenCalledWith(
      "evidence FTS batch lookup failed; using scalar lookups",
      expect.objectContaining({
        failure_class: "result_shape_mismatch",
        returned_count: fixture.queries.length,
        valid_batch_count: fixture.queries.length - 1,
        invalid_index: 1
      })
    );
  });
});

describe("evidence batch limit validation", () => {
  it("retries the complete scalar reference after one query exceeds its limit", async () => {
    const fixture = createEvidenceBatchFixture();
    const reference = await fixture.run({ useBatch: false });
    const fallback = await fixture.run({ useBatch: true, failureMode: "limit" });

    expect(fallback.candidateRanks).toEqual(reference.candidateRanks);
    expect(fallback.scalarSearch.mock.calls).toEqual(reference.scalarSearch.mock.calls);
    expect(fallback.warn).toHaveBeenCalledWith(
      "evidence FTS batch lookup failed; using scalar lookups",
      expect.objectContaining({
        failure_class: "result_limit_exceeded",
        returned_count: fixture.queries.length,
        valid_batch_count: fixture.queries.length - 1,
        invalid_index: 1
      })
    );
  });
});

describe("evidence scalar retry isolation", () => {
  it("admits no partial evidence results when the scalar retry fails", async () => {
    const fixture = createEvidenceBatchFixture();
    const result = await fixture.run({
      useBatch: true,
      failureMode: "throw",
      scalarFailureQuery: fixture.queries[1]
    });

    expect(result.candidateRanks).toEqual({});
    expect(result.warn).toHaveBeenCalledWith(
      "evidence FTS lookup failed",
      expect.objectContaining({ operation: "evidence_fts_lookup" })
    );
  });
});

type BatchFailureMode = "throw" | "count" | "shape" | "limit";
type EvidenceBatchOptions = Readonly<{
  readonly useBatch: boolean;
  readonly failureMode?: BatchFailureMode;
  readonly malformedHit?: unknown;
  readonly scalarFailureQuery?: string;
}>;
type EvidenceBatchState = ReturnType<typeof createEvidenceBatchState>;

function createReferenceQuerySetFixture() {
  const first = createMemoryEntry({
    object_id: "memory-first",
    evidence_refs: ["evidence-first"]
  });
  const second = createMemoryEntry({
    object_id: "memory-second",
    evidence_refs: ["evidence-second"]
  });
  const { dependencies } = createDependencies([
    first,
    second,
    createMemoryEntry({ object_id: "memory-third" })
  ]);
  const evidenceSearch = createReferenceEvidenceSearch();
  const rawQuery = "What was the deployment configuration for the database that we used and why?";
  const service = new RecallService({
    ...dependencies,
    memoryRepo: {
      ...dependencies.memoryRepo,
      searchByKeyword: vi.fn(async () => []),
      findByEvidenceRefs: vi.fn(async () => [first, second])
    },
    evidenceSearchPort: { searchByKeyword: evidenceSearch }
  });
  return { evidenceSearch, rawQuery, service };
}

function createReferenceEvidenceSearch() {
  return vi.fn(async (_workspaceId: string, query: string) =>
    query === "deployment configuration"
      ? [
          { object_id: "evidence-first", normalized_rank: 0.9 },
          { object_id: "evidence-second", normalized_rank: 0.4 }
        ]
      : [
          { object_id: "evidence-first", normalized_rank: 0.1 },
          { object_id: "evidence-second", normalized_rank: 0.8 }
        ]
  );
}

function createEvidenceBatchFixture() {
  const state = createEvidenceBatchState();
  return {
    queries: state.queries,
    run: (options: EvidenceBatchOptions) => runEvidenceBatchFixture(state, options)
  };
}

function createEvidenceBatchState() {
  const first = createMemoryEntry({ object_id: "memory-first", evidence_refs: ["evidence-first"] });
  const second = createMemoryEntry({ object_id: "memory-second", evidence_refs: ["evidence-second"] });
  const rawQuery = "What was the deployment configuration for the database that we used and why?";
  const queries = selectEvidenceSearchQueries(rawQuery, compileRecallQueryProbes(rawQuery));
  const hitsByQuery = new Map(queries.map((query, index) => [
    query,
    index === 0
      ? [{ object_id: "evidence-first", normalized_rank: 0.9 }]
      : [{ object_id: "evidence-second", normalized_rank: 0.8 }]
  ]));
  return { first, second, rawQuery, queries, hitsByQuery };
}

async function runEvidenceBatchFixture(state: EvidenceBatchState, options: EvidenceBatchOptions) {
  const { dependencies } = createDependencies([state.first, state.second]);
  const { scalarSearch, batchSearch } = createEvidenceSearchSpies(state, options);
  const warn = vi.fn();
  const service = new RecallService({
    ...dependencies,
    warn,
    memoryRepo: {
      ...dependencies.memoryRepo,
      searchByKeyword: vi.fn(async () => []),
      findByEvidenceRefs: vi.fn(async () => [state.first, state.second])
    },
    evidenceSearchPort: {
      searchByKeyword: scalarSearch,
      ...(options.useBatch ? { searchManyByKeyword: batchSearch } : {})
    }
  });
  const recall = await service.recall({
    taskSurface: createTaskSurface(state.rawQuery),
    workspaceId: "workspace-1",
    strategy: "build"
  });
  return { recall, candidateRanks: readEvidenceCandidateRanks(recall), scalarSearch, batchSearch, warn };
}

function createEvidenceSearchSpies(state: EvidenceBatchState, options: EvidenceBatchOptions) {
  const scalarSearch = vi.fn(async (_workspaceId: string, query: string) => {
    if (query === options.scalarFailureQuery) throw new Error("scalar failed");
    return state.hitsByQuery.get(query) ?? [];
  });
  const batchSearch = vi.fn(async (
    _workspaceId: string,
    lookups: readonly Readonly<{ readonly queryText: string; readonly limit: number }>[]
  ) => buildBatchResult(state, options, lookups));
  return { scalarSearch, batchSearch };
}

function buildBatchResult(
  state: EvidenceBatchState,
  options: EvidenceBatchOptions,
  lookups: readonly Readonly<{ readonly queryText: string; readonly limit: number }>[]
) {
  if (options.failureMode === "throw") throw new Error("batch failed");
  const batches = lookups.map(({ queryText }) => state.hitsByQuery.get(queryText) ?? []);
  if (options.failureMode === "count") return batches.slice(0, -1);
  if (options.failureMode === "shape") {
    return batches.map((batch, index) => index === 1 ? null : batch) as unknown as typeof batches;
  }
  if (options.failureMode === "limit") {
    return batches.map((batch, index) =>
      index === 1 ? buildOverLimitBatch(batch, lookups[index]!.limit) : batch
    );
  }
  if (options.malformedHit !== undefined) {
    return batches.map((batch, index) => index === 1 ? [options.malformedHit] : batch) as unknown as typeof batches;
  }
  return batches;
}

function buildOverLimitBatch(
  batch: readonly Readonly<{ readonly object_id: string; readonly normalized_rank: number }>[],
  limit: number
) {
  const hit = batch[0] ?? { object_id: "evidence-over-limit", normalized_rank: 0.8 };
  return Array.from({ length: limit + 1 }, () => hit);
}

function expectedBatchFailureDetails(failureMode: BatchFailureMode, expectedCount: number) {
  if (failureMode === "throw") {
    return {
      returned_count: null,
      valid_batch_count: null,
      invalid_index: null,
      errorName: "Error",
      errorMessage: "batch failed"
    };
  }
  if (failureMode === "count") {
    return {
      returned_count: expectedCount - 1,
      valid_batch_count: null,
      invalid_index: null,
      errorName: null,
      errorMessage: null
    };
  }
  return {
    returned_count: expectedCount,
    valid_batch_count: expectedCount - 1,
    invalid_index: 1,
    errorName: null,
    errorMessage: null
  };
}

function readEvidenceCandidateRanks(
  recall: Awaited<ReturnType<RecallService["recall"]>>
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    (recall.diagnostics?.candidates ?? [])
      .filter((candidate) => typeof candidate.per_stream_rank.evidence_fts === "number")
      .map((candidate) => [candidate.object_id, candidate.per_stream_rank.evidence_fts as number])
  );
}
