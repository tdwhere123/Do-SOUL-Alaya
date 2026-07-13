import { describe, expect, it, vi } from "vitest";
import { collectEntityDerivedSeeds } from "../../recall/expansion/structural-expansion.js";
import { createDependencies, createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("entity seed bulk parity", () => {
  it("preserves serial results while transferring candidate ids once", async () => {
    const serial = await runEntitySeedCollection();
    const bulk = await runEntitySeedCollection({ withBulk: true });

    expect(bulk.results).toEqual(serial.results);
    expect(bulk.admitted).toEqual(serial.admitted);
    expect(serial.singleSearch).toHaveBeenCalledTimes(3);
    expect(bulk.singleSearch).not.toHaveBeenCalled();
    expect(bulk.bulkSearch).toHaveBeenCalledTimes(1);
    expect(bulk.bulkSearch).toHaveBeenCalledWith(
      "workspace-1",
      [
        { queryText: "AlphaRouter", limit: 8 },
        { queryText: "BetaPlanner", limit: 8 },
        { queryText: "GammaWorker", limit: 5 }
      ],
      ["alpha", "beta", "gamma"]
    );
  });
});

describe("entity seed bulk fallback", () => {
  it("falls back to independent reads when the bulk operation fails", async () => {
    const serial = await runEntitySeedCollection();
    const bulkFailure = await runEntitySeedCollection({ withBulk: true, bulkFails: true });

    expect(bulkFailure.results).toEqual(serial.results);
    expect(bulkFailure.admitted).toEqual(serial.admitted);
    expect(bulkFailure.bulkSearch).toHaveBeenCalledTimes(1);
    expect(bulkFailure.singleSearch).toHaveBeenCalledTimes(3);
    expect(bulkFailure.warn).toHaveBeenCalledTimes(1);
    expect(bulkFailure.warn).toHaveBeenCalledWith(
      "entity seed bulk lookup failed; using scalar lookups",
      {
        operation: "entity_seed_bulk_lookup",
        failure_class: "service_error",
        expected_count: 3,
        actual_count: 0
      }
    );
  });

  it("warns once and falls back when the bulk result count is incomplete", async () => {
    const serial = await runEntitySeedCollection();
    const mismatch = await runEntitySeedCollection({ withBulk: true, bulkCountMismatch: true });

    expect(mismatch.results).toEqual(serial.results);
    expect(mismatch.singleSearch).toHaveBeenCalledTimes(3);
    expect(mismatch.warn).toHaveBeenCalledTimes(1);
    expect(mismatch.warn).toHaveBeenCalledWith(
      "entity seed bulk lookup failed; using scalar lookups",
      {
        operation: "entity_seed_bulk_lookup",
        failure_class: "result_count_mismatch",
        expected_count: 3,
        actual_count: 2
      }
    );
  });
});

describe("entity seed optional search ports", () => {
  it("uses a bulk-only port for a single entity lookup", async () => {
    const result = await runEntitySeedCollection({
      withBulk: true,
      withScalar: false,
      surfaces: ["AlphaRouter"]
    });

    expect(result.admitted).toEqual(["alpha"]);
    expect(result.bulkSearch).toHaveBeenCalledTimes(1);
    expect(result.singleSearch).not.toHaveBeenCalled();
    expect(result.warn).not.toHaveBeenCalled();
  });

  it("returns no seeds when bulk fails and no scalar fallback exists", async () => {
    const result = await runEntitySeedCollection({
      withBulk: true,
      withScalar: false,
      bulkFails: true
    });

    expect(result.results).toEqual([]);
    expect(result.admitted).toEqual([]);
    expect(result.singleSearch).not.toHaveBeenCalled();
    expect(result.warn).toHaveBeenCalledWith(
      "entity seed bulk lookup failed; skipping entity seeds",
      expect.objectContaining({
        operation: "entity_seed_bulk_lookup",
        failure_class: "service_error"
      })
    );
  });

  it("skips safely when no entity search port exists", async () => {
    const result = await runEntitySeedCollection({ withScalar: false });

    expect(result.results).toEqual([]);
    expect(result.admitted).toEqual([]);
    expect(result.warn).toHaveBeenCalledWith(
      "entity seed lookup unavailable; skipping entity seeds",
      expect.objectContaining({
        operation: "entity_seed_lookup",
        failure_class: "no_search_port"
      })
    );
  });
});

type EntitySeedFixtureOptions = Readonly<{
  readonly withBulk?: boolean;
  readonly withScalar?: boolean;
  readonly bulkFails?: boolean;
  readonly bulkCountMismatch?: boolean;
  readonly surfaces?: readonly string[];
}>;

async function runEntitySeedCollection(options: EntitySeedFixtureOptions = {}) {
  const memories = [
    createMemoryEntry({ object_id: "alpha", content: "AlphaRouter details" }),
    createMemoryEntry({ object_id: "beta", content: "BetaPlanner details" }),
    createMemoryEntry({ object_id: "gamma", content: "GammaWorker details" })
  ];
  const byQuery = new Map<string, readonly Readonly<{ object_id: string; normalized_rank: number }>[]>([
    ["AlphaRouter", [{ object_id: "alpha", normalized_rank: 0.9 }]],
    ["BetaPlanner", [{ object_id: "beta", normalized_rank: 0.8 }]],
    ["GammaWorker", [{ object_id: "gamma", normalized_rank: 0.7 }]]
  ]);
  const { singleSearch, bulkSearch } = buildSearchPorts(options, byQuery);
  const { dependencies } = createDependencies(memories);
  const admitted: string[] = [];
  const memoryRepo = {
    ...dependencies.memoryRepo,
    ...(options.withScalar === false ? {} : { searchByKeywordWithinObjectIds: singleSearch }),
    ...(options.withBulk === true ? { searchManyByKeywordWithinObjectIds: bulkSearch } : {})
  };
  const warn = vi.fn();
  const results = await collectEntityDerivedSeeds({
    workspaceId: "workspace-1",
    queryText: "entity query",
    byId: new Map(memories.map((memory) => [memory.object_id, memory])),
    addCandidate: (entry) => {
      admitted.push(entry.object_id);
      return true;
    },
    lexicalFtsRanks: new Map(),
    entityExtractionPort: {
      extract: async () => buildEntities(options.surfaces)
    },
    memoryRepo,
    warn,
    entityExtractionMaxEntities: 8,
    entitySeedPerEntityTopKStrong: 8,
    entitySeedPerEntityTopKWeak: 5,
    entitySeedTotalAdmitCap: 60,
    entitySeedMinSurfaceLength: 2
  });
  return { results, admitted, singleSearch, bulkSearch, warn };
}

function buildSearchPorts(
  options: EntitySeedFixtureOptions,
  byQuery: ReadonlyMap<string, readonly Readonly<{ object_id: string; normalized_rank: number }>[]>
) {
  const singleSearch = vi.fn(async (_workspaceId: string, queryText: string) =>
    byQuery.get(queryText) ?? []
  );
  const bulkSearch = vi.fn(async (
    _workspaceId: string,
    queries: readonly Readonly<{ readonly queryText: string; readonly limit: number }>[],
    _objectIds: readonly string[]
  ) => {
    if (options.bulkFails === true) throw new Error("bulk read failed");
    const results = queries.map((query) => byQuery.get(query.queryText) ?? []);
    return options.bulkCountMismatch === true ? results.slice(0, -1) : results;
  });
  return { singleSearch, bulkSearch };
}

function buildEntities(surfaces: readonly string[] | undefined) {
  const confidence = new Map([["AlphaRouter", 1], ["BetaPlanner", 0.9], ["GammaWorker", 0.7]]);
  return (surfaces ?? [...confidence.keys()]).map((surface) =>
    entity(surface, confidence.get(surface) ?? 0.7)
  );
}

function entity(surface: string, confidence: number) {
  return Object.freeze({
    surface,
    normalized: surface.toLowerCase(),
    kind: "proper_noun" as const,
    confidence
  });
}
