import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import {
  EMBEDDING_WORKSPACE_SCAN_CAP,
  EmbeddingRecallService,
  type EmbeddingVectorRecord
} from "../../embedding-recall/embedding-recall-service.js";
import { WorkspaceNeighborScanner } from "../../embedding-recall/workspace-neighbor-scanner.js";
import type { QueryEmbeddingEngine } from "../../embedding-recall/query-embedding-engine.js";
import {
  createEmbeddingRecord,
  createProvider
} from "./embedding-recall-test-helpers.js";

describe("EmbeddingRecallService.collectWorkspaceNeighbors", () => {
  function buildService(input: {
    readonly workspaceVectors: readonly EmbeddingVectorRecord[];
    readonly queryEmbedding: Float32Array;
    readonly listByWorkspace?: (
      workspaceId: string,
      options?: {
        readonly tierFilter?: readonly ("hot" | "warm" | "cold")[];
        readonly limit?: number;
        readonly providerKind?: string;
        readonly modelId?: string;
        readonly schemaVersion?: number;
      }
    ) => Promise<readonly EmbeddingVectorRecord[]>;
  }): EmbeddingRecallService {
    return new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => []),
        listByWorkspace:
          input.listByWorkspace ?? vi.fn(async () => input.workspaceVectors)
      },
      provider: createProvider({
        embedTexts: vi.fn(async () => [input.queryEmbedding])
      }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-neighbors-1",
      now: () => "2026-04-23T00:00:00.000Z"
    });
  }

  it("returns top-K workspace cosine neighbors ranked by similarity", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [
        createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) }),
        createEmbeddingRecord({ object_id: "far", embedding: new Float32Array([0.99, 0.05]) }),
        createEmbeddingRecord({ object_id: "mid", embedding: new Float32Array([0.7, 0.7]) })
      ]
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "what color is the sky",
      excludeObjectIds: [],
      maxNeighbors: 2
    });
    expect(neighbors.map((hit) => hit.object_id)).toEqual(["near", "mid"]);
    expect(neighbors[0]!.normalized_similarity).toBeGreaterThan(neighbors[1]!.normalized_similarity);
  });

  it("surfaces workspace-neighbor query embedding inference accounting and reuses the cache", async () => {
    const embedTexts = vi.fn(async () => [new Float32Array([0, 1])]);
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => []),
        listByWorkspace: vi.fn(async () => [
          createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) })
        ])
      },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-neighbors-1",
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const first = await service.collectWorkspaceNeighborsWithMetadata({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "what color is the sky",
      excludeObjectIds: [],
      maxNeighbors: 2
    });
    const second = await service.collectWorkspaceNeighborsWithMetadata({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "what color is the sky",
      excludeObjectIds: [],
      maxNeighbors: 2
    });

    expect(first.hits.map((hit) => hit.object_id)).toEqual(["near"]);
    expect(first.embedding_inference_calls).toBe(1);
    expect(first.query_embedding_cache_hit).toBe(false);
    expect(second.hits.map((hit) => hit.object_id)).toEqual(["near"]);
    expect(second.embedding_inference_calls).toBe(0);
    expect(second.query_embedding_cache_hit).toBe(true);
    expect(embedTexts).toHaveBeenCalledTimes(1);
  });

  it("excludes object ids that already entered the candidate pool", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [
        createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) }),
        createEmbeddingRecord({ object_id: "mid", embedding: new Float32Array([0.7, 0.7]) })
      ]
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: ["near"],
      maxNeighbors: 5
    });
    expect(neighbors.map((hit) => hit.object_id)).toEqual(["mid"]);
  });

  it("isolates vectors by provider and model so cross-provider rows never compete", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [
        createEmbeddingRecord({
          object_id: "other-provider",
          provider_kind: "local_onnx",
          embedding: new Float32Array([0, 1])
        }),
        createEmbeddingRecord({
          object_id: "other-model",
          model_id: "text-embedding-3-large",
          embedding: new Float32Array([0, 1])
        }),
        createEmbeddingRecord({ object_id: "same-space", embedding: new Float32Array([0.1, 0.99]) })
      ]
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors.map((hit) => hit.object_id)).toEqual(["same-space"]);
  });

  it("degrades to an empty result when the workspace scan throws", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [],
      listByWorkspace: vi.fn(async () => {
        throw new Error("vector table unavailable");
      })
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors).toHaveLength(0);
  });

  it("preserves the repository receiver while scanning a workspace", async () => {
    const embeddingRepo = {
      workspaceVectors: [
        createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) })
      ],
      listByObjectIds: vi.fn(async () => []),
      async listByWorkspace(): Promise<readonly EmbeddingVectorRecord[]> {
        return this.workspaceVectors;
      }
    };
    const service = new EmbeddingRecallService({
      embeddingRepo,
      provider: createProvider({
        embedTexts: vi.fn(async () => [new Float32Array([0, 1])])
      }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      }
    });

    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });

    expect(neighbors.map((hit) => hit.object_id)).toEqual(["near"]);
  });

  it("returns an empty result when the repo cannot scan the whole workspace", async () => {
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => [])
      },
      provider: createProvider({}),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      }
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors).toHaveLength(0);
  });

  it("requests the configured embedding tiers (default HOT+WARM) and probes one past the workspace cap to detect truncation", async () => {
    const listByWorkspace = vi.fn(async () => [
      createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) })
    ]);
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [],
      listByWorkspace
    });
    await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(listByWorkspace).toHaveBeenCalledTimes(1);
    expect(listByWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({
        tierFilter: ["hot", "warm"],
        limit: EMBEDDING_WORKSPACE_SCAN_CAP + 1
      })
    );
  });

  it("pushes the provider schema_version into the workspace scan options", async () => {
    const listByWorkspace = vi.fn(async () => [
      createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) })
    ]);
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [],
      listByWorkspace
    });
    await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(listByWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ schemaVersion: 1 })
    );
  });

  it("keeps gold reachable when cross-schema rows would otherwise consume the scan cap", async () => {
    const gold = createEmbeddingRecord({
      object_id: "gold",
      embedding: new Float32Array([0.05, 0.99])
    });
    const staleSchemaRows = Array.from({ length: EMBEDDING_WORKSPACE_SCAN_CAP }, (_value, index) =>
      createEmbeddingRecord({
        object_id: `stale-${index}`,
        schema_version: 2,
        embedding: new Float32Array([0.05, 0.99])
      })
    );
    const listByWorkspace = vi.fn(
      async (
        _workspaceId: string,
        options?: {
          readonly schemaVersion?: number;
          readonly limit?: number;
        }
      ) => {
        const matching = [gold, ...staleSchemaRows].filter(
          (record) =>
            options?.schemaVersion === undefined ||
            record.schema_version === options.schemaVersion
        );
        const cap = options?.limit;
        return cap === undefined ? matching : matching.slice(0, cap);
      }
    );
    const service = buildService({
      queryEmbedding: new Float32Array([0, 1]),
      workspaceVectors: [],
      listByWorkspace
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors.map((hit) => hit.object_id)).toEqual(["gold"]);
  });

  it("skips the workspace scan entirely when the provider is unavailable", async () => {
    const listByWorkspace = vi.fn(async () => []);
    const service = new EmbeddingRecallService({
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => []),
        listByWorkspace
      },
      provider: createProvider({ isAvailable: false }),
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
          event_id: "event-1",
          created_at: "2026-04-23T00:00:00.000Z",
          revision: 0,
          ...entry
        })),
        queryByEntity: vi.fn(async () => [])
      }
    });
    const neighbors = await service.collectWorkspaceNeighbors({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });
    expect(neighbors).toHaveLength(0);
    expect(listByWorkspace).not.toHaveBeenCalled();
  });

  it("warns with the real error and degrades to empty hits when query-embedding preparation throws", async () => {
    const warn = vi.fn();
    const scanner = new WorkspaceNeighborScanner({
      provider: createProvider({}),
      embeddingRepo: {
        listByObjectIds: vi.fn(async () => []),
        listByWorkspace: vi.fn(async () => [
          createEmbeddingRecord({ object_id: "near", embedding: new Float32Array([0.05, 0.99]) })
        ])
      },
      queryEngine: {
        prepareQueryEmbedding: vi.fn(() => {
          throw new Error("query engine exploded");
        })
      } as unknown as QueryEmbeddingEngine,
      queryTimeoutMs: 1000,
      warn
    });

    const result = await scanner.collectWorkspaceNeighborsWithMetadata({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "query",
      excludeObjectIds: [],
      maxNeighbors: 5
    });

    expect(result.hits).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "embedding workspace neighbor scan failed",
      expect.objectContaining({
        reason: "query_embedding_failed",
        error: "query engine exploded"
      })
    );
  });
});
