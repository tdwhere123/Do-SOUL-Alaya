import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import { Tensor } from "@huggingface/transformers";
import { sourceIndexProfileId } from "@do-soul/alaya-protocol";
import type { LocalOnnxEmbeddingTransformersModule, LocalOnnxFeatureExtractor } from "../../embedding-recall/local-onnx-embedding-client.js";
import { loadVerifiedLocalOnnxExtractor } from "../../embedding-recall/local-onnx-loaded-runtime.js";
import {
  sourceEmbeddingInputDigest, captureSourceEmbeddingBindingOptions, validateSourceEmbeddingResults,
  sourceEmbeddingSha256, type SourceEmbeddingBindingOptions
} from "../../embedding-recall/source-embedding-runtime.js";

const UNICODE_TEXT = "  原文🙂\r\n\u00A0";
const CLS = 101;
const SEP = 102;
const DIMENSIONS = 384;
const LOADED_TOKEN_CAP = 16;
const caches: string[] = [];
const runtimes: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()!.close();
  while (caches.length > 0) rmSync(caches.pop()!, { recursive: true, force: true });
});

describe("loaded local ONNX Source embedding runtime (controlled tokenizer/model seams)", () => {
  it("binds both prefixes, prepares exactly once, and preserves raw identity evidence", async () => {
    const seam = createControlledSeam();
    const options: SourceEmbeddingBindingOptions = { window_bytes: 1024, representation: {
      kind: "paired-prefix.v1", query_prefix: "Q: ", passage_prefix: "P: " } };
    const { binding, runtime } = await loadBoundRuntime(seam, options);
    expect(Object.isFrozen(binding.profile.representation)).toBe(true);
    const raw = runtime.bind({ window_bytes: 1024 });
    if (raw.status !== "ready") throw new Error("raw binding required");
    expect(binding.profile_id).not.toBe(raw.profile_id);
    const inputs = [{ input_id: "same", text: " raw ", role: "query" as const },
      { input_id: "same", text: " raw ", role: "passage" as const }];
    const rows = await binding.embedInputs(inputs, { profile_id: binding.profile_id, timeoutMs: 5000 });
    expect(seam.tokenizerCalls.map(call => call.texts)).toEqual([["Q:  raw "], ["P:  raw "]]);
    expect(inputs.map(row => row.text)).toEqual([" raw ", " raw "]);
    expect(rows).toMatchObject(inputs.map((input, i) => ({ status: "embedded", role: input.role,
      input_digest: goldenInputDigest(" raw "), prepared_input_digest: goldenInputDigest(i === 0 ? "Q:  raw " : "P:  raw ") })));
    expect(() => validateSourceEmbeddingResults(inputs, rows.map(({ role: _role, ...row }) => row), binding.profile))
      .toThrow(/preparation evidence/);
    expect(() => validateSourceEmbeddingResults(inputs, rows.map(row => ({ ...row, role: "passage" })), binding.profile))
      .toThrow(/preparation evidence/);
    const omitted = await binding.embedInputs([{ input_id: "query", text: "raw" }], { profile_id: binding.profile_id, timeoutMs: 5000 });
    expect(omitted).toMatchObject([{ status: "not_embedded", reason: "source_embedding_role_required", token_count: null }]);
    expect(seam.modelCalls).toHaveLength(2);
    expect(() => binding.embedInputs([{ input_id: "bad", text: "raw", role: "wrong" as "query" }],
      { profile_id: binding.profile_id, timeoutMs: 5000 })).toThrow(/role/);
  });

  it("counts prefixes and special tokens before encoder execution and captures mutable role/options", async () => {
    const seam = createControlledSeam();
    const { runtime } = await loadRuntime(seam);
    const options = { window_bytes: 1024, max_input_tokens: 5, representation: {
      kind: "paired-prefix.v1" as const, query_prefix: "Q: ", passage_prefix: "P: " } };
    const captured = captureSourceEmbeddingBindingOptions(options);
    options.representation.query_prefix = "changed";
    expect(captured.representation?.query_prefix).toBe("Q: ");
    const binding = runtime.bind(captured);
    if (binding.status !== "ready") throw new Error("paired binding required");
    const inputs = [{ input_id: "x", text: "xx", role: "query" as "query" | "passage" }];
    const pending = binding.embedInputs(inputs, { profile_id: binding.profile_id, timeoutMs: 5000 });
    inputs[0]!.role = "passage"; inputs[0]!.text = "changed";
    expect(await pending).toMatchObject([{ status: "not_embedded", reason: "input_token_limit", token_count: 7,
      input_digest: goldenInputDigest("xx") }]);
    expect(seam.tokenizerCalls[0]?.texts).toEqual(["Q: xx"]);
    expect(seam.modelCalls).toEqual([]);
    expect(() => captureSourceEmbeddingBindingOptions({ ...options, representation: null as never })).toThrow();
    expect(() => captureSourceEmbeddingBindingOptions({ ...options, representation: { ...options.representation, kind: "unknown" as never } })).toThrow();
  });

  it("passes identical prepared tensors to the model and attests raw Unicode digest with counted special tokens and no truncation", async () => {
    const seam = createControlledSeam();
    const { binding, profile } = await loadBoundRuntime(seam);
    expect(seam.pipelineOptions).toMatchObject({
      dtype: "q8",
      device: "cpu",
      model_file_name: "model",
      subfolder: "onnx",
      use_external_data_format: false,
      local_files_only: true
    });
    expect(seam.allowRemoteModelsAtLoad).toBe(false);
    expect(profile).toMatchObject({
      provider_kind: "local_onnx",
      dimensions: DIMENSIONS,
      preprocessing: "raw-string.special-tokens.no-truncation.v1;transformers-4.3.1.ort-1.30.0.cpu",
      normalization: "attention-mask-mean.l2.q8.v1",
      windowing: "utf8-byte-windows.v1",
      max_input_tokens: LOADED_TOKEN_CAP
    });
    expect(profile.model_revision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(profile.artifact_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(profile.tokenizer_revision).toBe(profile.artifact_digest);
    expect(binding.profile_id).toBe(sourceIndexProfileId(profile, sourceEmbeddingSha256));
    const result = await binding.embedInputs(
      [{ input_id: "unicode", text: UNICODE_TEXT }],
      { profile_id: binding.profile_id, timeoutMs: 5_000 }
    );
    expect(seam.tokenizerCalls).toEqual([{
      texts: [UNICODE_TEXT],
      options: { padding: false, truncation: false, add_special_tokens: true }
    }]);
    expect(seam.modelCalls).toHaveLength(1);
    expect(seam.modelCalls[0]).toBe(seam.prepared[0]);
    const tokenCount = specialTokenCount(UNICODE_TEXT);
    expect(tokenCount).toBe([...UNICODE_TEXT].length + 2);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: "embedded",
      input_id: "unicode",
      input_digest: goldenInputDigest(UNICODE_TEXT),
      token_count: tokenCount,
      truncated: false
    });
    expect(result[0]!.input_digest).toBe(sourceEmbeddingInputDigest(UNICODE_TEXT));
    if (result[0]?.status !== "embedded") throw new Error("controlled seam must embed");
    expect(result[0].vector).toBeInstanceOf(Float32Array);
    expect(result[0].vector).toHaveLength(DIMENSIONS);
    expect(Math.hypot(...result[0].vector)).toBeCloseTo(1, 6);
    expect(seam.prepared[0]?.input_ids.dims).toEqual([1, tokenCount]);
    expect(seam.prepared[0]?.attention_mask.tolist()).toEqual([Array.from({ length: tokenCount }, () => 1)]);
    expect(seam.normalizeCalls).toEqual([{ ord: 2, dim: -1 }]);
  });

  it("does not call the model when prepared tokens exceed the bound limit", async () => {
    const seam = createControlledSeam();
    const { binding } = await loadBoundRuntime(seam, { window_bytes: 1024, max_input_tokens: 2 });
    const text = "x";
    const rows = await binding.embedInputs(
      [{ input_id: "over", text }],
      { profile_id: binding.profile_id, timeoutMs: 5_000 }
    );
    expect([...text].length).toBeLessThanOrEqual(2);
    expect(specialTokenCount(text)).toBeGreaterThan(2);
    expect(seam.modelCalls).toEqual([]);
    expect(rows).toEqual([{
      status: "not_embedded",
      input_id: "over",
      input_digest: goldenInputDigest(text),
      reason: "input_token_limit",
      token_count: specialTokenCount(text)
    }]);
  });

  it("cannot raise the frozen profile token ceiling before or during a call under its original id", async () => {
    const seam = createControlledSeam();
    const { binding } = await loadBoundRuntime(seam, { window_bytes: 1024, max_input_tokens: 3 });
    const profileId = binding.profile_id;
    const text = "xx";
    expect(Object.isFrozen(binding.profile)).toBe(true);
    const attempts = [Reflect.set(binding.profile, "max_input_tokens", LOADED_TOKEN_CAP)];
    expect(binding.profile.max_input_tokens).toBe(3);
    seam.tokenize = () => {
      attempts.push(Reflect.set(binding.profile, "max_input_tokens", LOADED_TOKEN_CAP));
      return tokenizeWithSpecials(text);
    };
    const rows = await binding.embedInputs(
      [{ input_id: "over", text }],
      { profile_id: profileId, timeoutMs: 5_000 }
    );
    expect(attempts).toEqual([false, false]);
    expect(binding.profile.max_input_tokens).toBe(3);
    expect(binding.profile_id).toBe(profileId);
    expect(sourceIndexProfileId(binding.profile, sourceEmbeddingSha256)).toBe(profileId);
    expect(seam.tokenizerCalls).toEqual([{
      texts: [text], options: { padding: false, truncation: false, add_special_tokens: true }
    }]);
    expect(seam.modelCalls).toEqual([]);
    expect(rows).toEqual([{
      status: "not_embedded", input_id: "over", input_digest: goldenInputDigest(text),
      reason: "input_token_limit", token_count: 4
    }]);
  });

  it("keeps a per-input model failure explicit without dropping the sibling input", async () => {
    const seam = createControlledSeam({
      async model(prepared) {
        if (preparedText(seam, prepared) === "second") throw new Error("controlled seam inference fault");
        return hiddenOutput(prepared.attention_mask.dims[1]!);
      }
    });
    const { binding } = await loadBoundRuntime(seam);
    const rows = await binding.embedInputs(
      [{ input_id: "a", text: "first" }, { input_id: "b", text: "second" }],
      { profile_id: binding.profile_id, timeoutMs: 5_000 }
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      status: "embedded",
      input_id: "a",
      input_digest: goldenInputDigest("first"),
      truncated: false
    });
    expect(rows[1]).toEqual({
      status: "not_embedded",
      input_id: "b",
      input_digest: goldenInputDigest("second"),
      reason: "controlled seam inference fault",
      token_count: specialTokenCount("second")
    });
  });

  it("refuses bad prepared dimensions and model output without treating them as embeddings", async () => {
    const badDims = createControlledSeam({
      tokenize() {
        return {
          input_ids: new ControlledTensor([1, 2, 2], [[CLS, 7, SEP]]),
          attention_mask: new ControlledTensor([1, 3], [[1, 1, 1]])
        };
      }
    });
    const { binding: badDimBinding } = await loadBoundRuntime(badDims);
    await expect(badDimBinding.embedInputs(
      [{ input_id: "dims", text: "x" }],
      { profile_id: badDimBinding.profile_id, timeoutMs: 5_000 }
    )).resolves.toEqual([{
      status: "not_embedded",
      input_id: "dims",
      input_digest: goldenInputDigest("x"),
      reason: "invalid_prepared_tokens",
      token_count: null
    }]);
    expect(badDims.modelCalls).toEqual([]);

    const badOutput = createControlledSeam({
      model: () => ({ last_hidden_state: new ControlledTensor([1, 2, 12], [[[]]]) })
    });
    const { binding: badOutputBinding } = await loadBoundRuntime(badOutput);
    const tokenCount = specialTokenCount("x");
    await expect(badOutputBinding.embedInputs(
      [{ input_id: "out", text: "x" }],
      { profile_id: badOutputBinding.profile_id, timeoutMs: 5_000 }
    )).resolves.toEqual([{
      status: "not_embedded",
      input_id: "out",
      input_digest: goldenInputDigest("x"),
      reason: "invalid_model_output",
      token_count: tokenCount
    }]);
  });

  it("refuses a mismatched profile binding without calling the model", async () => {
    const seam = createControlledSeam();
    const { binding } = await loadBoundRuntime(seam);
    const rows = await binding.embedInputs(
      [{ input_id: "raw", text: UNICODE_TEXT }],
      { profile_id: `sha256:${"b".repeat(64)}`, timeoutMs: 5_000 }
    );
    expect(seam.modelCalls).toEqual([]);
    expect(seam.tokenizerCalls).toEqual([]);
    expect(rows).toEqual([{
      status: "not_embedded",
      input_id: "raw",
      input_digest: goldenInputDigest(UNICODE_TEXT),
      reason: "profile_mismatch",
      token_count: null
    }]);
  });

  it("may lower the loaded token cap and never raises it", async () => {
    const seam = createControlledSeam();
    const { runtime } = await loadRuntime(seam);
    const lowered = runtime.bind({ window_bytes: 1024, max_input_tokens: 4 });
    const raised = runtime.bind({ window_bytes: 1024, max_input_tokens: 4096 });
    const implicit = runtime.bind({ window_bytes: 1024 });
    if (lowered.status !== "ready" || raised.status !== "ready" || implicit.status !== "ready") {
      throw new Error("controlled seam must bind");
    }
    expect(lowered.profile.max_input_tokens).toBe(4);
    expect(raised.profile.max_input_tokens).toBe(LOADED_TOKEN_CAP);
    expect(implicit.profile.max_input_tokens).toBe(LOADED_TOKEN_CAP);
    expect(raised.profile_id).toBe(implicit.profile_id);
    expect(lowered.profile_id).not.toBe(raised.profile_id);
  });

  it("captures caller inputs before the first await so later mutation cannot change digest or inference", async () => {
    const seam = createControlledSeam();
    const { binding } = await loadBoundRuntime(seam);
    const inputs = [{ input_id: "original", text: UNICODE_TEXT }];
    const callOptions = { profile_id: binding.profile_id, timeoutMs: 5_000 };
    const pending = binding.embedInputs(inputs, callOptions);
    inputs[0]!.input_id = "changed";
    inputs[0]!.text = "changed";
    inputs.push({ input_id: "extra", text: "extra" });
    callOptions.profile_id = "changed";
    const rows = await pending;
    expect(seam.tokenizerCalls[0]?.texts).toEqual([UNICODE_TEXT]);
    expect(rows).toMatchObject([{
      status: "embedded",
      input_id: "original",
      input_digest: goldenInputDigest(UNICODE_TEXT)
    }]);
    expect(preparedText(seam, seam.modelCalls[0]!)).toBe(UNICODE_TEXT);
  });

  it("disposes the pipeline only after in-flight work settles", async () => {
    let release!: (value: ReturnType<typeof hiddenOutput>) => void;
    const events: string[] = [];
    const seam = createControlledSeam({
      async model(prepared) {
        events.push("model");
        const output = await new Promise<ReturnType<typeof hiddenOutput>>((resolve) => {
          release = resolve;
        });
        events.push("model-settled");
        return output ?? hiddenOutput(prepared.attention_mask.dims[1]!);
      },
      async dispose() {
        events.push("pipeline-dispose");
      }
    });
    const { runtime, binding } = await loadBoundRuntime(seam);
    const pending = binding.embedInputs(
      [{ input_id: "inflight", text: "wait" }],
      { profile_id: binding.profile_id, timeoutMs: 5_000 }
    );
    await Promise.resolve();
    expect(events).toEqual(["model"]);
    const closing = runtime.close();
    await Promise.resolve();
    expect(events).toEqual(["model"]);
    release(hiddenOutput(specialTokenCount("wait")));
    const rows = await pending;
    await closing;
    expect(events).toEqual(["model", "model-settled", "pipeline-dispose"]);
    expect(rows).toEqual([{
      status: "not_embedded",
      input_id: "inflight",
      input_digest: goldenInputDigest("wait"),
      reason: "runtime_closed",
      token_count: specialTokenCount("wait")
    }]);
    expect(runtime.bind({ window_bytes: 1024 })).toEqual({ status: "unsupported", reason: "runtime_closed" });
    await runtime.close();
    expect(events.filter((event) => event === "pipeline-dispose")).toEqual(["pipeline-dispose"]);
  });
});

/** Controlled seam tensors: not ORT, not network, and not real encoder inference. */
class ControlledTensor {
  public constructor(
    public readonly dims: number[],
    private readonly values: unknown
  ) {}
  public tolist(): unknown {
    return this.values;
  }
  public normalize(ord: number, dim: number): this {
    if (ord !== 2 || dim !== -1) throw new Error("controlled seam expected L2 last-dim normalize");
    return this;
  }
}

interface PreparedTensors {
  readonly input_ids: ControlledTensor;
  readonly attention_mask: ControlledTensor;
}

interface ControlledSeam {
  tokenizerCalls: Array<{ texts: string[]; options: unknown }>;
  prepared: PreparedTensors[];
  modelCalls: PreparedTensors[];
  normalizeCalls: Array<{ ord: number; dim: number }>;
  pipelineOptions: unknown;
  allowRemoteModelsAtLoad: boolean | undefined;
  tokenize?: () => PreparedTensors;
  model?: (prepared: PreparedTensors) => Promise<Record<string, ControlledTensor>> | Record<string, ControlledTensor>;
  dispose?: () => Promise<void>;
}

function createControlledSeam(overrides: Partial<ControlledSeam> = {}): ControlledSeam {
  return {
    tokenizerCalls: [],
    prepared: [],
    modelCalls: [],
    normalizeCalls: [],
    pipelineOptions: undefined,
    allowRemoteModelsAtLoad: undefined,
    ...overrides
  };
}

async function loadBoundRuntime(
  seam: ControlledSeam,
  bindOptions: SourceEmbeddingBindingOptions = { window_bytes: 1024 }
) {
  const loaded = await loadRuntime(seam);
  const bindingResult = loaded.runtime.bind(bindOptions);
  if (bindingResult.status !== "ready") throw new Error("controlled seam must bind");
  return { ...loaded, binding: bindingResult, profile: bindingResult.profile };
}

async function loadRuntime(seam: ControlledSeam) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "alaya-onnx-cache-"));
  caches.push(cacheRoot);
  writeEncoderTree(cacheRoot, "fixture-encoder");
  const extractor = await loadVerifiedLocalOnnxExtractor(
    "fixture-encoder",
    cacheRoot,
    {},
    controlledTransformers(seam)
  );
  const runtime = extractor.sourceRuntime;
  if (!runtime) throw new Error("controlled seam must expose sourceRuntime");
  runtimes.push(runtime);
  return { extractor, runtime, cacheRoot };
}

function controlledTransformers(seam: ControlledSeam): LocalOnnxEmbeddingTransformersModule {
  const env = { version: "4.3.1", allowRemoteModels: true, useFSCache: true };
  const pipeline = Object.assign(async () => {
    throw new Error("legacy feature-extraction callable must not run in Source seam tests");
  }, {
    tokenizer: Object.assign((texts: string[], options: unknown) => {
      seam.tokenizerCalls.push({ texts: [...texts], options });
      const prepared = seam.tokenize?.() ?? tokenizeWithSpecials(texts[0] ?? "");
      seam.prepared.push(prepared);
      return prepared;
    }, { model_max_length: LOADED_TOKEN_CAP }),
    model: Object.assign(async (prepared: PreparedTensors) => {
      seam.modelCalls.push(prepared);
      return seam.model ? seam.model(prepared) : hiddenOutput(prepared.attention_mask.dims[1]!);
    }, { config: { hidden_size: DIMENSIONS, max_position_embeddings: LOADED_TOKEN_CAP, model_type: "bert" } }),
    dispose: async () => {
      await seam.dispose?.();
    }
  });
  return {
    env,
    mean_pooling: (hidden, mask) => {
      const dimensions = hidden.dims[2] ?? 0;
      const vector = Float32Array.from({ length: dimensions }, (_unused, index) => (mask.dims[1]! + index + 1) * 0.001);
      const pooled = new Tensor("float32", vector, [1, dimensions]);
      const normalize = pooled.normalize.bind(pooled);
      pooled.normalize = (ord, dim) => {
        if (ord !== 2 || dim !== -1) throw new Error("controlled seam expected L2 last-dim normalize");
        seam.normalizeCalls.push({ ord, dim });
        return normalize(ord, dim);
      };
      return pooled;
    },
    pipeline: async (_task, _model, options) => {
      seam.pipelineOptions = options;
      seam.allowRemoteModelsAtLoad = env.allowRemoteModels;
      return pipeline as unknown as LocalOnnxFeatureExtractor;
    }
  };
}

function tokenizeWithSpecials(text: string): PreparedTensors {
  const ids = [CLS, ...[...text].map((_char, index) => 1000 + index), SEP];
  const mask = ids.map(() => 1);
  return {
    input_ids: new ControlledTensor([1, ids.length], [ids]),
    attention_mask: new ControlledTensor([1, mask.length], [mask])
  };
}

function hiddenOutput(tokenCount: number): Record<string, ControlledTensor> {
  return {
    last_hidden_state: new ControlledTensor(
      [1, tokenCount, DIMENSIONS],
      [Array.from({ length: tokenCount }, () => Array.from({ length: DIMENSIONS }, () => 0.1))]
    )
  };
}

function specialTokenCount(text: string): number {
  return [...text].length + 2;
}

function preparedText(seam: ControlledSeam, prepared: PreparedTensors): string | undefined {
  const index = seam.prepared.indexOf(prepared);
  return index >= 0 ? seam.tokenizerCalls[index]?.texts[0] : undefined;
}

function goldenInputDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function writeEncoderTree(cacheRoot: string, modelId: string): void {
  const modelRoot = join(cacheRoot, modelId);
  mkdirSync(join(modelRoot, "onnx"), { recursive: true });
  writeFileSync(join(modelRoot, "onnx/model_quantized.onnx"), selfContainedOnnx());
  writeFileSync(join(modelRoot, "config.json"), JSON.stringify({ hidden_size: 384, model_type: "bert" }));
  writeFileSync(join(modelRoot, "tokenizer_config.json"), "{}");
  writeFileSync(join(modelRoot, "tokenizer.json"), "{}");
  writeFileSync(join(modelRoot, "special_tokens_map.json"), "{}");
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function selfContainedOnnx(): Buffer {
  return Buffer.concat([
    encodeVarint((7 << 3) | 2),
    encodeVarint(0)
  ]);
}
