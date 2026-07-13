import type { EmbeddingProviderPort } from "./embedding-recall-service.js";
import { withLocalOnnxHostSingleFlight } from "./local-onnx-host-single-flight.js";
import os from "node:os";
import path from "node:path";

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
  cacheDir: string | null,
  options: LocalOnnxPipelineOptions
) => Promise<LocalOnnxFeatureExtractor>;

export interface LocalOnnxSessionOptions {
  readonly intraOpNumThreads?: number;
  readonly interOpNumThreads?: number;
  readonly executionMode?: "sequential" | "parallel";
}

export interface LocalOnnxPipelineOptions {
  readonly sessionOptions?: LocalOnnxSessionOptions;
}

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
   * Test seam: replaces the lazy `@huggingface/transformers` import. The
   * default loader pins `allowRemoteModels = false` so production runs are
   * offline once the model weights are pre-fetched.
   */
  readonly pipelineLoader?: LocalOnnxPipelineLoader;
  /** Test seam for the default offline adapter. */
  readonly transformersImporter?: LocalOnnxEmbeddingTransformersImporter;
  /**
   * Override for the dynamic clock (test seam). Real wall-clock by default.
   */
  readonly now?: () => number;
  // Cosine-space schema version (default 1); daemon sets D2Q_SCHEMA_VERSION when doc2query is on.
  readonly schemaVersion?: number;
}

export const DEFAULT_LOCAL_ONNX_MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
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
  public readonly schemaVersion: number;

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
    this.schemaVersion = options.schemaVersion ?? 1;
    this.cacheDir = options.cacheDir === undefined
      ? defaultLocalOnnxCacheDir()
      : options.cacheDir;
    const importer = options.transformersImporter ?? importTransformers;
    this.pipelineLoader = options.pipelineLoader ?? ((modelId, cacheDir, loaderOptions) =>
      defaultLocalOnnxPipelineLoader(modelId, cacheDir, loaderOptions, importer));
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
      readonly signal?: AbortSignal;
    }
  ): Promise<readonly Float32Array[]> {
    if (texts.length === 0) {
      return Object.freeze([]);
    }
    const deadline = createEmbeddingDeadline(options.timeoutMs, options.signal);
    const occupancy = withLocalOnnxHostSingleFlight(
      () => this.embedUnderLease(texts, deadline.signal),
      {
        signal: deadline.signal,
        timeoutMs: options.timeoutMs > 0 ? options.timeoutMs : undefined
      }
    );
    try {
      return await waitForEmbeddingCaller(occupancy, deadline.signal);
    } finally {
      deadline.close();
    }
  }

  private async embedUnderLease(
    texts: readonly string[],
    signal: AbortSignal
  ): Promise<readonly Float32Array[]> {
    const extractor = await this.loadExtractor();
    throwIfEmbeddingCancelled(signal);
    const output = await Promise.resolve().then(() =>
      extractor([...texts], { pooling: "mean", normalize: true })
    );
    return this.readVectors(output, texts.length);
  }

  private readVectors(
    output: Awaited<ReturnType<LocalOnnxFeatureExtractor>>,
    expectedCount: number
  ): readonly Float32Array[] {
    const rows = output.tolist();
    if (rows.length !== expectedCount) {
      throw new Error(
        `Local ONNX embedding returned ${rows.length} vectors for ${expectedCount} inputs.`
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
    this.extractorPromise = this.pipelineLoader(
      this.modelId,
      this.cacheDir,
      {
        sessionOptions: resolveLocalOnnxSessionOptionsFromEnv(process.env)
      }
    ).catch((error) => {
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

interface EmbeddingDeadline {
  readonly signal: AbortSignal;
  readonly close: () => void;
}

function createEmbeddingDeadline(timeoutMs: number, parent?: AbortSignal): EmbeddingDeadline {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted === true) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(
        () => controller.abort(new Error(`Local ONNX embedding timed out after ${timeoutMs} ms.`)),
        timeoutMs
      )
    : null;
  timer?.unref?.();
  return {
    signal: controller.signal,
    close: () => {
      if (timer !== null) clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    }
  };
}

function throwIfEmbeddingCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw embeddingCancellationError(signal);
}

function waitForEmbeddingCaller<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(embeddingCancellationError(signal));
    if (signal.aborted) {
      onAbort();
      work.catch(() => undefined);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function embeddingCancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Local ONNX embedding was cancelled.");
}

export function defaultLocalOnnxCacheDir(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  const cacheHome = xdgCacheHome && xdgCacheHome.length > 0
    ? xdgCacheHome
    : path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "do-soul-alaya/models");
}

export type LocalOnnxEmbeddingTransformersModule = {
  readonly env: {
    allowRemoteModels: boolean;
    cacheDir?: string;
    localModelPath?: string;
  };
  readonly pipeline: (
    task: "feature-extraction",
    model: string,
    options: {
      readonly dtype: string;
      readonly cache_dir?: string;
      readonly local_files_only: true;
      readonly session_options?: LocalOnnxSessionOptions;
    }
  ) => Promise<LocalOnnxFeatureExtractor>;
};

export type LocalOnnxEmbeddingTransformersImporter =
  () => Promise<LocalOnnxEmbeddingTransformersModule>;

// Transformers.js 4.2 pipeline preflight reads env.localModelPath before it
// forwards per-load cache options. Serialize that narrow initialization seam
// so bi-encoder and cross-encoder loads cannot borrow each other's cache root.
let localTransformersLoadQueue: Promise<void> = Promise.resolve();

export function withLocalTransformersOfflineLoad<T>(
  env: LocalOnnxEmbeddingTransformersModule["env"],
  cacheDir: string | null,
  load: () => Promise<T>
): Promise<T> {
  const run = localTransformersLoadQueue.then(async () => {
    const previousCacheDir = env.cacheDir;
    const previousLocalModelPath = env.localModelPath;
    env.allowRemoteModels = false;
    if (cacheDir !== null) {
      env.cacheDir = cacheDir;
      env.localModelPath = cacheDir;
    }
    try {
      return await load();
    } finally {
      restoreOptionalEnvPath(env, "cacheDir", previousCacheDir);
      restoreOptionalEnvPath(env, "localModelPath", previousLocalModelPath);
    }
  });
  localTransformersLoadQueue = run.then(() => undefined, () => undefined);
  return run;
}

function restoreOptionalEnvPath(
  env: LocalOnnxEmbeddingTransformersModule["env"],
  key: "cacheDir" | "localModelPath",
  value: string | undefined
): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

async function importTransformers(): Promise<LocalOnnxEmbeddingTransformersModule> {
  try {
    return (await import("@huggingface/transformers")) as LocalOnnxEmbeddingTransformersModule;
  } catch (error) {
    // Surface a packaging failure distinctly from an unreadable model artifact.
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "@huggingface/transformers is required for the local ONNX embedding provider.",
        { cause: error }
      );
    }
    throw error;
  }
}

async function defaultLocalOnnxPipelineLoader(
  modelId: string,
  cacheDir: string | null,
  options: LocalOnnxPipelineOptions,
  importer: LocalOnnxEmbeddingTransformersImporter
): Promise<LocalOnnxFeatureExtractor> {
  const transformers = await importer();
  // invariant: embedding is a recall supplement; the on-device provider must
  // not reach the network during recall. Weights are pre-fetched out of band.
  return withLocalTransformersOfflineLoad(transformers.env, cacheDir, async () =>
    transformers.pipeline("feature-extraction", modelId, {
      dtype: "q8",
      ...(cacheDir === null ? {} : { cache_dir: cacheDir }),
      local_files_only: true,
      ...(options.sessionOptions === undefined
        ? {}
        : { session_options: options.sessionOptions })
    })
  );
}

export function resolveLocalOnnxSessionOptionsFromEnv(
  env: { readonly ALAYA_LOCAL_ONNX_THREADS?: string }
): LocalOnnxSessionOptions | undefined {
  const threads = readPositiveThreadCount(env.ALAYA_LOCAL_ONNX_THREADS);
  if (threads === null) {
    return undefined;
  }
  return Object.freeze({
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential"
  });
}

function readPositiveThreadCount(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(parsed, 64);
}
