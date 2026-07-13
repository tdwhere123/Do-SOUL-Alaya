import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_ONNX_EMBEDDING_DIMENSIONS,
  LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD,
  LOCAL_ONNX_UNAVAILABLE_RETRY_BACKOFF_MS,
  LocalOnnxEmbeddingClient,
  defaultLocalOnnxCacheDir,
  resolveLocalOnnxSessionOptionsFromEnv,
  type LocalOnnxFeatureExtractor
} from "../../embedding-recall/local-onnx-embedding-client.js";
import { withLocalOnnxHostSingleFlight } from "../../embedding-recall/local-onnx-host-single-flight.js";

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

  it("threads bounded ONNX session options from the environment into the pipeline loader", async () => {
    const originalThreads = process.env.ALAYA_LOCAL_ONNX_THREADS;
    process.env.ALAYA_LOCAL_ONNX_THREADS = "2";
    const loader = vi.fn(async () => stubExtractor([[dimRow(1)]]).extractor);
    try {
      const client = new LocalOnnxEmbeddingClient({ pipelineLoader: loader });
      await client.embedTexts(["a"], { timeoutMs: 5_000 });
    } finally {
      if (originalThreads === undefined) {
        delete process.env.ALAYA_LOCAL_ONNX_THREADS;
      } else {
        process.env.ALAYA_LOCAL_ONNX_THREADS = originalThreads;
      }
    }

    expect(loader).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      {
        sessionOptions: {
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
          executionMode: "sequential"
        }
      }
    );
  });

  it("ignores missing or invalid ONNX thread limits", () => {
    expect(resolveLocalOnnxSessionOptionsFromEnv({})).toBeUndefined();
    expect(resolveLocalOnnxSessionOptionsFromEnv({ ALAYA_LOCAL_ONNX_THREADS: "0" })).toBeUndefined();
    expect(resolveLocalOnnxSessionOptionsFromEnv({ ALAYA_LOCAL_ONNX_THREADS: "abc" })).toBeUndefined();
  });

  it("defaults the model cache outside the repository under XDG cache", async () => {
    const originalXdg = process.env.XDG_CACHE_HOME;
    const originalHome = process.env.HOME;
    process.env.XDG_CACHE_HOME = "/tmp/alaya-xdg-cache";
    process.env.HOME = "/tmp/ignored-home";
    try {
      let observedCacheDir: string | null = null;
      const client = new LocalOnnxEmbeddingClient({
        pipelineLoader: async (_modelId, cacheDir) => {
          observedCacheDir = cacheDir;
          return stubExtractor([[dimRow(1)]]).extractor;
        }
      });

      await client.embedTexts(["cache probe"], { timeoutMs: 5_000 });

      const expectedCacheDir = path.join("/tmp/alaya-xdg-cache", "do-soul-alaya", "models");
      expect(defaultLocalOnnxCacheDir()).toBe(expectedCacheDir);
      expect(observedCacheDir).toBe(expectedCacheDir);
    } finally {
      if (originalXdg === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = originalXdg;
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
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

  it("times out a hung extractor run and discards the late result without an unhandledRejection", async () => {
    let resolveLate: (rows: { dims: readonly number[]; tolist: () => readonly (readonly number[])[] }) => void =
      () => {};
    const extractor: LocalOnnxFeatureExtractor = () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      });
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: async () => extractor });

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await expect(client.embedTexts(["x"], { timeoutMs: 10 })).rejects.toThrow(/timed out/);
      // The uncancellable run resolves after the timeout; the stale result is discarded.
      resolveLate({ dims: [1, LOCAL_ONNX_EMBEDDING_DIMENSIONS], tolist: () => [dimRow(9)] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("retains the host inference lock until a timed-out extractor actually settles", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "alaya-embedding-timeout-"));
    const previousEnabled = process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT;
    const previousLockPath = process.env.ALAYA_LOCAL_ONNX_LOCK_PATH;
    process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT = "1";
    process.env.ALAYA_LOCAL_ONNX_LOCK_PATH = path.join(root, "inference.lock");
    const releases: Array<(value: Awaited<ReturnType<LocalOnnxFeatureExtractor>>) => void> = [];
    const extractor = vi.fn<LocalOnnxFeatureExtractor>(() =>
      new Promise((resolve) => releases.push(resolve))
    );
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: async () => extractor });
    const output = { dims: [1, LOCAL_ONNX_EMBEDDING_DIMENSIONS], tolist: () => [dimRow(9)] };
    let second: Promise<readonly Float32Array[]> | null = null;

    try {
      await expect(client.embedTexts(["first"], { timeoutMs: 10 })).rejects.toThrow(/timed out/);
      second = client.embedTexts(["second"], { timeoutMs: 1_000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(extractor).toHaveBeenCalledTimes(1);

      releases.shift()?.(output);
      await vi.waitFor(() => expect(extractor).toHaveBeenCalledTimes(2));
      releases.shift()?.(output);
      await expect(second).resolves.toHaveLength(1);
    } finally {
      for (const release of releases.splice(0)) release(output);
      if (second !== null) {
        await vi.waitFor(() => expect(extractor.mock.calls.length).toBeGreaterThanOrEqual(2))
          .catch(() => undefined);
        for (const release of releases.splice(0)) release(output);
        await second.catch(() => undefined);
      }
      restoreEnv("ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT", previousEnabled);
      restoreEnv("ALAYA_LOCAL_ONNX_LOCK_PATH", previousLockPath);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the entry deadline while waiting for the host lock and never starts orphan work", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "alaya-embedding-wait-"));
    const lockPath = path.join(root, "inference.lock");
    let releaseHolder: () => void = () => undefined;
    let markAcquired: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => { markAcquired = resolve; });
    const holder = withLocalOnnxHostSingleFlight(async () => {
      markAcquired();
      await new Promise<void>((resolve) => { releaseHolder = resolve; });
    }, { enabled: true, lockPath });
    await acquired;
    const extractor = vi.fn(stubExtractor([[dimRow(1)]]).extractor);
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: async () => extractor });
    const previousEnabled = process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT;
    const previousLockPath = process.env.ALAYA_LOCAL_ONNX_LOCK_PATH;
    process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT = "1";
    process.env.ALAYA_LOCAL_ONNX_LOCK_PATH = lockPath;
    const releaseTimer = setTimeout(releaseHolder, 60);
    try {
      await expect(client.embedTexts(["waiting"], { timeoutMs: 15 })).rejects.toThrow(/timed out/);
      await holder;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(extractor).not.toHaveBeenCalled();
    } finally {
      clearTimeout(releaseTimer);
      releaseHolder();
      await holder;
      restoreEnv("ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT", previousEnabled);
      restoreEnv("ALAYA_LOCAL_ONNX_LOCK_PATH", previousLockPath);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the entry deadline for model load and skips inference after cancellation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "alaya-embedding-load-"));
    const priorEnabled = process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT;
    const priorPath = process.env.ALAYA_LOCAL_ONNX_LOCK_PATH;
    process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT = "1";
    process.env.ALAYA_LOCAL_ONNX_LOCK_PATH = path.join(root, "inference.lock");
    let finishLoad: (extractor: LocalOnnxFeatureExtractor) => void = () => undefined;
    const extractor = vi.fn(stubExtractor([[dimRow(2)]]).extractor);
    const client = new LocalOnnxEmbeddingClient({
      pipelineLoader: () => new Promise((resolve) => { finishLoad = resolve; })
    });
    const secondLoader = vi.fn(async () => stubExtractor([[dimRow(3)]]).extractor);
    const second = new LocalOnnxEmbeddingClient({ pipelineLoader: secondLoader });
    let waiting: Promise<readonly Float32Array[]> | null = null;
    try {
      await expect(client.embedTexts(["loading"], { timeoutMs: 15 })).rejects.toThrow(/timed out/);
      waiting = second.embedTexts(["next"], { timeoutMs: 1_000 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondLoader).not.toHaveBeenCalled();
      finishLoad(extractor);
      await expect(waiting).resolves.toHaveLength(1);
      expect(extractor).not.toHaveBeenCalled();
    } finally {
      finishLoad(extractor);
      await waiting?.catch(() => undefined);
      restoreEnv("ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT", priorEnabled);
      restoreEnv("ALAYA_LOCAL_ONNX_LOCK_PATH", priorPath);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts via an external signal and suppresses the abandoned run's late rejection", async () => {
    let rejectLate: (reason: unknown) => void = () => {};
    const extractor: LocalOnnxFeatureExtractor = () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    const client = new LocalOnnxEmbeddingClient({ pipelineLoader: async () => extractor });

    const controller = new AbortController();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const pending = client.embedTexts(["x"], { timeoutMs: 5_000, signal: controller.signal });
      controller.abort(new Error("caller cancelled"));
      await expect(pending).rejects.toThrow(/caller cancelled/);
      // The abandoned extractor rejects afterwards; it must not surface.
      rejectLate(new Error("late extractor failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

// Real-model smoke check. Runs only when the model weights have been
// pre-fetched into the worktree cache; otherwise skipped so CI without the
// large weights stays green.
const modelCacheDir = defaultLocalOnnxCacheDir();
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
