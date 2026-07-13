import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LocalOnnxCrossEncoderClient,
  LocalOnnxCrossEncoderError,
  type LocalOnnxCrossEncoderClientOptions,
  type LocalOnnxCrossEncoderTransformersModule
} from "../../embedding-recall/local-onnx-cross-encoder-client.js";
import {
  LocalOnnxEmbeddingClient,
  defaultLocalOnnxCacheDir,
  type LocalOnnxEmbeddingTransformersModule
} from "../../embedding-recall/local-onnx-embedding-client.js";

type LocalOnnxCrossEncoderLoader = NonNullable<LocalOnnxCrossEncoderClientOptions["loader"]>;
type LocalOnnxCrossEncoderRuntime = Awaited<ReturnType<LocalOnnxCrossEncoderLoader>>;

function loaderFor(
  infer: LocalOnnxCrossEncoderRuntime["infer"]
): Readonly<{
  readonly loader: LocalOnnxCrossEncoderLoader;
  readonly infer: ReturnType<typeof vi.fn<LocalOnnxCrossEncoderRuntime["infer"]>>;
}> {
  const scorer = vi.fn(infer);
  return {
    loader: vi.fn(async () => ({ infer: scorer })),
    infer: scorer
  };
}

function transformersFixture() {
  const env: LocalOnnxCrossEncoderTransformersModule["env"] = { allowRemoteModels: true };
  const tokenizer = vi.fn(() => ({ encoded: true }));
  const tolist = vi.fn(() => [[-2], [0], [2]]);
  const model = vi.fn(async () => ({ logits: { tolist } }));
  const tokenizerLoader = vi.fn(async () => tokenizer);
  const modelLoader = vi.fn(async () => model);
  const transformers: LocalOnnxCrossEncoderTransformersModule = {
    env,
    AutoTokenizer: { from_pretrained: tokenizerLoader },
    BertForSequenceClassification: { from_pretrained: modelLoader }
  };
  return { env, model, modelLoader, tokenizer, tokenizerLoader, tolist, transformers };
}

describe("LocalOnnxCrossEncoderClient", () => {
  it("warms once and reuses the loaded model", async () => {
    const { loader, infer } = loaderFor(async (pairs) => pairs.map(() => 0.25));
    const client = new LocalOnnxCrossEncoderClient({ loader });

    await client.warm();
    await client.warm();
    await client.score("q", ["p"]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(infer).toHaveBeenCalledTimes(1);
  });

  it("scores bounded batches sequentially without changing input order", async () => {
    const seen: string[][] = [];
    const { loader } = loaderFor(async (pairs) => {
      seen.push(pairs.map(({ passage }) => passage));
      return pairs.map(({ passage }) => Number(passage));
    });
    const client = new LocalOnnxCrossEncoderClient({ loader, maxBatchSize: 2 });

    const logits = [-2, 0, 2, 4, 6];
    const scores = await client.score("q", logits.map(String));

    expect(seen).toEqual([["-2", "0"], ["2", "4"], ["6"]]);
    expect(scores).toHaveLength(5);
    scores.forEach((score, index) => {
      expect(score).toBeCloseTo(1 / (1 + Math.exp(-logits[index]!)), 12);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  it("serializes concurrent score calls on one client", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const { loader, infer } = loaderFor(async (pairs) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return pairs.map(() => 0);
    });
    const client = new LocalOnnxCrossEncoderClient({ loader });

    const first = client.score("q1", ["p1"]);
    const second = client.score("q2", ["p2"]);
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await first;
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await second;

    expect(maxActive).toBe(1);
  });

  it("bounds the waiting queue and times out queued callers", async () => {
    let releaseActive: () => void = () => undefined;
    const { loader } = loaderFor(async (pairs) => {
      await new Promise<void>((resolve) => {
        releaseActive = resolve;
      });
      return pairs.map(() => 0);
    });
    const client = new LocalOnnxCrossEncoderClient({
      loader,
      maxQueueSize: 1,
      queueWaitTimeoutMs: 20,
      inferenceTimeoutMs: 1_000
    });

    const active = client.score("q1", ["p1"]);
    const waiting = client.score("q2", ["p2"]);
    await expect(client.score("q3", ["p3"])).rejects.toMatchObject({
      code: "QUEUE_FULL"
    });
    await expect(waiting).rejects.toMatchObject({ code: "QUEUE_TIMEOUT" });
    releaseActive();
    await active;
  });

  it("poisons the client after inference timeout and fails queued and future jobs", async () => {
    let rejectLate: (reason: unknown) => void = () => undefined;
    const { loader, infer } = loaderFor(
      () => new Promise<readonly number[]>((_resolve, reject) => {
        rejectLate = reject;
      })
    );
    const client = new LocalOnnxCrossEncoderClient({
      loader,
      inferenceTimeoutMs: 20,
      queueWaitTimeoutMs: 200
    });

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const active = client.score("q1", ["p1"]);
      const queued = client.score("q2", ["p2"]);
      const activeFailure = expect(active).rejects.toMatchObject({ code: "INFERENCE_TIMEOUT" });
      const queuedFailure = expect(queued).rejects.toMatchObject({ code: "INFERENCE_TIMEOUT" });

      await activeFailure;
      await queuedFailure;
      await expect(client.score("q3", ["p3"])).rejects.toMatchObject({
        code: "INFERENCE_TIMEOUT"
      });
      expect(infer).toHaveBeenCalledTimes(1);

      rejectLate(new Error("late inference failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("retains the shared host lease after timeout until cross inference settles", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "alaya-cross-timeout-"));
    const priorEnabled = process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT;
    const priorPath = process.env.ALAYA_LOCAL_ONNX_LOCK_PATH;
    process.env.ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT = "1";
    process.env.ALAYA_LOCAL_ONNX_LOCK_PATH = path.join(root, "inference.lock");
    let finishFirst: (scores: readonly number[]) => void = () => undefined;
    const first = new LocalOnnxCrossEncoderClient({
      loader: async () => ({ infer: () => new Promise((resolve) => { finishFirst = resolve; }) }),
      inferenceTimeoutMs: 15
    });
    const secondInfer = vi.fn(async () => [0]);
    const second = new LocalOnnxCrossEncoderClient({
      loader: async () => ({ infer: secondInfer }),
      inferenceTimeoutMs: 1_000
    });
    try {
      await expect(first.score("q1", ["p1"])).rejects.toMatchObject({ code: "INFERENCE_TIMEOUT" });
      const waiting = second.score("q2", ["p2"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondInfer).not.toHaveBeenCalled();
      finishFirst([0]);
      await expect(waiting).resolves.toEqual([0.5]);
    } finally {
      finishFirst([0]);
      restoreEnv("ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT", priorEnabled);
      restoreEnv("ALAYA_LOCAL_ONNX_LOCK_PATH", priorPath);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the bounded shared ONNX session threads to the cross loader", async () => {
    const prior = process.env.ALAYA_LOCAL_ONNX_THREADS;
    process.env.ALAYA_LOCAL_ONNX_THREADS = "3";
    const loader = vi.fn<LocalOnnxCrossEncoderLoader>(async () => ({ infer: async () => [0] }));
    try {
      await new LocalOnnxCrossEncoderClient({ loader }).score("q", ["p"]);
    } finally {
      restoreEnv("ALAYA_LOCAL_ONNX_THREADS", prior);
    }
    expect(loader).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      maxInputTokens: 512,
      sessionOptions: {
        intraOpNumThreads: 3,
        interOpNumThreads: 1,
        executionMode: "sequential"
      }
    });
  });

  it("bounds model loading with a typed timeout", async () => {
    const client = new LocalOnnxCrossEncoderClient({
      loader: () => new Promise(() => undefined),
      modelLoadTimeoutMs: 20
    });

    await expect(client.warm()).rejects.toMatchObject({ code: "MODEL_LOAD_TIMEOUT" });
  });

  it("continues queued work after an inference failure", async () => {
    let invocation = 0;
    const { loader } = loaderFor(async (pairs) => {
      invocation += 1;
      if (invocation === 1) {
        throw new Error("transient inference failure");
      }
      return pairs.map(() => 0);
    });
    const client = new LocalOnnxCrossEncoderClient({ loader });

    const first = client.score("q1", ["p1"]);
    const second = client.score("q2", ["p2"]);

    await expect(first).rejects.toThrow("transient inference failure");
    await expect(second).resolves.toEqual([0.5]);
  });

  it("forwards the configured local model, cache, and token bound", async () => {
    const loader = vi.fn<LocalOnnxCrossEncoderLoader>(async () => ({
      infer: async () => [0.5]
    }));
    const client = new LocalOnnxCrossEncoderClient({
      modelId: "local/test-cross-encoder",
      cacheDir: "/tmp/alaya-cross-encoder-cache",
      maxInputTokens: 128,
      loader
    });

    await client.score("query", ["passage"]);

    expect(loader).toHaveBeenCalledWith(
      "local/test-cross-encoder",
      "/tmp/alaya-cross-encoder-cache",
      { maxInputTokens: 128 }
    );
  });

  it("uses the offline q8 transformers adapter and preserves logit order", async () => {
    const priorThreads = process.env.ALAYA_LOCAL_ONNX_THREADS;
    process.env.ALAYA_LOCAL_ONNX_THREADS = "2";
    const fixture = transformersFixture();
    const client = new LocalOnnxCrossEncoderClient({
      modelId: "local/test-model",
      cacheDir: "/tmp/local-cross-encoder",
      maxInputTokens: 128,
      transformersImporter: async () => fixture.transformers
    });

    let scores: readonly number[];
    try {
      scores = await client.score("query", ["p1", "p2", "p3"]);
    } finally {
      restoreEnv("ALAYA_LOCAL_ONNX_THREADS", priorThreads);
    }

    expect(fixture.env).toEqual({ allowRemoteModels: false });
    const localFiles = {
      cache_dir: "/tmp/local-cross-encoder",
      local_files_only: true
    };
    expect(fixture.tokenizerLoader).toHaveBeenCalledWith("local/test-model", localFiles);
    expect(fixture.modelLoader).toHaveBeenCalledWith("local/test-model", {
      ...localFiles,
      dtype: "q8",
      session_options: {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        executionMode: "sequential"
      }
    });
    expect(fixture.tokenizer).toHaveBeenCalledWith(["query", "query", "query"], {
      text_pair: ["p1", "p2", "p3"],
      padding: true,
      truncation: true,
      max_length: 128
    });
    expect(fixture.model).toHaveBeenCalledWith({ encoded: true });
    expect(fixture.tolist).toHaveBeenCalledOnce();
    expect(scores).toEqual([
      1 / (1 + Math.exp(2)),
      0.5,
      1 / (1 + Math.exp(-2))
    ]);
  });

  it("keeps concurrent bi-encoder and cross-encoder loads bound to distinct cache roots", async () => {
    const env = { allowRemoteModels: true };
    const biPipeline = vi.fn(async () => async () => ({
      dims: [1, 384],
      tolist: () => [Array.from({ length: 384 }, () => 0)]
    }));
    const biTransformers: LocalOnnxEmbeddingTransformersModule = {
      env,
      pipeline: biPipeline
    };
    const crossFixture = transformersFixture();
    const crossTransformers = { ...crossFixture.transformers, env };
    const bi = new LocalOnnxEmbeddingClient({
      cacheDir: "/tmp/bi-cache",
      transformersImporter: async () => biTransformers
    });
    const cross = new LocalOnnxCrossEncoderClient({
      cacheDir: "/tmp/cross-cache",
      transformersImporter: async () => crossTransformers
    });

    await Promise.all([
      bi.embedTexts(["query"], { timeoutMs: 5_000 }),
      cross.warm()
    ]);

    expect(env).toEqual({ allowRemoteModels: false });
    expect(biPipeline).toHaveBeenCalledWith(
      "feature-extraction",
      expect.any(String),
      expect.objectContaining({
        cache_dir: "/tmp/bi-cache",
        local_files_only: true
      })
    );
    expect(crossFixture.tokenizerLoader).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache_dir: "/tmp/cross-cache" })
    );
  });

  it("does not load the model for an empty batch", async () => {
    const { loader } = loaderFor(async () => []);
    const client = new LocalOnnxCrossEncoderClient({ loader });

    await expect(client.score("query", [])).resolves.toEqual([]);
    expect(loader).not.toHaveBeenCalled();
  });

  it("rejects an output count mismatch with an actionable typed error", async () => {
    const { loader } = loaderFor(async () => [0.5]);
    const client = new LocalOnnxCrossEncoderClient({ loader });

    const pending = client.score("query", ["p1", "p2"]);

    await expect(pending).rejects.toMatchObject({
      name: "LocalOnnxCrossEncoderError",
      code: "INVALID_OUTPUT"
    });
    await expect(pending).rejects.toThrow(/1 scores for 2 inputs/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-finite model score: %s",
    async (invalidScore) => {
      const { loader } = loaderFor(async () => [invalidScore]);
      const client = new LocalOnnxCrossEncoderClient({ loader });

      await expect(client.score("q", ["p"])).rejects.toMatchObject({
        code: "INVALID_OUTPUT"
      });
    }
  );

  it("classifies a missing optional dependency separately from a missing model", async () => {
    const missingDependency = Object.assign(new Error("module missing"), {
      code: "ERR_MODULE_NOT_FOUND"
    });
    const dependencyClient = new LocalOnnxCrossEncoderClient({
      loader: async () => Promise.reject(missingDependency)
    });
    const modelClient = new LocalOnnxCrossEncoderClient({
      modelId: "local/missing-model",
      cacheDir: "/tmp/empty-cache",
      loader: async () => Promise.reject(new Error("file not found"))
    });

    await expect(dependencyClient.warm()).rejects.toMatchObject({
      code: "DEPENDENCY_MISSING"
    });
    await expect(modelClient.warm()).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      modelId: "local/missing-model"
    });
    await expect(modelClient.warm()).rejects.toThrow(/remote loading is disabled/);
  });

  it("preserves typed loader errors", async () => {
    const cause = new LocalOnnxCrossEncoderError(
      "MODEL_UNAVAILABLE",
      "known failure",
      "local/model"
    );
    const client = new LocalOnnxCrossEncoderClient({
      loader: async () => Promise.reject(cause)
    });

    await expect(client.warm()).rejects.toBe(cause);
  });

  it("rejects invalid limits and blank inputs before model inference", async () => {
    const { loader, infer } = loaderFor(async () => [0.1]);

    expect(() => new LocalOnnxCrossEncoderClient({ loader, maxBatchSize: 0 })).toThrow(
      /maxBatchSize/
    );
    expect(() => new LocalOnnxCrossEncoderClient({ loader, maxInputTokens: 513 })).toThrow(
      /maxInputTokens/
    );
    expect(() => new LocalOnnxCrossEncoderClient({ loader, maxQueueSize: 0 })).toThrow(
      /maxQueueSize/
    );
    expect(() => new LocalOnnxCrossEncoderClient({ loader, inferenceTimeoutMs: 0 })).toThrow(
      /inferenceTimeoutMs/
    );
    expect(() => new LocalOnnxCrossEncoderClient({ loader, queueWaitTimeoutMs: 0 })).toThrow(
      /queueWaitTimeoutMs/
    );
    expect(() => new LocalOnnxCrossEncoderClient({ loader, modelLoadTimeoutMs: 0 })).toThrow(
      /modelLoadTimeoutMs/
    );

    const client = new LocalOnnxCrossEncoderClient({ loader });
    await expect(client.score(" ", ["p"])).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
    await expect(client.score("q", [" "])).rejects.toMatchObject({
      code: "INVALID_INPUT"
    });
    expect(infer).not.toHaveBeenCalled();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const crossEncoderCacheDir = defaultLocalOnnxCacheDir();
const crossEncoderPresent = existsSync(
  path.join(
    crossEncoderCacheDir,
    "Xenova/ms-marco-MiniLM-L-6-v2/onnx/model_quantized.onnx"
  )
);

describe.runIf(crossEncoderPresent)("LocalOnnxCrossEncoderClient (real model smoke)", () => {
  it("loads the local artifact offline and ranks the relevant passage higher", async () => {
    const client = new LocalOnnxCrossEncoderClient({
      cacheDir: crossEncoderCacheDir,
      modelLoadTimeoutMs: 120_000,
      inferenceTimeoutMs: 120_000
    });
    const scores = await client.score("Where is the Eiffel Tower?", [
      "The Eiffel Tower is in Paris.",
      "Bananas are yellow."
    ]);

    expect(scores).toHaveLength(2);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
  }, 180_000);
});
