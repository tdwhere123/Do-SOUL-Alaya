import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EmbeddingProviderPort, SourceEmbeddingBinding, SourceEmbeddingResult } from "@do-soul/alaya-core";

const localConstructor = vi.hoisted(() => vi.fn());
vi.mock("@do-soul/alaya-core", async importOriginal => ({
  ...await importOriginal<typeof import("@do-soul/alaya-core")>(),
  LocalOnnxEmbeddingClient: localConstructor
}));
// This suite exercises construction/readiness only: no SQLite, daemon, worker, or model.
vi.mock("../../runtime/index.js", () => ({
  DEFAULT_OPENAI_EMBEDDING_MODEL: "fixture-openai-model",
  createOptionalMemoryEmbeddingRepo: () => null,
  createOptionalEvidenceRecallEmbeddingRepo: () => null,
  createOptionalMemoryHqRepo: () => null
}));
import { createDaemonEmbeddingRuntime, type EmbeddingStartupProbe } from "../../ai/daemon-embedding-runtime.js";

type RuntimeInput = Parameters<typeof createDaemonEmbeddingRuntime>[0];
const profile: SourceEmbeddingBinding["profile"] = {
  provider_kind: "local_onnx", model_id: "fixture-local-model", model_revision: "fixture-v1",
  artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "fixture-v1", dimensions: 2,
  preprocessing: "exact-utf8", normalization: "none", max_input_tokens: 512,
  windowing: "utf8-byte-windows.v1", window_bytes: 504
};
const input = [{ input_id: "source", text: "A blue stone." }];
const options = { profile_id: "fixture-profile", timeoutMs: 1000 };

beforeEach(() => {
  for (const key of ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "ALAYA_EMBEDDING_PROVIDER",
    "ALAYA_LOCAL_EMBEDDING_CACHE_DIR", "ALAYA_LOCAL_EMBEDDING_MODEL", "ALAYA_RECALL_D2Q"]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

function fixture(embeddingStartupProbe?: EmbeddingStartupProbe, enabled = true, probeFailure?: Error) {
  const embedTexts = vi.fn(async (texts: readonly string[]) => {
    if (probeFailure !== undefined) throw probeFailure;
    return texts.map(() => new Float32Array([0.6, 0.8]));
  });
  const embedInputs = vi.fn<SourceEmbeddingBinding["embedInputs"]>(async inputs => inputs.map(row => ({
    status: "embedded", input_id: row.input_id, input_digest: `sha256:${"b".repeat(64)}`,
    token_count: 4, truncated: false, vector: new Float32Array([0.6, 0.8])
  })));
  const binding: SourceEmbeddingBinding = { status: "ready", profile, profile_id: options.profile_id, embedInputs };
  const bindSourceEmbedding = vi.fn<NonNullable<EmbeddingProviderPort["bindSourceEmbedding"]>>(async () => binding);
  const close = vi.fn(async () => undefined);
  const provider: EmbeddingProviderPort = { providerKind: "local_onnx", modelId: profile.model_id,
    schemaVersion: 1, isAvailable: true, embedTexts, bindSourceEmbedding, close };
  localConstructor.mockImplementation(function () { return provider; });
  const runtime = createDaemonEmbeddingRuntime({
    database: {} as RuntimeInput["database"], eventLogRepo: {} as RuntimeInput["eventLogRepo"],
    memoryEntryRepo: {} as RuntimeInput["memoryEntryRepo"], embeddingStartupProbe,
    configEnv: new Map([["ALAYA_EMBEDDING_PROVIDER", "local_onnx"],
      ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", String(enabled)]]),
    localOnnxTransformersProbe: () => ({ availability: "available" }),
    runtimeNotifier: { notifyEntry: () => undefined },
    healthJournalService: { getRecentEvents: async () => [], record: async () => undefined }, warn: vi.fn()
  });
  return { runtime, embedTexts, embedInputs, bindSourceEmbedding, close };
}

it.each([undefined, "eager"] as const)("preserves the ordinary startup probe for %s", async mode => {
  const f = fixture(mode);
  try {
    await expect(f.runtime.providerWarmup).resolves.toBe("ready");
    expect(localConstructor).toHaveBeenCalledTimes(1);
    expect(f.embedTexts).toHaveBeenCalledExactlyOnceWith(["alaya-init-probe"], { timeoutMs: 60_000 });
    expect(f.runtime.getProviderDimensions()).toBe(2);
    expect(f.runtime.getWarmupHoldReason()).toBeNull();
  } finally { await f.runtime.closeProvider(); }
  expect(f.close).toHaveBeenCalledTimes(1);
});

it.each([undefined, "eager", "omit"] as const)("keeps a disabled provider absent for %s", async mode => {
  const f = fixture(mode, false);
  await expect(f.runtime.providerWarmup).resolves.toBe("not_requested");
  expect(localConstructor).not.toHaveBeenCalled();
  expect(f.embedTexts).not.toHaveBeenCalled();
  expect(f.runtime.getProviderDimensions()).toBeNull();
  await expect(f.runtime.bindLocalSourceIndex({ window_bytes: 504 })).resolves.toEqual({
    status: "unsupported", reason: "embedding_provider_unavailable"
  });
  await f.runtime.closeProvider();
  expect(f.close).not.toHaveBeenCalled();
});

it("omits only the startup effect and establishes readiness from validated Source vectors", async () => {
  const f = fixture("omit");
  try {
    await expect(f.runtime.providerWarmup).resolves.toBe("not_requested");
    expect(localConstructor).toHaveBeenCalledTimes(1);
    expect(f.embedTexts).not.toHaveBeenCalled();
    expect(f.runtime.getProviderDimensions()).toBeNull();
    expect(f.runtime.getWarmupHoldReason()).toBe("provider_warmup_pending");
    await expect(f.runtime.embeddingStatusService.getStatus("workspace")).resolves.toMatchObject({ provider_configured: true });
    const binding = await f.runtime.bindLocalSourceIndex({ window_bytes: 504 });
    if (binding.status !== "ready") throw new Error("Fixture did not bind");
    expect(f.bindSourceEmbedding).toHaveBeenCalledExactlyOnceWith({ window_bytes: 504 });
    expect(f.runtime.getProviderDimensions()).toBeNull();
    expect(f.runtime.getWarmupHoldReason()).toBe("provider_warmup_pending");
    await expect(binding.embedInputs([], options)).resolves.toEqual([]);
    f.embedInputs.mockResolvedValueOnce([{ status: "not_embedded", input_id: "source",
      input_digest: `sha256:${"b".repeat(64)}`, reason: "fixture_refused", token_count: null }]);
    await expect(binding.embedInputs(input, options)).resolves.toMatchObject([{ status: "not_embedded" }]);
    expect(f.runtime.getProviderDimensions()).toBeNull();
    expect(f.runtime.getWarmupHoldReason()).toBe("provider_warmup_pending");
    await expect(binding.embedInputs(input, options)).resolves.toMatchObject([{ status: "embedded" }]);
    expect(f.runtime.getProviderDimensions()).toBe(2);
    expect(f.runtime.getWarmupHoldReason()).toBeNull();
    // Source readiness does not retroactively claim that an ordinary startup probe ran.
    await expect(f.runtime.providerWarmup).resolves.toBe("not_requested");
    expect(f.embedTexts).not.toHaveBeenCalled();
  } finally { await f.runtime.closeProvider(); }
  expect(f.close).toHaveBeenCalledTimes(1);
});

it.each([new Float32Array([NaN, 0]), new Float32Array([0, 0]), new Float32Array([1, 0, 0])])(
  "does not establish omitted-probe readiness from malformed Source vector %s", async vector => {
    const f = fixture("omit");
    try {
      const binding = await f.runtime.bindSourceEmbedding({ window_bytes: 504 });
      if (binding.status !== "ready") throw new Error("Fixture did not bind");
      f.embedInputs.mockResolvedValueOnce([{ status: "embedded", input_id: "source",
        input_digest: `sha256:${"b".repeat(64)}`, token_count: 4, truncated: false, vector }] satisfies SourceEmbeddingResult[]);
      await expect(binding.embedInputs(input, options)).rejects.toThrow(/finite|dimensions/u);
      expect(f.runtime.getProviderDimensions()).toBeNull();
      expect(f.runtime.getWarmupHoldReason()).toBe("provider_warmup_pending");
      expect(f.embedTexts).not.toHaveBeenCalled();
    } finally { await f.runtime.closeProvider(); }
    expect(f.close).toHaveBeenCalledTimes(1);
  }
);

it("keeps unsupported binding pending without probing and still closes the provider", async () => {
  const f = fixture("omit");
  f.bindSourceEmbedding.mockResolvedValue({ status: "unsupported", reason: "fixture_unsupported" });
  await expect(f.runtime.bindSourceEmbedding({ window_bytes: 504 })).resolves.toMatchObject({ status: "unsupported" });
  expect(f.runtime.getProviderDimensions()).toBeNull();
  expect(f.runtime.getWarmupHoldReason()).toBe("provider_warmup_pending");
  expect(f.embedTexts).not.toHaveBeenCalled();
  await f.runtime.closeProvider();
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("retains provider close after an eager startup-probe failure", async () => {
  const f = fixture("eager", true, new Error("fixture_probe_failed"));
  await expect(f.runtime.providerWarmup).resolves.toBe("failed");
  expect(f.embedTexts).toHaveBeenCalledTimes(1);
  expect(f.runtime.getProviderDimensions()).toBeNull();
  expect(f.runtime.getWarmupHoldReason()).toBe("provider_warmup_failed");
  await f.runtime.closeProvider();
  expect(f.close).toHaveBeenCalledTimes(1);
});
