import { describe, expect, it, vi } from "vitest";
import { EmbeddingRecallService } from "../../embedding-recall/embedding-recall-service.js";
import { createProvider } from "./embedding-recall-test-helpers.js";

describe("EmbeddingRecallService evidence document cache", () => {
  it("keeps query and document inference accounting separate across repeated scoring", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds: vi.fn(async () => []) },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-id"
    });
    const candidates = Array.from({ length: 25 }, (_, index) => ({
      candidateKey: `evidence:${index}`,
      objectId: `object-${index}`,
      documentIdentity: "owner",
      content: `document ${index}`
    }));

    const first = await service.scoreEvidenceCandidates({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "query",
      preparedQuery: null,
      candidates
    });
    const second = await service.scoreEvidenceCandidates({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "query",
      preparedQuery: null,
      candidates
    });

    expect(embedTexts.mock.calls.map(([texts]) => texts.length)).toEqual([1, 25]);
    expect(first.inferenceCalls).toBe(2);
    expect(second.inferenceCalls).toBe(0);
    expect([...second.scores]).toEqual([...first.scores]);
  });

  it("does not reuse a query vector as the document vector for identical text", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds: vi.fn(async () => []) },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn(async () => [])
      },
      generateQueryId: () => "query-id"
    });

    await service.scoreEvidenceCandidates({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "same text",
      preparedQuery: null,
      candidates: [{
        candidateKey: "evidence:1",
        objectId: "object-1",
        documentIdentity: "owner",
        content: "same text"
      }]
    });

    expect(embedTexts.mock.calls.map(([texts]) => texts)).toEqual([
      ["same text"],
      ["same text"]
    ]);
  });

  it("keeps candidate keys aligned with document vectors in non-sorted order", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => text === "query"
        ? new Float32Array([1, 0])
        : text === "alpha"
          ? new Float32Array([1, 0])
          : new Float32Array([0, 1]))
    );
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds: vi.fn(async () => []) },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn(async () => [])
      }
    });

    const result = await service.scoreEvidenceCandidates({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "query",
      preparedQuery: null,
      candidates: [
        { candidateKey: "evidence:beta", objectId: "beta", content: "beta" },
        { candidateKey: "evidence:alpha", objectId: "alpha", content: "alpha" }
      ]
    });

    expect([...result.scores]).toEqual([
      ["evidence:beta", 0],
      ["evidence:alpha", 1]
    ]);
  });

  it("fails open on a document batch error and retries it on the next request", async () => {
    let call = 0;
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      call += 1;
      if (call === 2) throw new Error("transient document failure");
      return texts.map((text) => vectorFor(text));
    });
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds: vi.fn(async () => []) },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn(async () => [])
      }
    });
    const request = {
      workspaceId: "workspace-1",
      runId: null,
      queryText: "query",
      preparedQuery: null,
      candidates: [{
        candidateKey: "evidence:1",
        objectId: "object-1",
        documentIdentity: "owner",
        content: "document"
      }]
    } as const;

    const failed = await service.scoreEvidenceCandidates(request);
    const retried = await service.scoreEvidenceCandidates(request);

    expect(failed).toMatchObject({
      status: "failed",
      scoredCount: 0,
      inferenceCalls: 2
    });
    expect(failed.scores.size).toBe(0);
    expect(retried).toMatchObject({ status: "returned", scoredCount: 1 });
    expect(embedTexts).toHaveBeenCalledTimes(3);
  });

  it("counts a synchronous document provider failure after a prepared query", async () => {
    const embedTexts = vi.fn(() => {
      throw new Error("synchronous document failure");
    });
    const service = new EmbeddingRecallService({
      embeddingRepo: { listByObjectIds: vi.fn(async () => []) },
      provider: createProvider({ embedTexts }),
      eventLogRepo: {
        append: vi.fn(),
        queryByEntity: vi.fn(async () => [])
      }
    });

    const result = await service.scoreEvidenceCandidates({
      workspaceId: "workspace-1",
      runId: null,
      queryText: "query",
      preparedQuery: {
        queryId: "prepared-query",
        cacheHit: true,
        getSnapshot: () => ({
          status: "ready",
          embedding: new Float32Array([1, 0])
        })
      },
      candidates: [{
        candidateKey: "evidence:1",
        objectId: "object-1",
        documentIdentity: "owner",
        content: "document"
      }]
    });

    expect(result).toMatchObject({
      status: "failed",
      scoredCount: 0,
      inferenceCalls: 1,
      failureClass: "candidate_embedding_failed"
    });
    expect(result.scores.size).toBe(0);
  });
});

function vectorFor(text: string): Float32Array {
  const first = text.charCodeAt(0) || 1;
  const last = text.charCodeAt(text.length - 1) || 1;
  return new Float32Array([first, last]);
}
