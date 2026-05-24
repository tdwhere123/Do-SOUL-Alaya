import type { EmbeddingProviderPort } from "./embedding-recall-service.js";

/**
 * Feature-extraction pipeline contract satisfied by the
 * `@huggingface/transformers` `pipeline("feature-extraction", ...)` return
 * value. Declared structurally so the heavy runtime dependency stays a
 * dynamic import and unit tests can inject a stub.
 */
export interface LocalOnnxFeatureExtractor {
  (
    texts: readonly string[],
    options: { readonly pooling: "mean"; readonly normalize: boolean }
  ): Promise<{
    readonly dims: readonly number[];
    tolist(): readonly (readonly number[])[];
  }>;
}

export type LocalOnnxPipelineLoader = (
  modelId: string,
  cacheDir: string | null
) => Promise<LocalOnnxFeatureExtractor>;

export interface LocalOnnxEmbeddingClientOptions {
  /**
   * Xenova ONNX model repo id. Defaults to the multilingual MiniLM that
   * produces 384-dimensional sentence embeddings on CPU.
   */
  readonly modelId?: string;
  /**
   * Local Transformers.js cache directory. When set, the model is loaded
   * from disk; remote model fetching is disabled at run time so the recall
   * path never reaches the network.
   */
  readonly cacheDir?: string | null;
  /**
   * Test seam: replaces the dynamic `@huggingface/transformers` import. The
   * default loader pins `allowRemoteModels = false` so production runs are
   * offline once the model weights are pre-fetched.
   */
  readonly pipelineLoader?: LocalOnnxPipelineLoader;
  /**
   * Override for the dynamic clock (test seam). Real wall-clock by default.
   */
  readonly now?: () => number;
}

const DEFAULT_LOCAL_ONNX_MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const LOCAL_ONNX_EMBEDDING_DIMENSIONS = 384;
// Consecutive load failures before the provider declares itself unavailable.
// A small window so a single transient cold-cache fault does not flip the
// dynamic gate; a sustained failure run takes the provider offline.
export const LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD = 3;
// Backoff between load-retry attempts once the provider is unavailable. The
// recall path consults isAvailable cheaply; we do not want a tight retry loop
// to hammer transformers.pipeline() at every call.
export const LOCAL_ONNX_UNAVAILABLE_RETRY_BACKOFF_MS = 30_000;

/**
 * On-device embedding provider backed by a quantized ONNX sentence model run
 * through Transformers.js. Implements {@link EmbeddingProviderPort} so it is a
 * drop-in alternative to {@link OpenAIEmbeddingClient}: the recall supplement
 * never decides durable truth, and a distinct `providerKind` keeps its vectors
 * from being cosine-compared against API-provider vectors.
 *
 * `isAvailable` semantics intentionally mirror {@link OpenAIEmbeddingClient}:
 * the gate starts `true` as soon as the provider is constructed with a
 * non-empty model id — "provider is configured" rather than "provider has
 * succeeded once". Without this parity, daemon wiring that gates the recall
 * policy decorator on `provider.isAvailable` at startup deadlocks: nothing on
 * the boot path embeds before the first recall, so a startup-time false flag
 * would permanently disable the embedding fusion-weight override and the
 * coarse-injection workspace scan that itself drives the first probe.
 *
 * The dynamic health state still degrades on sustained failure: after
 * {@link LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD} consecutive load failures
 * the gate flips to `false` and the loader is not redialled for
 * {@link LOCAL_ONNX_UNAVAILABLE_RETRY_BACKOFF_MS} ms; once the backoff window
 * elapses a retry can take it back to `true`. The recall-policy decorator and
 * other callers read `isAvailable` lazily, so a mid-run degradation stops
 * further injection without restarting the daemon.
 */
export class LocalOnnxEmbeddingClient implements EmbeddingProviderPort {
  public readonly providerKind = "local_onnx";
  public readonly modelId: string;
  public readonly schemaVersion = 1;

  private readonly cacheDir: string | null;
  private readonly pipelineLoader: LocalOnnxPipelineLoader;
  private readonly now: () => number;
  private extractorPromise: Promise<LocalOnnxFeatureExtractor> | null = null;
  // Starts `true` (configured) and only flips `false` after sustained load
  // failures, so the daemon's startup-time embedding-policy decorator is not
  // permanently disabled before any embed call has had a chance to run.
  private currentlyAvailable = true;
  private consecutiveLoadFailures = 0;
  private nextLoadAttemptAt = 0;

  public constructor(options: LocalOnnxEmbeddingClientOptions = {}) {
    this.modelId = options.modelId?.trim() || DEFAULT_LOCAL_ONNX_MODEL_ID;
    this.cacheDir = options.cacheDir ?? null;
    this.pipelineLoader = options.pipelineLoader ?? defaultLocalOnnxPipelineLoader;
    this.now = options.now ?? (() => Date.now());
  }

  public get isAvailable(): boolean {
    // Outside the backoff window after sustained failure, treat the provider
    // as configured again so a recall path can dial it; the loader will flip
    // currentlyAvailable back to false again if the failure persists.
    if (!this.currentlyAvailable && this.now() >= this.nextLoadAttemptAt) {
      return true;
    }
    return this.currentlyAvailable;
  }

  public async embedTexts(
    texts: readonly string[],
    options: {
      readonly timeoutMs: number;
    }
  ): Promise<readonly Float32Array[]> {
    if (texts.length === 0) {
      return Object.freeze([]);
    }

    const extractor = await this.loadExtractor();
    const run = extractor([...texts], { pooling: "mean", normalize: true });
    const output = await withTimeout(run, options.timeoutMs);
    const rows = output.tolist();
    if (rows.length !== texts.length) {
      throw new Error(
        `Local ONNX embedding returned ${rows.length} vectors for ${texts.length} inputs.`
      );
    }

    const vectors = rows.map((row, index) => {
      if (!Array.isArray(row) || row.length === 0) {
        throw new Error(`Local ONNX embedding row ${index} was empty.`);
      }
      if (row.length !== LOCAL_ONNX_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Local ONNX embedding row ${index} had ${row.length} dimensions; ` +
            `expected ${LOCAL_ONNX_EMBEDDING_DIMENSIONS}.`
        );
      }
      return new Float32Array(row);
    });
    // A successful pipeline run resets the dynamic health state — even if
    // the provider was in the backoff window after a prior failure run.
    this.currentlyAvailable = true;
    this.consecutiveLoadFailures = 0;
    return Object.freeze(vectors);
  }

  private loadExtractor(): Promise<LocalOnnxFeatureExtractor> {
    if (this.extractorPromise !== null) {
      return this.extractorPromise;
    }
    if (
      !this.currentlyAvailable &&
      this.consecutiveLoadFailures >= LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD &&
      this.now() < this.nextLoadAttemptAt
    ) {
      // Refuse to dial the pipeline loader until the backoff window has
      // elapsed; the recall path treats this as a transient unavailability.
      return Promise.reject(
        new Error(
          `Local ONNX embedding provider is unavailable after ${this.consecutiveLoadFailures} ` +
            `consecutive load failures; retry after ${this.nextLoadAttemptAt - this.now()} ms.`
        )
      );
    }
    this.extractorPromise = this.pipelineLoader(this.modelId, this.cacheDir).catch((error) => {
      // Reset so a later call can retry instead of permanently caching a
      // transient load failure (e.g. a cold cache directory).
      this.extractorPromise = null;
      this.consecutiveLoadFailures += 1;
      if (this.consecutiveLoadFailures >= LOCAL_ONNX_UNAVAILABLE_FAILURE_THRESHOLD) {
        this.currentlyAvailable = false;
        this.nextLoadAttemptAt = this.now() + LOCAL_ONNX_UNAVAILABLE_RETRY_BACKOFF_MS;
      }
      throw error;
    });
    return this.extractorPromise;
  }
}

async function defaultLocalOnnxPipelineLoader(
  modelId: string,
  cacheDir: string | null
): Promise<LocalOnnxFeatureExtractor> {
  const transformers = (await import("@huggingface/transformers")) as {
    readonly env: {
      allowRemoteModels: boolean;
      cacheDir?: string;
      localModelPath?: string;
    };
    readonly pipeline: (
      task: "feature-extraction",
      model: string,
      options: { readonly dtype: string }
    ) => Promise<LocalOnnxFeatureExtractor>;
  };
  // invariant: embedding is a recall supplement; the on-device provider must
  // not reach the network during recall. Weights are pre-fetched out of band.
  transformers.env.allowRemoteModels = false;
  if (cacheDir !== null) {
    transformers.env.cacheDir = cacheDir;
    transformers.env.localModelPath = cacheDir;
  }
  return transformers.pipeline("feature-extraction", modelId, { dtype: "q8" });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Local ONNX embedding timed out after ${timeoutMs} ms.`)),
          timeoutMs
        );
        timeoutHandle.unref?.();
      })
    ]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}
