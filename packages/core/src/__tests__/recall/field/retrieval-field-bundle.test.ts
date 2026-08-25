import { describe, expect, it, vi } from "vitest";

import { createRecallRetrievalFieldBundle } from
  "../../../recall/field/retrieval/retrieval-field-bundle.js";
import {
  addSemanticSupplementCandidates,
  type SemanticSupplementParams
} from "../../../recall/coarse-filter/coarse-filter-semantic.js";
import { buildDefaultPolicy } from
  "../../../recall/runtime/orchestration.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { createCandidate } from "../fine-assessment-selection-fixtures.js";
import type {
  KeywordSearchLaneScope,
  RecallServiceMemoryRepoPort
} from "../../../recall/runtime/recall-service-ports.js";

describe("request-scoped retrieval field bundle", () => {
  it("shares one scored field result between admission and capture", async () => {
    const searchByKeywordField = vi.fn(async () => fieldResult("memory-1", 0.75));
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo({ searchByKeywordField })
    });
    const request = {
      variant: "lexical_relaxed" as const,
      queryText: "deploy",
      limit: 10,
      scope: { tier: "hot" as const }
    };

    const first = await bundle.searchMemoryKeyword(request);
    const second = await bundle.searchMemoryKeyword(request);
    const capture = bundle.captures().find(({ channel }) =>
      channel.channel_id === "lexical_relaxed_porter");

    expect(searchByKeywordField).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first[0]?.normalized_rank).toBe(0.75);
    expect(capture?.channel).toMatchObject({
      status: "complete",
      depth: 1,
      observations: [{
        candidate_key: "workspace_local:memory_entry:memory-1",
        rank: 1
      }]
    });
    expect(bundle.memoryKeywordLanes()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lane: "porter",
        status: "complete",
        depth: 1,
        observations: [expect.objectContaining({
          object_id: "memory-1",
          normalized_rank: 0.75
        })]
      })
    ]));
  });

  it("exposes memory keyword lanes from recorded field results, not evidence", async () => {
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo({
        searchByKeywordField: vi.fn(async () => fieldResult("memory-1", 0.75))
      }),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(),
        searchByKeywordField: vi.fn(async () => fieldResult("evidence-1", 0.9))
      }
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_expanded",
      queryText: "deploy",
      limit: 10,
      scope: {}
    });
    await bundle.searchEvidenceKeyword({ queryText: "deploy", limit: 10 });
    expect(bundle.memoryKeywordLanes().flatMap((lane) =>
      lane.observations.map((observation) => observation.object_id)
    )).toEqual(["memory-1"]);
  });

  it("keeps scope in the request identity and aggregates both receipts", async () => {
    const searchByKeywordField = vi.fn(async (
      _workspaceId: string,
      _queryText: string,
      _limit: number,
      scope?: Readonly<{ readonly tier?: "hot" | "warm" }>
    ) => fieldResult(`memory-${scope?.tier ?? "none"}`, 1));
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo({ searchByKeywordField })
    });

    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 10,
      scope: { tier: "hot" }
    });
    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 10,
      scope: { tier: "warm" }
    });

    expect(searchByKeywordField).toHaveBeenCalledTimes(2);
    expect(bundle.captures().find(({ channel }) =>
      channel.channel_id === "lexical_relaxed_porter")?.channel.depth).toBe(2);
  });

  it("fails closed when a producer is absent or rejects", async () => {
    const onFailure = vi.fn();
    const absent = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo()
    });
    await expect(absent.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 10,
      scope: {}
    })).resolves.toEqual([]);
    expect(absent.captures().find(({ channel }) =>
      channel.channel_id === "lexical_relaxed_porter")?.channel.status).toBe("unavailable");

    let attempts = 0;
    const failed = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo({
        searchByKeywordField: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("field failure");
          return fieldResult("retried", 1);
        }
      }),
      onFailure
    });
    await expect(failed.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 10,
      scope: {}
    })).rejects.toThrow("field failure");
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(failed.captures().find(({ channel }) =>
      channel.channel_id === "lexical_relaxed_porter")?.channel.status).toBe("unavailable");
    await expect(failed.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 10,
      scope: {}
    })).resolves.toEqual([{ object_id: "retried", normalized_rank: 1 }]);
    expect(attempts).toBe(2);
  });

  it("seeds scalar request identity from a successful field batch", async () => {
    const searchByKeywordField = vi.fn(async () => fieldResult("scalar", 0.5));
    const searchManyByKeywordField = vi.fn(async () => [
      fieldResult("evidence-1", 1),
      fieldResult("evidence-2", 0.8)
    ]);
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(),
        searchByKeywordField,
        searchManyByKeywordField
      }
    });
    const queries = [
      { queryText: "deploy", limit: 10 },
      { queryText: "release", limit: 10 }
    ];

    const batches = await bundle.searchEvidenceKeywords({ queries });
    const cached = await bundle.searchEvidenceKeyword(queries[0]!);

    expect(searchManyByKeywordField).toHaveBeenCalledTimes(1);
    expect(searchByKeywordField).not.toHaveBeenCalled();
    expect(batches.map((batch) => batch[0]?.object_id)).toEqual([
      "evidence-1", "evidence-2"
    ]);
    expect(cached[0]?.object_id).toBe("evidence-1");
    expect(bundle.captures().find(({ channel }) =>
      channel.channel_id === "evidence_fts_porter")?.channel.depth).toBe(2);
  });

  it("rejects a partial field batch and retries every request through scalar fields", async () => {
    const onBatchFailure = vi.fn();
    const searchByKeywordField = vi.fn(async (
      _workspaceId: string,
      queryText: string
    ) => fieldResult(`scalar-${queryText}`, 0.6));
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(),
        searchByKeywordField,
        searchManyByKeywordField: vi.fn(async () => [fieldResult("partial", 1)])
      },
      onBatchFailure
    });

    const batches = await bundle.searchEvidenceKeywords({
      queries: [
        { queryText: "deploy", limit: 10 },
        { queryText: "release", limit: 10 }
      ]
    });

    expect(onBatchFailure).toHaveBeenCalledWith(
      "evidence_field_batch",
      expect.objectContaining({
        failureClass: "result_count_mismatch",
        returnedCount: 1
      })
    );
    expect(searchByKeywordField).toHaveBeenCalledTimes(2);
    expect(batches.map((batch) => batch[0]?.object_id)).toEqual([
      "scalar-deploy", "scalar-release"
    ]);
  });

  it("uses scalar fields directly when the batch producer is absent", async () => {
    const onBatchFailure = vi.fn();
    const searchByKeywordField = vi.fn(async (
      _workspaceId: string,
      queryText: string
    ) => fieldResult(queryText, 1));
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(),
        searchByKeywordField
      },
      onBatchFailure
    });

    await expect(bundle.searchEvidenceKeywords({
      queries: [
        { queryText: "deploy", limit: 10 },
        { queryText: "release", limit: 10 }
      ]
    })).resolves.toHaveLength(2);
    expect(searchByKeywordField).toHaveBeenCalledTimes(2);
    expect(onBatchFailure).not.toHaveBeenCalled();
  });

  it("records prefix-preserving depth growth and score recalibration without widening admission", async () => {
    const searchByKeywordField = vi.fn(async (
      _workspaceId: string,
      _queryText: string,
      _limit: number,
      _scope?: Readonly<KeywordSearchLaneScope>,
      _refinementDepths?: readonly number[]
    ) => refinementFieldResult());
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      refinementMaxDepth: 2,
      memoryRepo: stubMemoryRepo({ searchByKeywordField })
    });

    const matches = await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 1,
      scope: {}
    });
    const maximumMatches = await bundle.forObservationView("maximum")
      .searchMemoryKeyword({
        variant: "lexical_relaxed",
        queryText: "deploy",
        limit: 1,
        scope: {}
      });
    const receipt = bundle.refinementReceipts()[0];

    expect(bundle.observationView).toBe("requested");
    expect(bundle.forObservationView("maximum").observationView).toBe("maximum");
    expect(matches.map(({ object_id }) => object_id)).toEqual(["memory-1"]);
    expect(maximumMatches).toEqual([
      { object_id: "memory-1", normalized_rank: 0.75 },
      { object_id: "memory-2", normalized_rank: 0.25 }
    ]);
    expect(searchByKeywordField).toHaveBeenCalledTimes(1);
    expect(searchByKeywordField.mock.calls[0]?.[4]).toEqual([2]);
    expect(receipt).toMatchObject({
      schema_version: 1,
      activation_mode: "live",
      requested_depths: [1, 2],
      stop_reason: "all_channels_closed",
      candidate_membership_changed: false
    });
    expect(receipt?.lanes.find(({ lane }) => lane === "porter")).toMatchObject({
      levels: [
        { requested_depth: 1, new_observation_ids: [expect.stringContaining("memory-1")] },
        {
          requested_depth: 2,
          new_observation_ids: [expect.stringContaining("memory-2")],
          score_recalibrations: [{ from: 1, to: 0.75 }]
        }
      ]
    });
  });

  it("does not claim a maximum view when the producer returned no refinement", async () => {
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo({
        searchByKeywordField: vi.fn(async () => fieldResult("memory-1", 1))
      })
    });

    await bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 1,
      scope: {}
    });
    const maximum = bundle.forObservationView("maximum");
    await expect(maximum.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 1,
      scope: {}
    })).resolves.toEqual([]);
    expect(maximum.maximumObservationAvailable()).toBe(false);
  });

  it("rejects a deeper result whose ordered identity prefix changes", async () => {
    const onFailure = vi.fn();
    const result = refinementFieldResult();
    const mismatched = {
      ...result,
      refinement_levels: [{
        ...result.refinement_levels[0]!,
        lanes: result.refinement_levels[0]!.lanes.map((lane) =>
          lane.lane !== "porter" ? lane : {
            ...lane,
            observations: [
              { object_id: "changed", rank: 1, normalized_rank: 1 },
              lane.observations[1]!
            ]
          })
      }]
    };
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      memoryRepo: stubMemoryRepo({
        searchByKeywordField: vi.fn(async () => mismatched)
      }),
      onFailure
    });

    await expect(bundle.searchMemoryKeyword({
      variant: "lexical_relaxed",
      queryText: "deploy",
      limit: 1,
      scope: {}
    })).rejects.toThrow(/prefix/u);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(bundle.refinementReceipts()).toHaveLength(0);
  });

  it("feeds maximum observations through the same coarse admission owner", async () => {
    const searchByKeywordField = vi.fn(async () => refinementFieldResult());
    const bundle = createRecallRetrievalFieldBundle({
      workspaceId: "workspace-1",
      queryText: "deploy",
      refinementMaxDepth: 2,
      memoryRepo: stubMemoryRepo({ searchByKeywordField })
    });
    const entries = ["memory-1", "memory-2"].map((id) => createCandidate(id).entry);
    const requested = createSemanticAdmissionFixture(bundle, entries);
    const maximum = createSemanticAdmissionFixture(
      bundle.forObservationView("maximum"),
      entries
    );

    await addSemanticSupplementCandidates(requested.params);
    const requestedCallCount = searchByKeywordField.mock.calls.length;
    await addSemanticSupplementCandidates(maximum.params);

    expect(requested.admitted()).toEqual(["memory-1"]);
    expect(maximum.admitted()).toEqual(["memory-1", "memory-2"]);
    expect(requested.params.ftsRanks).toEqual(new Map([["memory-1", 1]]));
    expect(maximum.params.ftsRanks).toEqual(new Map([
      ["memory-1", 0.75],
      ["memory-2", 0.25]
    ]));
    expect(requestedCallCount).toBeGreaterThan(0);
    expect(searchByKeywordField).toHaveBeenCalledTimes(requestedCallCount);
  });
});

function createSemanticAdmissionFixture(
  retrievalFieldBundle: SemanticSupplementParams["retrievalFieldBundle"],
  entries: readonly ReturnType<typeof createCandidate>["entry"][]
) {
  const queryProbes = compileRecallQueryProbes("deploy");
  const addCandidate = vi.fn();
  const basePolicy = buildDefaultPolicy({
    strategy: "chat",
    taskSurfaceRef: "field-refinement-test",
    now: () => "2026-08-05T00:00:00.000Z",
    generateRuntimeId: () => "11111111-1111-4111-8111-111111111111"
  });
  const params: SemanticSupplementParams = {
    context: {
      dependencies: { memoryRepo: {} },
      warn: vi.fn()
    } as unknown as SemanticSupplementParams["context"],
    workspaceId: "workspace-1",
    config: {
      ...basePolicy.coarse_filter,
      semantic_supplement: {
        ...basePolicy.coarse_filter.semantic_supplement,
        enabled: true,
        max_supplement: 1,
        field_observation_max_depth: 2
      }
    },
    queryText: "deploy",
    queryProbes,
    tier: "hot",
    tierScopedSearchEligible: true,
    byId: new Map(entries.map((entry) => [entry.object_id, entry])),
    addCandidate,
    ftsRanks: new Map(),
    trigramFtsRanks: new Map(),
    evidenceFtsRanks: new Map(),
    evidenceFtsRanksPerRef: new Map(),
    evidenceProjectionMatchesByRef: new Map(),
    retrievalFieldBundle
  };
  return Object.freeze({
    params,
    admitted: () => [...new Set(addCandidate.mock.calls.map(
      ([entry]) => entry.object_id as string
    ))]
  });
}

function stubMemoryRepo(
  overrides: Partial<RecallServiceMemoryRepoPort> = {}
): Readonly<RecallServiceMemoryRepoPort> {
  return {
    findByWorkspaceId: async () => [],
    findByDimension: async () => [],
    findByScopeClass: async () => [],
    ...overrides
  };
}

function fieldResult(objectId: string, normalizedRank: number) {
  return Object.freeze({
    matches: Object.freeze([{ object_id: objectId, normalized_rank: normalizedRank }]),
    lanes: Object.freeze([
      emptyLane("exact"),
      Object.freeze({
        lane: "porter" as const,
        status: "complete" as const,
        depth: 1,
        observations: Object.freeze([{
          object_id: objectId,
          rank: 1,
          normalized_rank: normalizedRank
        }]),
        unseen_upper_bound: 0
      }),
      emptyLane("trigram")
    ])
  });
}

function emptyLane(lane: "exact" | "trigram") {
  return Object.freeze({
    lane,
    status: "ineligible" as const,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}

function refinementFieldResult() {
  const original = fieldResult("memory-1", 1);
  const base = Object.freeze({
    ...original,
    lanes: Object.freeze(original.lanes.map((lane) =>
      lane.lane !== "porter" ? lane : Object.freeze({
        ...lane,
        status: "truncated" as const,
        unseen_upper_bound: 1
      })))
  });
  return Object.freeze({
    ...base,
    refinement_levels: Object.freeze([Object.freeze({
      requested_depth: 2,
      matches: Object.freeze([
        { object_id: "memory-1", normalized_rank: 0.75 },
        { object_id: "memory-2", normalized_rank: 0.25 }
      ]),
      lanes: Object.freeze([
        emptyLane("exact"),
        Object.freeze({
          lane: "porter" as const,
          status: "complete" as const,
          depth: 2,
          observations: Object.freeze([
            { object_id: "memory-1", rank: 1, normalized_rank: 0.75 },
            { object_id: "memory-2", rank: 2, normalized_rank: 0.25 }
          ]),
          unseen_upper_bound: 0
        }),
        emptyLane("trigram")
      ])
    })])
  });
}
