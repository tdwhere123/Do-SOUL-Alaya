import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecallServiceEmbeddingRecallPort } from "../../recall/runtime/recall-service-types.js";
import { RecallService } from "../../recall/recall-service.js";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../config/index.js";
import { buildExpandedKeywordQuery } from "../../recall/coarse-filter/coarse-candidates.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { deriveQuerySoughtFacets } from "../../recall/query/query-facet-router.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

describe("recall query product semantics", () => {
  it("treats relative dates as default query semantics", () => {
    expect(compileRecallQueryProbes("What changed five days ago?").date_terms)
      .toContain("five days ago");
    expect(compileRecallQueryProbes("Who joined last Saturday?").date_terms)
      .toContain("last Saturday");
  });

  it("routes relationship concepts through facets without lexical family fitting", () => {
    const probes = compileRecallQueryProbes("Which relative joined the sibling graduation?");
    const expandedQuery = buildExpandedKeywordQuery(probes) ?? "";
    expect(deriveQuerySoughtFacets(probes)).toContain("relationship_person");
    expect(expandedQuery.split(" ")).not.toEqual(expect.arrayContaining([
      "parent", "parents", "brother", "sister", "spouse", "wife"
    ]));
  });

  it("does not interpret a business partner as a personal relationship", () => {
    const probes = compileRecallQueryProbes("Which business partner owns the integration?");
    expect(deriveQuerySoughtFacets(probes)).not.toContain("relationship_person");
  });

  it("keeps noun suffixes and irregular plurals free of fabricated stems", () => {
    expect(compileRecallQueryProbes("sibling ceiling family").expanded_terms)
      .toEqual(expect.arrayContaining(["siblings", "families"]));
    expect(compileRecallQueryProbes("sibling ceiling family").expanded_terms)
      .toEqual(expect.not.arrayContaining(["sibl", "sible", "ceil", "ceile", "familys"]));
  });
});

describe("recall embedding query contract", () => {
  afterEach(() => {
    resetCoreConfigForTests();
  });

  it("uses the normalized product query for every bi scoring path", async () => {
    installCoreConfigFromProcessEnv({
      ALAYA_RECALL_EMBED_POOL_RESCORE: "off",
      ALAYA_RECALL_QUERY_HYDE_JSON: "{\"real product query\":\"synthetic hypothesis\"}"
    });
    const memory = createMemoryEntry({ content: "Real product query procedure" });
    const { dependencies } = createDependencies([memory]);
    const scorePoolCandidates = vi.fn(async () => new Map([[memory.object_id, 0.9]]));
    const collectWorkspaceNeighbors = vi.fn(async () => Object.freeze([]));
    const embeddingRecallService = {
      querySupplement: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]),
        similarityHintsByObjectId: Object.freeze({})
      })),
      collectWorkspaceNeighbors,
      scorePoolCandidates
    } satisfies RecallServiceEmbeddingRecallPort;
    const service = new RecallService({
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByIds: vi.fn(async () => []) },
      embeddingRecallService
    });
    const taskSurface = { ...createTaskSurface(), display_name: "  Real product query  " };
    const basePolicy = service.buildDefaultPolicy("analyze", taskSurface.runtime_id);
    const policyOverride = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          ...basePolicy.coarse_filter.semantic_supplement,
          embedding_enabled: true
        }
      }
    });

    await service.recall({ taskSurface, workspaceId: "workspace-1", strategy: "analyze", policyOverride });

    expect(scorePoolCandidates).toHaveBeenCalledWith(expect.objectContaining({
      queryText: "Real product query"
    }));
    expect(collectWorkspaceNeighbors).toHaveBeenCalledWith(expect.objectContaining({
      queryText: "Real product query"
    }));
  });
});
