import { afterAll, expect, it, vi } from "vitest";
import type { SourceEmbeddingResult } from "../../embedding-recall/source-embedding-runtime.js";

type GuardReport = {
  phase: string; pid: number; preload_specifier: string; exec_argv?: string[];
  configured_child_exec_argv?: string[]; credential_environment_count: number;
  transport_guards: string[]; violations: string[]; local_responses: number;
  observed_application_replies?: number;
};
type OfflineIsolation = {
  children: { pid: number; script: string; preload: string; exited: boolean; code: number | null; signal: string | null }[];
  childReports: GuardReport[];
  requests: { op: string; inputs: number }[];
  snapshot(): GuardReport;
  restore(): void;
};

const offline = await vi.hoisted(async () => {
  const { existsSync } = await import("node:fs");
  const { isAbsolute, join } = await import("node:path");
  const cacheDir = process.env.ALAYA_LOCAL_SOURCE_EMBEDDING_CACHE_DIR;
  let skipReason: string | null = null;
  if (process.env.ALAYA_LOCAL_SOURCE_EMBEDDING_OFFLINE !== "1") {
    skipReason = "requires ALAYA_LOCAL_SOURCE_EMBEDDING_OFFLINE=1 (explicit local inference authorization)";
  } else if (!cacheDir) {
    skipReason = "requires explicit ALAYA_LOCAL_SOURCE_EMBEDDING_CACHE_DIR; no implicit cache or download";
  } else if (!isAbsolute(cacheDir)) {
    throw new Error("Offline Source embedding requires an absolute explicit cache directory");
  } else if (!["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"]
    .every(file => existsSync(join(cacheDir, "Xenova/paraphrase-multilingual-MiniLM-L12-v2", file)))) {
    skipReason = "explicit local cache is unavailable/incomplete; no download or alternate cache allowed";
  }
  if (skipReason !== null) {
    console.info(`[local-source-embedding-offline] SKIPPED: ${skipReason}`);
    return { cacheDir, isolation: null as OfflineIsolation | null };
  }
  if (!process.features.typescript) {
    throw new Error("Cannot bind early child guard: Node native TypeScript loading is unavailable");
  }
  const preload = new URL("./local-onnx-source-embedding-offline-preload.mjs", import.meta.url).href;
  const { isolation } = await import(/* @vite-ignore */ preload);
  return { cacheDir, isolation: isolation as OfflineIsolation };
});

afterAll(() => offline.isolation?.restore());

function assertGuard(isolation: OfflineIsolation): void {
  const parent = isolation.snapshot();
  expect(parent.preload_specifier).toBe(isolation.children[0]!.preload);
  expect(parent.configured_child_exec_argv).toEqual(["--import", isolation.children[0]!.preload]);
  expect(parent.credential_environment_count).toBe(0);
  expect(parent.violations).toEqual([]);
  expect(isolation.children).toHaveLength(1);
  expect(isolation.children[0]!.exited).toBe(true);
  const established = isolation.childReports.find(report => report.phase === "installed");
  expect(established, "actual child must acknowledge preload before its entry imports").toBeDefined();
  expect(isolation.childReports[0]?.phase).toBe("installed");
  for (const report of isolation.childReports) {
    const argv = report.exec_argv ?? [];
    expect(report.pid).toBe(isolation.children[0]!.pid);
    expect(report.preload_specifier).toBe(isolation.children[0]!.preload);
    expect(argv.includes("--import")).toBe(true);
    expect(argv[argv.indexOf("--import") + 1]).toBe(report.preload_specifier);
    expect(report.credential_environment_count).toBe(0);
    expect(report.transport_guards).toEqual(parent.transport_guards);
    expect(report.violations).toEqual([]);
  }
  expect(isolation.childReports.at(-1)?.phase).toBe("application_response");
}

function assertVector(result: SourceEmbeddingResult): asserts result is Extract<SourceEmbeddingResult, { status: "embedded" }> {
  expect(result.status, `actual inference result for ${result.input_id}`).toBe("embedded");
  if (result.status !== "embedded") throw new Error(`Actual local inference refused: ${result.reason}`);
  expect(result.truncated).toBe(false);
  expect(result.vector).toBeInstanceOf(Float32Array);
  expect(result.vector.length).toBe(384);
  expect(result.vector.every(Number.isFinite)).toBe(true);
  const norm = Math.sqrt(result.vector.reduce((sum, value) => sum + value * value, 0));
  expect(norm).toBeGreaterThan(0);
  expect(Math.abs(norm - 1)).toBeLessThan(1e-5);
  expect(result.token_count).toBeGreaterThan(0);
}

// One opt-in test: four short native inference inputs, one authored 512-token
// ceiling inference including special tokens, one over-limit tokenize.
// No model/provider seam, IPC host override, retry, benchmark, or natural query.
it.skipIf(offline.isolation === null)("binds the cached native Source/query profile through the guarded production child", {
  timeout: 240_000, retry: 0
}, async () => {
  const isolation = offline.isolation!;
  // All application imports occur after both the credential and network guard.
  const { LocalOnnxEmbeddingClient } = await import("../../embedding-recall/local-onnx-embedding-client.js");
  const { sourceIndexProfileId } = await import("@do-soul/alaya-protocol");
  const { createHash } = await import("node:crypto");
  const { createRequire } = await import("node:module");
  const { readFile } = await import("node:fs/promises");
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const digest = (text: string) => `sha256:${sha256(text)}`;
  const require = createRequire(import.meta.url);
  const transformersRequire = createRequire(require.resolve("@huggingface/transformers"));
  const ort = JSON.parse(await readFile(transformersRequire.resolve("onnxruntime-node/package.json"), "utf8")) as { version: string };
  const client = new LocalOnnxEmbeddingClient({ cacheDir: offline.cacheDir! });
  try {
    expect(client.providerKind).toBe("local_onnx");
    expect(client.modelId).toBe("Xenova/paraphrase-multilingual-MiniLM-L12-v2");
    const binding = await client.bindSourceEmbedding({ window_bytes: 256 });
    expect(binding.status, "opaque/vector-only backends must not substitute for loaded tokenizer evidence").toBe("ready");
    if (binding.status !== "ready") throw new Error(`Actual Source binding unavailable: ${binding.reason}`);
    const expectedProfile = {
      provider_kind: "local_onnx", model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      model_revision: "sha256:66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
      artifact_digest: "sha256:236cd2f6944b5e0a69f28f2fbe107e451c18e8139b253a3334737bd811f62436",
      tokenizer_revision: "sha256:236cd2f6944b5e0a69f28f2fbe107e451c18e8139b253a3334737bd811f62436",
      dimensions: 384, preprocessing: `raw-string.special-tokens.no-truncation.v1;transformers-4.3.1.ort-${ort.version}.cpu`,
      normalization: "attention-mask-mean.l2.q8.v1", max_input_tokens: 512,
      windowing: "utf8-byte-windows.v1" as const, window_bytes: 256
    };
    console.info("[local-source-embedding-offline] loaded", JSON.stringify({ profile_id: binding.profile_id, profile: binding.profile }));
    expect(binding.profile).toEqual(expectedProfile);
    expect(binding.profile_id).toBe(sourceIndexProfileId(expectedProfile, sha256));
    expect(isolation.childReports.some(report => report.phase === "installed")).toBe(true);

    const texts = ["Small blue stone.", "\t石  café\r\n  λ\u00a0leaf "];
    const options = { timeoutMs: 120_000, profile_id: binding.profile_id };
    const source = await binding.embedInputs(texts.map((text, index) => ({ input_id: `source-${index}`, text })), options);
    console.info("[local-source-embedding-offline] source", JSON.stringify(source.map(result => ({
      input_id: result.input_id, input_digest: result.input_digest, status: result.status,
      token_count: result.token_count, dimensions: result.status === "embedded" ? result.vector.length : null
    }))));
    expect(source).toHaveLength(2);
    for (const [index, result] of source.entries()) {
      expect(result.input_digest).toBe(digest(texts[index]!));
      assertVector(result);
      expect(result.token_count).toBeLessThanOrEqual(binding.profile.max_input_tokens);
    }
    // Query and Source deliberately use the very same bound raw-string profile,
    // not legacy embedTexts (which cannot attest no truncation/tokenizer identity).
    const query = await binding.embedInputs(texts.map((text, index) => ({ input_id: `query-${index}`, text })), options);
    expect(query).toHaveLength(2);
    for (const [index, result] of query.entries()) {
      assertVector(result);
      const stored = source[index]!;
      assertVector(stored);
      expect(result.input_digest).toBe(digest(texts[index]!));
      expect(result.token_count).toBe(stored.token_count);
      const maxDelta = result.vector.reduce((max, value, dimension) => Math.max(max, Math.abs(value - stored.vector[dimension]!)), 0);
      expect(maxDelta).toBeLessThanOrEqual(1e-6);
      console.info("[local-source-embedding-offline] query", JSON.stringify({
        input_id: result.input_id, input_digest: result.input_digest, token_count: result.token_count,
        dimensions: result.vector.length, source_query_max_delta: maxDelta, tolerance: 1e-6
      }));
    }
    // Authored 510 copies of "a " is not itself a token count. Special tokens are
    // included in the bound ceiling; only returned evidence may prove token_count=512.
    const ceilingText = "a ".repeat(510);
    const ceiling = await binding.embedInputs([{ input_id: "ceiling-512", text: ceilingText }], options);
    console.info("[local-source-embedding-offline] ceiling-512", JSON.stringify(ceiling.map(result => ({
      input_id: result.input_id, input_digest: result.input_digest, status: result.status,
      token_count: result.token_count, dimensions: result.status === "embedded" ? result.vector.length : null
    }))));
    expect(ceiling).toHaveLength(1);
    expect(ceiling[0]!.input_digest).toBe(digest(ceilingText));
    assertVector(ceiling[0]!);
    expect(ceiling[0]!.token_count).toBe(512);
    expect(ceiling[0]!.token_count).toBe(binding.profile.max_input_tokens);
    const overLimit = "a ".repeat(binding.profile.max_input_tokens + 1);
    const refused = await binding.embedInputs([{ input_id: "over-limit", text: overLimit }], options);
    console.info("[local-source-embedding-offline] over-limit", JSON.stringify(refused));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toEqual({ input_id: "over-limit", input_digest: digest(overLimit),
      status: "not_embedded", reason: "input_token_limit", token_count: expect.any(Number) });
    expect(refused[0]!.token_count).toBeGreaterThan(binding.profile.max_input_tokens);
    expect(refused[0]).not.toHaveProperty("vector");
    expect(isolation.requests).toEqual([
      { op: "warmup", inputs: 0 }, { op: "bind_source", inputs: 0 },
      { op: "embed_source", inputs: 2 }, { op: "embed_source", inputs: 2 },
      { op: "embed_source", inputs: 1 }, { op: "embed_source", inputs: 1 }
    ]);
    // This observes refusal, not a native model-call counter. The separate
    // controlled-seam test owns the zero-model-call proof for over-limit input.
  } finally {
    await client.close();
    console.info("[local-source-embedding-offline] guards", JSON.stringify({
      parent: isolation.snapshot(), children: isolation.children, child_checkpoints: isolation.childReports,
      ipc_requests: isolation.requests, short_inference_inputs_limit: 4,
      ceiling_512_inference_inputs_limit: 1, over_limit_tokenize_inputs_limit: 1,
      native_model_call_count: "not instrumented", graph_512_token_inference: "tested"
    }));
    assertGuard(isolation);
  }
});
