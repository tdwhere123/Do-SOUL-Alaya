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
}): EmbeddingRecallService {
  return new EmbeddingRecallService({
    embeddingRepo: {
      listByObjectIds: vi.fn(async () => input.storedVectors),
      listByWorkspace: vi.fn(async () => [])
    },
    provider: createProvider({
      isAvailable: input.isAvailable ?? true,
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
    generateQueryId: () => "query-pool-1",
    now: () => "2026-04-23T00:00:00.000Z"
  });
}

describe("EmbeddingRecallService.scorePoolCandidates", () => {
  it("scores provider-matched pooled candidates by cosine; drops orthogonal/mismatched", async () => {
    const service = buildService({
      queryEmbedding: new Float32Array([1, 0]),
      storedVectors: [
        createEmbeddingRecord({ object_id: "aligned", embedding: new Float32Array([1, 0]) }),
        createEmbeddingRecord({ object_id: "orthogonal", embedding: new Float32Array([0, 1]) }),
        createEmbeddingRecord({ object_id: "mismatch", model_id: "other-model", embedding: new Float32Array([1, 0]) })
      ]
    });
    const scores = await service.scorePoolCandidates({
      workspaceId: "workspace-1",
      runId: "run-1",
      queryText: "anything",
      objectIds: ["aligned", "orthogonal", "mismatch"]
    });
    expect(scores.get("aligned")).toBeCloseTo(1, 5);
    expect(scores.has("orthogonal")).toBe(false); // cosine 0 is not > 0
    expect(scores.has("mismatch")).toBe(false); // provider model mismatch
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
});
