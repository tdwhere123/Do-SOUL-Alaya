import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import type {
  RecallServiceEmbeddingRecallPort,
  RecallServiceMemoryRepoPort
} from "../../recall/recall-service-types.js";
import {
  createDependencies,
  createMemoryEntry,
  createPreparedQueryHandle,
  createTaskSurface,
  overridePolicy
} from "./recall-service-test-fixtures.js";

describe("RecallService embedding-on coarse injection", () => {
  // A memory whose content shares no lexical token with the recall query, so
  // coarse FTS / deterministic filtering never admits it. The only path that
  // can surface it is the embedding-on workspace cosine-neighbor injection.
  const lexicallyAbsentMemory = createMemoryEntry({
    object_id: "22222222-2222-4222-8222-222222222222",
    content: "Quarterly revenue figures for the Helsinki office.",
    activation_score: 0.05
  });

  function buildEmbeddingScopedService(input: {
    readonly collectWorkspaceNeighbors?: NonNullable<RecallServiceEmbeddingRecallPort["collectWorkspaceNeighbors"]>;
    readonly collectWorkspaceNeighborsWithMetadata?: NonNullable<
      RecallServiceEmbeddingRecallPort["collectWorkspaceNeighborsWithMetadata"]
    >;
    readonly findByIds?: NonNullable<RecallServiceMemoryRepoPort["findByIds"]>;
  }) {
    const { dependencies } = createDependencies([lexicallyAbsentMemory]);
    // `satisfies` validates the assembled ports against their precise shape
    // without widening, so missing / mistyped methods fail the typecheck gate
    // instead of being erased by an `as unknown as` cast.
    const memoryRepo = {
      ...dependencies.memoryRepo,
      ...(input.findByIds === undefined ? {} : { findByIds: input.findByIds })
    } satisfies RecallServiceMemoryRepoPort;
    const embeddingRecallService = {
      hasStoredVectors: vi.fn(async () => true),
      prepareQueryEmbedding: vi.fn(() => createPreparedQueryHandle("prepared-embedding-injection")),
      querySupplementIfReady: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]),
        similarityHintsByObjectId: Object.freeze({})
      })),
      querySupplement: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]),
        similarityHintsByObjectId: Object.freeze({})
      })),
      ...(input.collectWorkspaceNeighbors === undefined
        ? {}
        : { collectWorkspaceNeighbors: input.collectWorkspaceNeighbors }),
      ...(input.collectWorkspaceNeighborsWithMetadata === undefined
        ? {}
        : {
            collectWorkspaceNeighborsWithMetadata:
              input.collectWorkspaceNeighborsWithMetadata
          })
    } satisfies RecallServiceEmbeddingRecallPort;
    return new RecallService({
      ...dependencies,
      memoryRepo,
      embeddingRecallService
    });
  }

  function buildPolicy(service: RecallService, embeddingEnabled: boolean) {
    const basePolicy = service.buildDefaultPolicy("analyze", createTaskSurface().runtime_id);
    return overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        // Activation floor above the fixture memory's score keeps it out of
        // the precomputed-rank plane; with no lexical / evidence overlap the
        // only path into the pool is the embedding-on neighbor injection.
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          min_activation_score: 0.5
        },
        semantic_supplement: {
          enabled: true,
          max_supplement: 5,
          embedding_enabled: embeddingEnabled
        }
      }
    });
  }

  it("does not call the workspace neighbor scan when embedding is disabled", async () => {
    const collectWorkspaceNeighbors = vi.fn(async () => [
      Object.freeze({ object_id: lexicallyAbsentMemory.object_id, normalized_similarity: 0.95 })
    ]);
    const findByIds = vi.fn(async () => [lexicallyAbsentMemory]);
    const service = buildEmbeddingScopedService({ collectWorkspaceNeighbors, findByIds });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildPolicy(service, false)
    });

    expect(collectWorkspaceNeighbors).not.toHaveBeenCalled();
    expect(findByIds).not.toHaveBeenCalled();
    expect(
      result.candidates.some((candidate) => candidate.object_id === lexicallyAbsentMemory.object_id)
    ).toBe(false);
  });

  it("injects a lexically-absent cosine neighbor as a coarse candidate when embedding is enabled", async () => {
    const collectWorkspaceNeighbors = vi.fn(async () => [
      Object.freeze({ object_id: lexicallyAbsentMemory.object_id, normalized_similarity: 0.95 })
    ]);
    const findByIds = vi.fn(async () => [lexicallyAbsentMemory]);
    const service = buildEmbeddingScopedService({ collectWorkspaceNeighbors, findByIds });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildPolicy(service, true)
    });

    expect(collectWorkspaceNeighbors).toHaveBeenCalledTimes(1);
    const injected = result.candidates.find(
      (candidate) => candidate.object_id === lexicallyAbsentMemory.object_id
    );
    expect(injected).toBeDefined();
    expect(injected?.source_channels).toContain("semantic_supplement");
    expect(injected?.score_factors?.embedding_similarity).toBeCloseTo(0.95, 5);
  });

  it("counts coarse-injection query embeddings in token economy inference calls", async () => {
    const collectWorkspaceNeighborsWithMetadata = vi.fn(async () => ({
      hits: [
        Object.freeze({ object_id: lexicallyAbsentMemory.object_id, normalized_similarity: 0.95 })
      ],
      embedding_inference_calls: 1,
      query_embedding_cache_hit: false
    }));
    const findByIds = vi.fn(async () => [lexicallyAbsentMemory]);
    const service = buildEmbeddingScopedService({
      collectWorkspaceNeighborsWithMetadata,
      findByIds
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildPolicy(service, true)
    });

    expect(collectWorkspaceNeighborsWithMetadata).toHaveBeenCalledTimes(1);
    expect(result.diagnostics?.token_economy?.embedding_inference_calls).toBe(1);
  });

  it("recalls nothing extra when the embedding service exposes no neighbor scan", async () => {
    const service = buildEmbeddingScopedService({});
    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildPolicy(service, true)
    });
    expect(
      result.candidates.some((candidate) => candidate.object_id === lexicallyAbsentMemory.object_id)
    ).toBe(false);
  });
});

describe("RecallService embedding coarse-injection cap and floor", () => {
  const absentMemories: readonly MemoryEntry[] = [1, 2, 3].map((suffix) =>
    createMemoryEntry({
      object_id: `33333333-3333-4333-8333-33333333333${suffix}`,
      content: `Unrelated Helsinki revenue note ${suffix}.`,
      activation_score: 0.05
    })
  );

  function buildScopedService(
    memories: readonly MemoryEntry[],
    sims: readonly number[]
  ) {
    const { dependencies } = createDependencies([...memories]);
    const collectWorkspaceNeighbors = vi.fn(async () =>
      memories.map((memory, index) =>
        Object.freeze({
          object_id: memory.object_id,
          normalized_similarity: sims[index] ?? 0
        })
      )
    );
    const findByIds = vi.fn(async (ids: readonly string[]) =>
      memories.filter((memory) => ids.includes(memory.object_id))
    );
    const embeddingRecallService = {
      hasStoredVectors: vi.fn(async () => true),
      prepareQueryEmbedding: vi.fn(() =>
        createPreparedQueryHandle("prepared-injection-cap")
      ),
      querySupplementIfReady: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]),
        similarityHintsByObjectId: Object.freeze({})
      })),
      querySupplement: vi.fn(async () => ({
        supplementaryEntries: Object.freeze([]),
        similarityHintsByObjectId: Object.freeze({})
      })),
      collectWorkspaceNeighbors
    } satisfies RecallServiceEmbeddingRecallPort;
    return new RecallService({
      ...dependencies,
      memoryRepo: { ...dependencies.memoryRepo, findByIds },
      embeddingRecallService
    });
  }

  function buildInjectionPolicy(
    service: RecallService,
    opts: { readonly cap?: number; readonly floor?: number }
  ): RecallPolicy {
    const basePolicy = service.buildDefaultPolicy(
      "analyze",
      createTaskSurface().runtime_id
    );
    return overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        precomputed_rank: {
          ...basePolicy.coarse_filter.precomputed_rank,
          min_activation_score: 0.5
        },
        semantic_supplement: {
          enabled: true,
          max_supplement: 10,
          embedding_enabled: true,
          ...(opts.cap === undefined ? {} : { injection_cap: opts.cap }),
          ...(opts.floor === undefined
            ? {}
            : { injection_similarity_floor: opts.floor })
        }
      }
    });
  }

  it("honors injection_cap, injecting only the top-N cosine neighbors", async () => {
    const service = buildScopedService(absentMemories, [0.95, 0.9, 0.85]);
    const result = await service.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildInjectionPolicy(service, { cap: 2 })
    });
    const injectedIds = new Set(
      absentMemories
        .map((memory) => memory.object_id)
        .filter((id) =>
          result.candidates.some((candidate) => candidate.object_id === id)
        )
    );
    expect(injectedIds.size).toBe(2);
  });

  it("excludes a sub-floor neighbor by default but injects it once the policy lowers the floor", async () => {
    const [memory] = absentMemories;
    if (memory === undefined) throw new Error("fixture missing");

    const defaultService = buildScopedService([memory], [0.4]);
    const defaultResult = await defaultService.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildInjectionPolicy(defaultService, {})
    });
    expect(
      defaultResult.candidates.some(
        (candidate) => candidate.object_id === memory.object_id
      )
    ).toBe(false);

    const loweredService = buildScopedService([memory], [0.4]);
    const loweredResult = await loweredService.recall({
      taskSurface: createTaskSurface(),
      workspaceId: "workspace-1",
      strategy: "analyze",
      policyOverride: buildInjectionPolicy(loweredService, { floor: 0.3 })
    });
    expect(
      loweredResult.candidates.some(
        (candidate) => candidate.object_id === memory.object_id
      )
    ).toBe(true);
  });
});
