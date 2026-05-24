import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_ONNX_EMBEDDING_DIMENSIONS,
  LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD,
  LOCAL_ONNX_UNAVAILABLE_RETRY_BACKOFF_MS,
  LocalOnnxEmbeddingClient,
  type LocalOnnxFeatureExtractor
} from "../local-onnx-embedding-client.js";

function stubExtractor(
  rowsByCall: readonly (readonly (readonly number[])[])[]
): { extractor: LocalOnnxFeatureExtractor; calls: { texts: readonly string[]; pooling: string; normalize: boolean }[] } {
  let callIndex = 0;
  const calls: { texts: readonly string[]; pooling: string; normalize: boolean }[] = [];
  const extractor: LocalOnnxFeatureExtractor = async (texts, options) => {
    calls.push({ texts, pooling: options.pooling, normalize: options.normalize });
    const rows = rowsByCall[Math.min(callIndex, rowsByCall.length - 1)]!;
    callIndex += 1;
    return {
      dims: [rows.length, rows[0]?.length ?? 0],
      tolist: () => rows
    };
  };
  return { extractor, calls };
}

function dimRow(seed: number): readonly number[] {
  return Array.from({ length: LOCAL_ONNX_EMBEDDING_DIMENSIONS }, (_unused, index) =>
    Math.sin(seed + index)
  );
}

describe("LocalOnnxEmbeddingClient", () => {
  it("declares a distinct local provider identity and is available as soon as it is configured", () => {
    const client = new LocalOnnxEmbeddingClient({
      pipelineLoader: async () => stubExtractor([[dimRow(1)]]).extractor
    });
    expect(client.providerKind).toBe("local_onnx");
    expect(client.providerKind).not.toBe("openai");
    expect(client.schemaVersion).toBe(1);
    // invariant: isAvailable semantics mirror OpenAIEmbeddingClient — the
    // provider is "available" once configured (modelId present), so daemon
    // wiring that gates the recall-policy decorator on this flag at startup
    // does not deadlock waiting for a first probe.
    expect(client.isAvailable).toBe(true);
    expect(client.modelId).toContain("MiniLM");
  });

  it("stays available across a successful embedTexts call", async () => {
    const client = new LocalOnnxEmbeddingClient({
      pipelineLoader: async () => stubExtractor([[dimRow(11)]]).extractor
    });
    expect(client.isAvailable).toBe(true);
    await client.embedTexts(["probe"], { timeoutMs: 5_000 });
    expect(client.isAvailable).toBe(true);
  });

  it("declares the provider unavailable after N consecutive load failures, then re-opens after the backoff window and recovers on a successful retry", async () => {
    let attempt = 0;
    let currentNow = 1_000_000;
    let shouldFail = true;
    const loader = vi.fn(async () => {
      attempt += 1;
      if (shouldFail) {
        throw new Error(`load failure ${attempt}`);
      }
      return stubExtractor([[dimRow(42)]]).extractor;
    });
    const client = new LocalOnnxEmbeddingClient({
      pipelineLoader: loader,
      now: () => currentNow
    });
    // Starts available (configured).
    expect(client.isAvailable).toBe(true);
    for (let i = 0; i < LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD; i++) {
      await expect(client.embedTexts(["x"], { timeoutMs: 5_000 })).rejects.toThrow(/load failure/);
    }
    // Sustained failure flips the dynamic gate false within the backoff window.
    expect(client.isAvailable).toBe(false);
    expect(loader).toHaveBeenCalledTimes(LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD);
    // Within the backoff window the loader is not redialled.
    await expect(client.embedTexts(["x"], { timeoutMs: 5_000 })).rejects.toThrow(/unavailable/);
    expect(loader).toHaveBeenCalledTimes(LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD);
    // Past the backoff window the gate re-opens (loader is allowed to retry).
    currentNow += LOCAL_ONNX_UNAVAILABLE_RETRY_BACKOFF_MS + 1;
    expect(client.isAvailable).toBe(true);
    // A successful retry resets the dynamic health state.
    shouldFail = false;
    const recovered = await client.embedTexts(["x"], { timeoutMs: 5_000 });
    expect(recovered[0]!.length).toBe(LOCAL_ONNX_EMBEDDING_DIMENSIONS);
    expect(loader).toHaveBeenCalledTimes(LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD + 1);
    expect(client.isAvailable).toBe(true);
  });

  it("returns one 384-dimensional vector per input text", async () => {
    const { extractor, calls } = stubExtractor([[dimRow(1), dimRow(2)]]);
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: async () => extractor });
    const vectors = await client.embedTexts(["hello world", "你好世界"], { timeoutMs: 5_000 });
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector.length).toBe(LOCAL_ONNX_EMBEDDING_DIMENSIONS);
    }
    expect(calls[0]).toMatchObject({ pooling: "mean", normalize: true });
  });

  it("produces a deterministic vector for repeated identical input via the loaded model", async () => {
    const row = dimRow(7);
    const { extractor } = stubExtractor([[row], [row]]);
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: async () => extractor });
    const first = await client.embedTexts(["stable input"], { timeoutMs: 5_000 });
    const second = await client.embedTexts(["stable input"], { timeoutMs: 5_000 });
    expect([...first[0]!]).toStrictEqual([...second[0]!]);
  });

  it("loads the pipeline once and reuses it across calls", async () => {
    const loader = vi.fn(async () => stubExtractor([[dimRow(1)]]).extractor);
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: loader });
    await client.embedTexts(["a"], { timeoutMs: 5_000 });
    await client.embedTexts(["b"], { timeoutMs: 5_000 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result without loading the model for empty input", async () => {
    const loader = vi.fn(async () => stubExtractor([[dimRow(1)]]).extractor);
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: loader });
    const vectors = await client.embedTexts([], { timeoutMs: 5_000 });
    expect(vectors).toHaveLength(0);
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects a model that emits an unexpected dimension count", async () => {
    const { extractor } = stubExtractor([[[0.1, 0.2, 0.3]]]);
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: async () => extractor });
    await expect(client.embedTexts(["x"], { timeoutMs: 5_000 })).rejects.toThrow(/dimensions/);
  });

  it("retries the pipeline load after a transient failure rather than caching it", async () => {
    let attempt = 0;
    const loader = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("cold cache");
      }
      return stubExtractor([[dimRow(3)]]).extractor;
    });
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: loader });
    await expect(client.embedTexts(["x"], { timeoutMs: 5_000 })).rejects.toThrow("cold cache");
    const recovered = await client.embedTexts(["x"], { timeoutMs: 5_000 });
    expect(recovered[0]!.length).toBe(LOCAL_ONNX_EMBEDDING_DIMENSIONS);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

// Real-model smoke check. Runs only when the model weights have been
// pre-fetched into the worktree cache; otherwise skipped so CI without the
// large weights stays green.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const modelCacheDir = path.join(repoRoot, "var/models");
const modelPresent = existsSync(
  path.join(modelCacheDir, "Xenova/paraphrase-multilingual-MiniLM-L12-v2/onnx/model_quantized.onnx")
);

describe.runIf(modelPresent)("LocalOnnxEmbeddingClient (real model smoke)", () => {
  it("loads the ONNX model offline and emits normalized 384-dim vectors", async () => {
    const client = new LocalOnnxEmbeddingClient({ cacheDir: modelCacheDir });
    const vectors = await client.embedTexts(["The cat sat on the mat", "你好世界"], {
      timeoutMs: 120_000
    });
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector.length).toBe(LOCAL_ONNX_EMBEDDING_DIMENSIONS);
      let sumSquares = 0;
      for (const value of vector) {
        sumSquares += value * value;
      }
      expect(Math.sqrt(sumSquares)).toBeCloseTo(1, 1);
    }
  }, 180_000);
});
