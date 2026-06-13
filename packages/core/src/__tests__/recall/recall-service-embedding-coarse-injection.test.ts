import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MemoryDimension,
  MemoryGovernanceEventType,
  ObjectLifecycleState,
  RecallContextEventType,
  ProjectMappingState,
  RetentionPolicy,
  ScopeClass,
  SynthesisStatus,
  type EventLogEntry,
  type MemoryEntry,
  type PathAnchorRef,
  type PathRelation,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallPolicy,
  type SoulActiveConstraint,
  type Slot,
  type SynthesisCapsule,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  RecallService,
  classifyGlobalCandidate,
  computeRecallTokenEconomy,
  type RecallServiceDependencies
} from "../../recall/recall-service.js";
import type {
  RecallServiceEmbeddingRecallPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort
} from "../../recall/recall-service-types.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/embedding-recall-service.js";
import { createActiveConstraint, createAnchor, createDependencies, createMemoryEntry, createPathRelation, createPreparedQueryHandle, createSlot, createTaskSurface, overridePolicy } from "./recall-service-test-fixtures.js";

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
