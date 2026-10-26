import type { Tensor } from "@huggingface/transformers";
import { CoreError } from "../shared/errors.js";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import {
  SourceIndexProfileSchema, sourceIndexProfileId, type SourceIndexProfile
} from "@do-soul/alaya-protocol";
import type {
  LocalOnnxFeatureExtractor, LocalOnnxPipelineOptions, LocalOnnxEmbeddingTransformersModule
} from "./local-onnx-embedding-client.js";
import { snapshotLocalOnnxArtifacts, type VerifiedLocalOnnxArtifacts } from "./local-onnx-artifacts.js";
import {
  captureSourceEmbeddingInputs, captureSourceEmbeddingBindingOptions, prepareSourceEmbeddingText,
  sourceEmbeddingInputDigest, sourceEmbeddingRefusals, sourceEmbeddingSha256,
  validateSourceEmbeddingResults,
  type SourceEmbeddingInput, type SourceEmbeddingBinding, type SourceEmbeddingBindingOptions, type SourceEmbeddingBindingResult, type SourceEmbeddingResult
} from "./source-embedding-runtime.js";

// Serialize global Transformers preflight configuration across loaded-runtime consumers.
let localTransformersLoadQueue: Promise<void> = Promise.resolve();
export function withLocalTransformersOfflineLoad<T>(env: LocalOnnxEmbeddingTransformersModule["env"],
  cacheDir: string | null, load: () => Promise<T>): Promise<T> {
  const run = localTransformersLoadQueue.then(async () => {
    const previousCacheDir = env.cacheDir;
    const previousLocalModelPath = env.localModelPath;
    const previousFsCache = env.useFSCache;
    env.allowRemoteModels = false;
    if (cacheDir !== null) { env.cacheDir = cacheDir; env.localModelPath = cacheDir; }
    try {
      env.useFSCache = false; // Missing snapshot files must not come from another unverified cache.
      return await load();
    } finally {
      if (previousFsCache === undefined) delete env.useFSCache;
      else env.useFSCache = previousFsCache;
      restoreOptionalEnvPath(env, "cacheDir", previousCacheDir);
      restoreOptionalEnvPath(env, "localModelPath", previousLocalModelPath);
    }
  });
  localTransformersLoadQueue = run.then(() => undefined, () => undefined);
  return run;
}
function restoreOptionalEnvPath(env: LocalOnnxEmbeddingTransformersModule["env"],
  key: "cacheDir" | "localModelPath", value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

type ModelInputs = Readonly<Record<string, Tensor>> & { readonly input_ids: Tensor; readonly attention_mask: Tensor };
interface LoadedPipeline extends LocalOnnxFeatureExtractor {
  readonly tokenizer: {
    (texts: string[], options: { padding: false; truncation: false; add_special_tokens: true }): ModelInputs;
    readonly model_max_length: number;
  };
  readonly model: {
    (inputs: ModelInputs): Promise<Readonly<Record<string, Tensor>>>;
    readonly config: { readonly hidden_size?: number; readonly max_position_embeddings?: number; readonly model_type?: string };
  };
  dispose(): Promise<void>;
}
export interface LocalOnnxLoadedSourceRuntime {
  bind(options: SourceEmbeddingBindingOptions): SourceEmbeddingBindingResult;
  close(): Promise<void>;
}

/** The opaque legacy pipeline and the strict Source adapter share its loaded tokenizer/model. */
export async function loadVerifiedLocalOnnxExtractor(modelId: string, cacheDir: string, options: LocalOnnxPipelineOptions,
  transformers: LocalOnnxEmbeddingTransformersModule): Promise<LocalOnnxFeatureExtractor> {
  if (transformers.env.version !== "4.3.1" || typeof transformers.mean_pooling !== "function") {
    throw new CoreError("CONFLICT", "Verified local Source runtime requires maintained Transformers 4.3.1", { subCode: "PORT_UNAVAILABLE" });
  }
  const artifacts = await snapshotLocalOnnxArtifacts(cacheDir, modelId);
  let pipeline: LoadedPipeline | undefined;
  try {
    pipeline = await withLocalTransformersOfflineLoad(transformers.env, cacheDir, () => transformers.pipeline(
      "feature-extraction", artifacts.modelRoot, { dtype: "q8", device: "cpu", model_file_name: "model", subfolder: "onnx",
        use_external_data_format: false, local_files_only: true,
        ...(options.sessionOptions === undefined ? {} : { session_options: options.sessionOptions }) }
    )) as LoadedPipeline;
    // Both limits must come from the loaded encoder/tokenizer, not a model-name guess.
    const maxTokens = Math.min(pipeline.tokenizer.model_max_length, pipeline.model.config.max_position_embeddings ?? NaN);
    if (pipeline.model.config.model_type !== "bert" || pipeline.model.config.hidden_size !== 384 ||
        artifacts.config.hidden_size !== 384 || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
      throw new CoreError("VALIDATION", "Unsupported local ONNX encoder dimensions or token limits");
    }
    const runtimeVersion = await installedRuntimeVersion(transformers.env.version);
    const runtime = createLoadedSourceRuntime(modelId, pipeline, artifacts, maxTokens, runtimeVersion, transformers.mean_pooling);
    // Tokenizer and ORT sessions are fully loaded. Retain their descriptor, not disposable disk copies.
    await artifacts.dispose();
    const extractor: LocalOnnxFeatureExtractor = (texts, callOptions) => pipeline!(texts, callOptions);
    Object.assign(extractor, { sourceRuntime: runtime });
    return extractor;
  } catch (error) {
    try { await pipeline?.dispose(); } finally { await artifacts.dispose(); }
    throw error;
  }
}

function createLoadedSourceRuntime(modelId: string, pipeline: LoadedPipeline, artifacts: VerifiedLocalOnnxArtifacts,
  maxTokens: number, runtimeVersion: string, meanPool: (tensor: Tensor, mask: Tensor) => Tensor): LocalOnnxLoadedSourceRuntime {
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  return {
    bind: options => {
      const captured = captureSourceEmbeddingBindingOptions(options);
      if (closed) return { status: "unsupported", reason: "runtime_closed" };
      const profile = SourceIndexProfileSchema.parse({ provider_kind: "local_onnx", model_id: modelId,
        model_revision: `sha256:${artifacts.weightSha256}`, artifact_digest: `sha256:${artifacts.treeSha256}`,
        // Full tree includes tokenizer.json, tokenizer config and special token definitions.
        tokenizer_revision: `sha256:${artifacts.treeSha256}`, dimensions: 384,
        preprocessing: `${captured.representation === undefined ? "raw-string" : "paired-prefix"}.special-tokens.no-truncation.v1;${runtimeVersion}`,
        ...(captured.representation === undefined ? {} : { representation: captured.representation }),
        normalization: "attention-mask-mean.l2.q8.v1", max_input_tokens: Math.min(maxTokens, captured.max_input_tokens ?? maxTokens),
        windowing: captured.windowing, window_bytes: captured.window_bytes });
      const profileId = sourceIndexProfileId(profile, sourceEmbeddingSha256);
      return Object.freeze<SourceEmbeddingBinding>({ status: "ready", profile, profile_id: profileId,
        embedInputs: (inputs, callOptions) => {
          const capturedInputs = captureSourceEmbeddingInputs(inputs);
          callOptions = { ...callOptions };
          const reason = closed ? "runtime_closed" : callOptions.profile_id !== profileId ? "profile_mismatch"
            : callOptions.signal?.aborted ? "cancelled" : null;
          if (reason !== null) return Promise.resolve(sourceEmbeddingRefusals(capturedInputs, reason));
          const work = embedPreparedInputs(pipeline, meanPool, capturedInputs, profile, callOptions.signal);
          pending.add(work);
          void work.finally(() => pending.delete(work)).catch(() => undefined);
          return work.then(results => closed || callOptions.signal?.aborted
            ? sourceEmbeddingRefusals(capturedInputs, closed ? "runtime_closed" : "cancelled", results)
            : validateSourceEmbeddingResults(capturedInputs, results, profile));
        } });
    },
    close: () => {
      closed = true;
      return closing ??= (async () => {
        await Promise.allSettled([...pending]);
        try { await pipeline.dispose(); } finally { await artifacts.dispose(); }
      })();
    }
  };
}

async function embedPreparedInputs(pipeline: LoadedPipeline, meanPool: (tensor: Tensor, mask: Tensor) => Tensor,
  inputs: readonly SourceEmbeddingInput[], profile: SourceIndexProfile,
  signal?: AbortSignal): Promise<readonly SourceEmbeddingResult[]> {
  const results: SourceEmbeddingResult[] = [];
  for (const input of inputs) {
    let tokenCount: number | null = null;
    const evidence = { input_id: input.input_id, input_digest: sourceEmbeddingInputDigest(input.text) };
    try {
      if (signal?.aborted) throw new CoreError("CONFLICT", "cancelled", { cause: signal.reason });
      // Prepare once, before counting special tokens and enforcing the no-truncation ceiling.
      const text = prepareSourceEmbeddingText(input, profile);
      const preparation = profile.representation === undefined ? {} : {
        role: input.role, prepared_input_digest: sourceEmbeddingInputDigest(text)
      };
      // A single row avoids padding and permits over-limit refusal before any model call.
      const prepared = pipeline.tokenizer([text], { padding: false, truncation: false, add_special_tokens: true });
      const mask = prepared.attention_mask.tolist()[0] as readonly (number | bigint)[] | undefined;
      if (!mask || prepared.input_ids.dims.length !== 2 || prepared.attention_mask.dims.length !== 2 ||
          prepared.input_ids.dims[0] !== 1 || prepared.attention_mask.dims[0] !== 1 ||
          mask.length !== prepared.input_ids.dims[1] || !mask.every(value => Number(value) === 1)) {
        throw new CoreError("OBLIGATION_VIOLATION", "invalid_prepared_tokens");
      }
      tokenCount = mask.length;
      if (tokenCount < 1) throw new CoreError("OBLIGATION_VIOLATION", "empty_prepared_tokens");
      if (tokenCount > profile.max_input_tokens) {
        results.push({ ...evidence, status: "not_embedded", reason: "input_token_limit", token_count: tokenCount });
        continue;
      }
      if (signal?.aborted) throw new CoreError("CONFLICT", "cancelled", { cause: signal.reason });
      const output = await pipeline.model(prepared);
      if (signal?.aborted) throw new CoreError("CONFLICT", "cancelled", { cause: signal.reason });
      const hidden = output.last_hidden_state ?? output.logits ?? output.token_embeddings;
      if (!hidden || hidden.dims[0] !== 1 || hidden.dims[1] !== tokenCount || hidden.dims[2] !== profile.dimensions) {
        throw new CoreError("OBLIGATION_VIOLATION", "invalid_model_output");
      }
      const rows = meanPool(hidden, prepared.attention_mask).normalize(2, -1).tolist();
      results.push(validateSourceEmbeddingResults([input], [{ ...evidence, ...preparation, status: "embedded",
        vector: new Float32Array(rows[0]!), token_count: tokenCount, truncated: false }], profile)[0]!);
    } catch (error) {
      results.push({ ...evidence, status: "not_embedded", token_count: tokenCount,
        reason: signal?.aborted ? "cancelled" : error instanceof Error ? error.message : "inference_failed" });
    }
  }
  return results;
}

async function installedRuntimeVersion(transformersVersion: string): Promise<string> {
  const require = createRequire(import.meta.url);
  const transformersRequire = createRequire(require.resolve("@huggingface/transformers"));
  const ortManifest = JSON.parse(await readFile(transformersRequire.resolve("onnxruntime-node/package.json"), "utf8")) as { version: string };
  return `transformers-${transformersVersion}.ort-${ortManifest.version}.cpu`;
}
