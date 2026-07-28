import { describe, expect, it, vi } from "vitest";
import {
  EvidenceDocumentEmbeddingEngine
} from "../../embedding-recall/evidence/evidence-document-embedding-engine.js";
import { createProvider } from "./embedding-recall-test-helpers.js";

describe("EvidenceDocumentEmbeddingEngine", () => {
  it("reuses an identity-preserving document batch without another provider call", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);
    const texts = Array.from({ length: 25 }, (_, index) => `document ${index}`);

    const first = await engine.embedDocuments(texts, 5_000);
    const second = await engine.embedDocuments(texts, 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(first.inferenceCalls).toBe(1);
    expect(second.inferenceCalls).toBe(0);
    expect(second.embeddings).toEqual(first.embeddings);
    expect(second.embeddings[0]).not.toBe(first.embeddings[0]);
  });

  it("binds cache identity and provider input to normalized document text", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);

    const first = await engine.embedDocuments(["  same document  "], 5_000);
    const second = await engine.embedDocuments(["same document"], 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(embedTexts).toHaveBeenCalledWith(["same document"], { timeoutMs: 5_000 });
    expect(second.embeddings).toEqual(first.embeddings);
  });

  it("binds cached documents to the active provider model identity", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const provider = createProvider({ embedTexts });
    const engine = new EvidenceDocumentEmbeddingEngine(provider, 50);

    await engine.embedDocuments(["same document"], 5_000);
    Object.assign(provider, { modelId: "replacement-model" });
    await engine.embedDocuments(["same document"], 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(2);
  });

  it("preserves exact input order when a batch contains duplicate documents", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);

    const result = await engine.embedDocuments(["beta", "alpha", "beta"], 5_000);

    expect(embedTexts).toHaveBeenCalledWith(["beta", "alpha"], { timeoutMs: 5_000 });
    expect(result.embeddings).toEqual([
      vectorFor("beta"),
      vectorFor("alpha"),
      vectorFor("beta")
    ]);
  });

  it("single-flights overlapping document misses", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      await blocked;
      return texts.map((text) => vectorFor(text));
    });
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);

    const first = engine.embedDocuments(["shared", "first"], 5_000);
    const second = engine.embedDocuments(["shared"], 5_000);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(firstResult.inferenceCalls).toBe(1);
    expect(secondResult.inferenceCalls).toBe(0);
    expect(secondResult.embeddings[0]).toEqual(firstResult.embeddings[0]);
  });

  it("clears failed single-flight entries so a later request can retry", async () => {
    let shouldFail = true;
    const embedTexts = vi.fn(async (texts: readonly string[]) => {
      if (shouldFail) throw new Error("transient failure");
      return texts.map((text) => vectorFor(text));
    });
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);

    await expect(engine.embedDocuments(["retry"], 5_000)).rejects.toThrow("transient failure");
    shouldFail = false;
    const retried = await engine.embedDocuments(["retry"], 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(2);
    expect(retried.inferenceCalls).toBe(1);
    expect(retried.embeddings).toEqual([vectorFor("retry")]);
  });

  it("evicts the least-recently-used document at the configured bound", async () => {
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 2);

    await engine.embedDocuments(["a", "b"], 5_000);
    await engine.embedDocuments(["a"], 5_000);
    await engine.embedDocuments(["c"], 5_000);
    const evicted = await engine.embedDocuments(["b"], 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(3);
    expect(evicted.inferenceCalls).toBe(1);
  });
});

function vectorFor(text: string): Float32Array {
  return new Float32Array([text.length, text.charCodeAt(0) ?? 0]);
}
