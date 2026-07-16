import { describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import {
  EmbeddingRecallService,
  type EmbeddingVectorRecord
} from "../../embedding-recall/embedding-recall-service.js";
import { createEmbeddingRecord, createProvider } from "./embedding-recall-test-helpers.js";

function buildService(input: {
  readonly queryEmbedding: Float32Array;
  readonly storedVectors: readonly EmbeddingVectorRecord[];
  readonly isAvailable?: boolean;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly embedTexts?: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
}): EmbeddingRecallService {
  return new EmbeddingRecallService({
    embeddingRepo: {
      listByObjectIds: vi.fn(async () => input.storedVectors),
      listByWorkspace: vi.fn(async () => [])
    },
    provider: createProvider({
      isAvailable: input.isAvailable ?? true,
      embedTexts:
        input.embedTexts === undefined
          ? vi.fn(async () => [input.queryEmbedding])
          : vi.fn(input.embedTexts)
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
    generateQueryId: () => "query-pool-1",
    now: () => "2026-04-23T00:00:00.000Z",
    warn: input.warn as ((message: string, meta: Record<string, unknown>) => void) | undefined
  });
}

describe("EmbeddingRecallService.scorePoolCandidates", () => {
  it("records valid non-positive cosine as zero and drops unusable or mismatched vectors", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([1, 0]),
      storedVectors: [
        createEmbeddingRecord({ object_id: "aligned", embedding: new Float32Array([1, 0]) }),
        createEmbeddingRecord({ object_id: "orthogonal", embedding: new Float32Array([0, 1]) }),
        createEmbeddingRecord({ object_id: "negative", embedding: new Float32Array([-1, 0]) }),
        createEmbeddingRecord({ object_id: "unrequested", embedding: new Float32Array([0, 1]) }),
        createEmbeddingRecord({ object_id: "zero-vector", embedding: new Float32Array([0, 0]) }),
        createEmbeddingRecord({
          object_id: "non-finite",
          embedding: new Float32Array([Number.POSITIVE_INFINITY, 1])
        }),
        createEmbeddingRecord({
          object_id: "dimension-mismatch",
          dimensions: 3,
          embedding: new Float32Array([1, 0])
        }),
        createEmbeddingRecord({ object_id: "mismatch", model_id: "other-model", embedding: new Float32Array([1, 0]) })
      ]
    });
    const scores = await service.scorePoolCandidates({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "anything",
      objectIds: [
        "aligned",
        "orthogonal",
        "negative",
        "zero-vector",
        "non-finite",
        "dimension-mismatch",
        "mismatch"
      ]
    });
    expect(scores.get("aligned")).toBeCloseTo(1, 5);
    expect(scores.get("orthogonal")).toBe(0);
    expect(scores.get("negative")).toBe(0);
    expect([...scores.keys()].sort()).toEqual(["aligned", "negative", "orthogonal"]);
  });

  it.each([
    ["zero norm", new Float32Array([0, 0])],
    ["non-finite", new Float32Array([Number.NaN, 1])]
  ])("treats a %s query vector as unobserved", async (_label, queryEmbedding) => {
    const service = buildService({
      queryEmbedding,
      storedVectors: [
        createEmbeddingRecord({ object_id: "candidate", embedding: new Float32Array([1, 0]) })
      ]
    });

    const scores = await service.scorePoolCandidates({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "anything",
      objectIds: ["candidate"]
    });

    expect(scores.size).toBe(0);
  });

  it("returns an empty map for empty objectIds or unavailable provider", async () => {
    const empty = buildService({ queryEmbedding: new Float32Array([1, 0]), storedVectors: [] });
    expect(
      (await empty.scorePoolCandidates({ workspaceId: "w", runId: null, queryText: "q", objectIds: [] })).size
    ).toBe(0);

    const unavailable = buildService({
      queryEmbedding: new Float32Array([1, 0]),
      storedVectors: [createEmbeddingRecord({ object_id: "aligned", embedding: new Float32Array([1, 0]) })],
      isAvailable: false
    });
    expect(
      (await unavailable.scorePoolCandidates({ workspaceId: "w", runId: null, queryText: "q", objectIds: ["aligned"] })).size
    ).toBe(0);
  });

  it("warns and degrades to an empty map when query embedding resolution fails", async () => {
    const warn = vi.fn();
    const service = buildService({
      queryEmbedding: new Float32Array([1, 0]),
      storedVectors: [createEmbeddingRecord({ object_id: "aligned", embedding: new Float32Array([1, 0]) })],
      warn,
      embedTexts: async () => {
        throw new Error("query embedding offline");
      }
    });

    const scores = await service.scorePoolCandidates({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "anything",
      objectIds: ["aligned"]
    });

    expect(scores.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "pool embedding rescoring degraded",
      expect.objectContaining({
        workspace_id: "workspace-1",
        run_id: "run-1",
        reason: "query_embedding_failed",
        error: "query embedding offline"
      })
    );
  });

  it("reuses a warmed query embedding instead of calling the provider again", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map(() => new Float32Array([1, 0]))
    );
    const service = buildService({
      queryEmbedding: new Float32Array([1, 0]),
      storedVectors: [
        createEmbeddingRecord({ object_id: "aligned", embedding: new Float32Array([1, 0]) })
      ],
      embedTexts
    });

    const warmup = await service.warmQueryEmbeddings({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryTexts: ["cached pool query"]
    });
    const scores = await service.scorePoolCandidates({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "cached pool query",
      objectIds: ["aligned"]
    });

    expect(warmup).toMatchObject({
      ready_count: 1,
      provider_requested_count: 1
    });
    expect(scores.get("aligned")).toBeCloseTo(1, 5);
    expect(embedTexts).toHaveBeenCalledTimes(1);
  });
});
