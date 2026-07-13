import {
  defaultLocalOnnxCacheDir,
  resolveLocalOnnxSessionOptionsFromEnv,
  withLocalTransformersOfflineLoad,
  type LocalOnnxSessionOptions
} from "./local-onnx-embedding-client.js";
import { withLocalOnnxHostSingleFlight } from "./local-onnx-host-single-flight.js";

interface LocalOnnxCrossEncoderPair { readonly query: string; readonly passage: string }
interface LocalOnnxCrossEncoderRuntime {
  infer(pairs: readonly LocalOnnxCrossEncoderPair[]): Promise<readonly number[]>;
}
interface LocalOnnxCrossEncoderLoadOptions {
  readonly maxInputTokens: number;
  readonly sessionOptions?: LocalOnnxSessionOptions;
}

type LocalOnnxCrossEncoderLoader = (
  modelId: string,
  cacheDir: string | null,
  options: LocalOnnxCrossEncoderLoadOptions
) => Promise<LocalOnnxCrossEncoderRuntime>;

export type LocalOnnxCrossEncoderErrorCode = "DEPENDENCY_MISSING" | "MODEL_UNAVAILABLE"
  | "INVALID_INPUT" | "INVALID_OUTPUT" | "QUEUE_FULL" | "QUEUE_TIMEOUT"
  | "MODEL_LOAD_TIMEOUT" | "INFERENCE_TIMEOUT";

export class LocalOnnxCrossEncoderError extends Error {
  public readonly name = "LocalOnnxCrossEncoderError";
  public constructor(
    public readonly code: LocalOnnxCrossEncoderErrorCode,
    message: string,
    public readonly modelId: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}
export interface LocalOnnxCrossEncoderClientOptions {
  readonly modelId?: string;
  readonly cacheDir?: string | null;
  readonly maxBatchSize?: number;
  readonly maxInputTokens?: number;
  readonly maxQueueSize?: number;
  readonly queueWaitTimeoutMs?: number;
  readonly modelLoadTimeoutMs?: number;
  readonly inferenceTimeoutMs?: number;
  readonly loader?: LocalOnnxCrossEncoderLoader;
  readonly transformersImporter?: LocalOnnxCrossEncoderTransformersImporter;
}
const DEFAULT_MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";
const DEFAULT_MAX_BATCH_SIZE = 16;
const DEFAULT_MAX_INPUT_TOKENS = 512;
const DEFAULT_MAX_QUEUE_SIZE = 32;
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_LOAD_TIMEOUT_MS = 60_000;
const DEFAULT_INFERENCE_TIMEOUT_MS = 15_000;
const MAX_BATCH_SIZE = 128;
const MAX_BERT_INPUT_TOKENS = 512;
const MAX_QUEUE_SIZE = 1_024;
const MAX_TIMEOUT_MS = 10 * 60_000;

interface ScoreJob {
  readonly query: string;
  readonly passages: readonly string[];
  readonly resolve: (scores: readonly number[]) => void;
  readonly reject: (error: unknown) => void;
  queueTimer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}
export class LocalOnnxCrossEncoderClient {
  public readonly modelId: string;
  private readonly cacheDir: string | null;
  private readonly maxBatchSize: number;
  private readonly maxInputTokens: number;
  private readonly maxQueueSize: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly modelLoadTimeoutMs: number;
  private readonly inferenceTimeoutMs: number;
  private readonly loader: LocalOnnxCrossEncoderLoader;
  private readonly queue: ScoreJob[] = [];
  private modelPromise: Promise<LocalOnnxCrossEncoderRuntime> | null = null;
  private inferenceActive = false;
  private terminalError: LocalOnnxCrossEncoderError | null = null;
  public constructor(options: LocalOnnxCrossEncoderClientOptions = {}) {
    this.modelId = options.modelId?.trim() || DEFAULT_MODEL_ID;
    this.cacheDir = options.cacheDir === undefined
      ? defaultLocalOnnxCacheDir()
      : options.cacheDir;
    this.maxBatchSize = validateLimit(
      "maxBatchSize",
      options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
      1,
      MAX_BATCH_SIZE
    );
    this.maxInputTokens = validateLimit(
      "maxInputTokens",
      options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      8,
      MAX_BERT_INPUT_TOKENS
    );
    this.maxQueueSize = validateLimit(
      "maxQueueSize",
      options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      1,
      MAX_QUEUE_SIZE
    );
    this.queueWaitTimeoutMs = validateTimeout(
      "queueWaitTimeoutMs",
      options.queueWaitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS
    );
    this.modelLoadTimeoutMs = validateTimeout(
      "modelLoadTimeoutMs",
      options.modelLoadTimeoutMs ?? DEFAULT_MODEL_LOAD_TIMEOUT_MS
    );
    this.inferenceTimeoutMs = validateTimeout(
      "inferenceTimeoutMs",
      options.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS
    );
    const importer = options.transformersImporter ?? importTransformers;
    this.loader = options.loader ?? ((modelId, cacheDir, loadOptions) =>
      defaultLocalOnnxCrossEncoderLoader(modelId, cacheDir, loadOptions, importer));
  }
  public warm(): Promise<void> {
    return new Promise((resolve, reject) => {
      const occupancy = withLocalOnnxHostSingleFlight(async () => {
        const loading = this.loadModel();
        const observed = await observeWithTimeout(loading, this.modelLoadTimeoutMs);
        if (!observed.timedOut) {
          resolve();
          return;
        }
        reject(this.timeoutError("MODEL_LOAD_TIMEOUT", "model load", this.modelLoadTimeoutMs));
        await loading.catch(() => undefined);
      });
      void occupancy.catch(reject);
    });
  }
  public async score(query: string, passages: readonly string[]): Promise<readonly number[]> {
    validateInputs(query, passages, this.modelId);
    if (passages.length === 0) {
      return Object.freeze([]);
    }
    return await this.enqueue(query, passages);
  }
  private enqueue(query: string, passages: readonly string[]): Promise<readonly number[]> {
    if (this.terminalError !== null) {
      return Promise.reject(this.terminalError);
    }
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new LocalOnnxCrossEncoderError(
        "QUEUE_FULL", `Local ONNX cross-encoder queue is full at ${this.maxQueueSize} waiting requests.`, this.modelId
      ));
    }
    return new Promise((resolve, reject) => {
      const job: ScoreJob = {
        query,
        passages: Object.freeze([...passages]),
        resolve,
        reject,
        queueTimer: null,
        settled: false
      };
      job.queueTimer = setTimeout(() => this.expireQueuedJob(job), this.queueWaitTimeoutMs);
      this.queue.push(job);
      this.drainQueue();
    });
  }
  private drainQueue(): void {
    if (this.inferenceActive) {
      return;
    }
    const job = this.queue.shift();
    if (job === undefined) {
      return;
    }
    clearJobTimer(job);
    this.inferenceActive = true;
    void this.runJob(job).finally(() => {
      this.inferenceActive = false;
      this.drainQueue();
    });
  }
  private async runJob(job: ScoreJob): Promise<void> {
    try {
      await withLocalOnnxHostSingleFlight(async () => {
        const model = await this.loadModelForJob(job);
        if (model === null) return;
        const scores = await this.scoreBatches(model, job);
        if (scores !== null) settleJob(job, "resolve", Object.freeze(scores));
      });
    } catch (error) {
      settleJob(job, "reject", error);
    }
  }
  private async loadModelForJob(job: ScoreJob): Promise<LocalOnnxCrossEncoderRuntime | null> {
    const loading = this.loadModel();
    const observed = await observeWithTimeout(loading, this.modelLoadTimeoutMs);
    if (!observed.timedOut) return observed.value;
    settleJob(job, "reject", this.timeoutError(
      "MODEL_LOAD_TIMEOUT", "model load", this.modelLoadTimeoutMs
    ));
    await loading.catch(() => undefined);
    return null;
  }
  private async scoreBatches(
    model: LocalOnnxCrossEncoderRuntime,
    job: ScoreJob
  ): Promise<number[] | null> {
    const scores: number[] = [];
    for (let offset = 0; offset < job.passages.length; offset += this.maxBatchSize) {
      const passages = job.passages.slice(offset, offset + this.maxBatchSize);
      const batch = buildPairs(job.query, passages);
      const inference = Promise.resolve().then(() => model.infer(batch));
      const observed = await observeWithTimeout(inference, this.inferenceTimeoutMs);
      if (observed.timedOut) {
        this.poison(job, this.timeoutError(
          "INFERENCE_TIMEOUT", "inference", this.inferenceTimeoutMs
        ));
        await inference.catch(() => undefined);
        return null;
      }
      const logits = observed.value;
      validateScores(logits, batch.length, this.modelId);
      scores.push(...logits.map(sigmoid));
    }
    return scores;
  }
  private poison(job: ScoreJob, error: LocalOnnxCrossEncoderError): void {
    this.terminalError ??= error;
    settleJob(job, "reject", this.terminalError);
    for (const queued of this.queue.splice(0)) {
      settleJob(queued, "reject", this.terminalError);
    }
  }
  private expireQueuedJob(job: ScoreJob): void {
    const index = this.queue.indexOf(job);
    if (index < 0) {
      return;
    }
    this.queue.splice(index, 1);
    settleJob(job, "reject", this.timeoutError(
      "QUEUE_TIMEOUT", "queue wait", this.queueWaitTimeoutMs
    ));
  }
  private timeoutError(
    code: "QUEUE_TIMEOUT" | "MODEL_LOAD_TIMEOUT" | "INFERENCE_TIMEOUT",
    phase: string,
    timeoutMs: number
  ): LocalOnnxCrossEncoderError {
    return new LocalOnnxCrossEncoderError(
      code,
      `Local ONNX cross-encoder ${phase} timed out after ${timeoutMs} ms.`,
      this.modelId
    );
  }
  private loadModel(): Promise<LocalOnnxCrossEncoderRuntime> {
    if (this.modelPromise === null) {
      this.modelPromise = this.loader(
        this.modelId,
        this.cacheDir,
        {
          maxInputTokens: this.maxInputTokens,
          sessionOptions: resolveLocalOnnxSessionOptionsFromEnv(process.env)
        }
      ).catch((error: unknown) => {
        this.modelPromise = null;
        throw classifyLoadError(error, this.modelId, this.cacheDir);
      });
    }
    return this.modelPromise;
  }
}
function validateTimeout(name: string, value: number): number {
  return validateLimit(name, value, 1, MAX_TIMEOUT_MS);
}
function clearJobTimer(job: ScoreJob): void {
  if (job.queueTimer !== null) {
    clearTimeout(job.queueTimer);
    job.queueTimer = null;
  }
}
function settleJob(
  job: ScoreJob,
  action: "resolve" | "reject",
  value: readonly number[] | unknown
): void {
  if (job.settled) {
    return;
  }
  job.settled = true;
  clearJobTimer(job);
  if (action === "resolve") {
    job.resolve(value as readonly number[]);
    return;
  }
  job.reject(value);
}
type TimedObservation<T> =
  | Readonly<{ timedOut: true }>
  | Readonly<{ timedOut: false; value: T }>;
function observeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimedObservation<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function validateLimit(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}; received ${value}.`);
  }
  return value;
}
function validateInputs(
  query: string,
  passages: readonly string[],
  modelId: string
): void {
  if (query.trim().length === 0) {
    throw new LocalOnnxCrossEncoderError(
      "INVALID_INPUT", "Cross-encoder query must not be empty.", modelId
    );
  }
  for (const [index, passage] of passages.entries()) {
    if (passage.trim().length === 0) {
      throw new LocalOnnxCrossEncoderError(
        "INVALID_INPUT", `Cross-encoder passage ${index} must not be empty.`, modelId
      );
    }
  }
}
function buildPairs(query: string, passages: readonly string[]): readonly LocalOnnxCrossEncoderPair[] {
  return Object.freeze(passages.map((passage) => Object.freeze({ query, passage })));
}
function sigmoid(logit: number): number {
  if (logit >= 0) {
    return 1 / (1 + Math.exp(-logit));
  }
  const exp = Math.exp(logit);
  return exp / (1 + exp);
}
function validateScores(
  scores: readonly number[],
  expectedCount: number,
  modelId: string
): void {
  if (scores.length !== expectedCount) {
    throw new LocalOnnxCrossEncoderError(
      "INVALID_OUTPUT", `Local ONNX cross-encoder returned ${scores.length} scores for ${expectedCount} inputs.`, modelId
    );
  }
  const invalidIndex = scores.findIndex((score) => !Number.isFinite(score));
  if (invalidIndex >= 0) {
    throw new LocalOnnxCrossEncoderError(
      "INVALID_OUTPUT", `Local ONNX cross-encoder score ${invalidIndex} was not finite.`, modelId
    );
  }
}
function classifyLoadError(
  error: unknown,
  modelId: string,
  cacheDir: string | null
): LocalOnnxCrossEncoderError {
  if (error instanceof LocalOnnxCrossEncoderError) {
    return error;
  }
  if ((error as { readonly code?: string }).code === "ERR_MODULE_NOT_FOUND") {
    return new LocalOnnxCrossEncoderError(
      "DEPENDENCY_MISSING",
      "@huggingface/transformers is required for the local ONNX cross-encoder.",
      modelId,
      { cause: error }
    );
  }
  return new LocalOnnxCrossEncoderError(
    "MODEL_UNAVAILABLE",
    `Local ONNX cross-encoder model '${modelId}' was not available in cache '${cacheDir ?? "default"}'; remote loading is disabled.`,
    modelId,
    { cause: error }
  );
}
type LocalOnnxTokenizer = (
  queries: readonly string[],
  options: Readonly<{
    text_pair: readonly string[];
    padding: true;
    truncation: true;
    max_length: number;
  }>
) => unknown;
type LocalOnnxSequenceClassifier = (
  inputs: unknown
) => Promise<Readonly<{ readonly logits: Readonly<{ tolist(): unknown }> }>>;
export type LocalOnnxCrossEncoderTransformersModule = Readonly<{
  env: {
    allowRemoteModels: boolean;
    cacheDir?: string;
    localModelPath?: string;
  };
  AutoTokenizer: Readonly<{
    from_pretrained(modelId: string, options: LocalFilesOptions): Promise<LocalOnnxTokenizer>;
  }>;
  BertForSequenceClassification: Readonly<{
    from_pretrained(modelId: string, options: ModelFilesOptions): Promise<LocalOnnxSequenceClassifier>;
  }>;
}>;
export type LocalOnnxCrossEncoderTransformersImporter =
  () => Promise<LocalOnnxCrossEncoderTransformersModule>;
type LocalFilesOptions = Readonly<{ cache_dir?: string; local_files_only: true }>;
type ModelFilesOptions = LocalFilesOptions & Readonly<{
  dtype: "q8";
  session_options?: LocalOnnxSessionOptions;
}>;
async function defaultLocalOnnxCrossEncoderLoader(
  modelId: string,
  cacheDir: string | null,
  options: LocalOnnxCrossEncoderLoadOptions,
  importer: LocalOnnxCrossEncoderTransformersImporter
): Promise<LocalOnnxCrossEncoderRuntime> {
  const transformers = await importer();
  const [tokenizer, model] = await withLocalTransformersOfflineLoad(
    transformers.env,
    cacheDir,
    async () => {
      const localOptions = localFilesOptions(cacheDir);
      return await Promise.all([
        transformers.AutoTokenizer.from_pretrained(modelId, localOptions),
        transformers.BertForSequenceClassification.from_pretrained(modelId, {
          ...localOptions,
          dtype: "q8",
          ...(options.sessionOptions === undefined
            ? {}
            : { session_options: options.sessionOptions })
        })
      ]);
    }
  );
  return Object.freeze({
    infer: async (pairs: readonly LocalOnnxCrossEncoderPair[]) => {
      const encoded = tokenizer(pairs.map(({ query }) => query), {
        text_pair: pairs.map(({ passage }) => passage),
        padding: true, truncation: true, max_length: options.maxInputTokens
      });
      const output = await model(encoded);
      return readSingleLogitScores(output.logits.tolist(), pairs.length, modelId);
    }
  });
}
async function importTransformers(): Promise<LocalOnnxCrossEncoderTransformersModule> {
  return (await import("@huggingface/transformers")) as unknown as LocalOnnxCrossEncoderTransformersModule;
}
function localFilesOptions(cacheDir: string | null): LocalFilesOptions {
  return Object.freeze({
    ...(cacheDir === null ? {} : { cache_dir: cacheDir }),
    local_files_only: true
  });
}
function readSingleLogitScores(
  raw: unknown,
  expectedCount: number,
  modelId: string
): readonly number[] {
  if (!Array.isArray(raw) || raw.length !== expectedCount) {
    throw new LocalOnnxCrossEncoderError(
      "INVALID_OUTPUT", `Model '${modelId}' must emit one logit row per input.`, modelId
    );
  }
  return raw.map((row, index) => readSingleLogit(row, index, modelId));
}
function readSingleLogit(row: unknown, index: number, modelId: string): number {
  const value = typeof row === "number"
    ? row
    : Array.isArray(row) && row.length === 1
      ? row[0]
      : undefined;
  if (typeof value !== "number") {
    throw new LocalOnnxCrossEncoderError(
      "INVALID_OUTPUT", `Model '${modelId}' logit row ${index} must contain exactly one score.`, modelId
    );
  }
  return value;
}
