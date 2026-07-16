import { describe, expect, it, vi } from "vitest";
import { buildMemorySearchRecallPolicy } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo
} from "@do-soul/alaya-storage";
import { createDaemonEmbeddingRuntime } from "../../ai/daemon-embedding-runtime.js";
import { readEmbeddingRuntimeConfig } from "../../ai/daemon-embedding-runtime-config.js";

function createRuntime(
  configEnv: ReadonlyMap<string, string>,
  embedTexts: () => Promise<readonly Float32Array[]> = async () => [new Float32Array([1])],
  providerOverride: Parameters<typeof createDaemonEmbeddingRuntime>[0]["embeddingProviderOverride"] = {
    providerKind: "local_onnx",
    modelId: "local/model",
    schemaVersion: 1,
    isAvailable: true,
    embedTexts
  }
) {
  const database = initDatabase({ filename: ":memory:" });
  const runtime = createDaemonEmbeddingRuntime({
    database,
    configEnv,
    eventLogRepo: new SqliteEventLogRepo(database),
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    healthJournalService: {
      getRecentEvents: vi.fn(async () => Object.freeze([])),
      record: vi.fn(async () => undefined)
    },
    warn: vi.fn(),
    embeddingProviderOverride: providerOverride
  });
  return { database, runtime };
}

function sharedProductPolicy() {
  return buildMemorySearchRecallPolicy({
    runtimeId: "runtime-product",
    taskSurfaceId: "surface-product",
    maxResults: 10,
    filters: {
      scopeFilter: null,
      dimensionFilter: null,
      domainTagFilter: null
    }
  });
}

function effectiveSharedProductPolicy(
  runtime: ReturnType<typeof createDaemonEmbeddingRuntime>
): ReturnType<typeof sharedProductPolicy> {
  const policy = sharedProductPolicy();
  return runtime.defaultPolicyDecorator?.(policy) ?? policy;
}

function isPolicyEnabled(runtime: ReturnType<typeof createDaemonEmbeddingRuntime>): boolean {
  return effectiveSharedProductPolicy(runtime)
    .coarse_filter.semantic_supplement.embedding_enabled === true;
}

describe("daemon local embedding product default", () => {
  it.each([undefined, "true", "  TrUe  ", "1", " 1 "])(
    "enables the local provider after verified warmup for %s",
    async (configuredValue) => {
      const config = new Map<string, string>([["ALAYA_EMBEDDING_PROVIDER", "local_onnx"]]);
      if (configuredValue !== undefined) {
        config.set("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", configuredValue);
      }
      const { database, runtime } = createRuntime(config);
      try {
        await expect(runtime.providerWarmup).resolves.toBe("ready");
        expect(isPolicyEnabled(runtime)).toBe(true);
      } finally {
        database.close();
      }
    }
  );

  it.each(["false", "  FaLsE  ", "0", " 0 "])(
    "honors the explicit local opt-out %s",
    async (configuredValue) => {
      const embedTexts = vi.fn(async () => [new Float32Array([1])]);
      const { database, runtime } = createRuntime(new Map([
        ["ALAYA_EMBEDDING_PROVIDER", "local_onnx"],
        ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", configuredValue]
      ]), embedTexts);
      try {
        await expect(runtime.providerWarmup).resolves.toBe("not_requested");
        expect(isPolicyEnabled(runtime)).toBe(false);
        expect(embedTexts).not.toHaveBeenCalled();
      } finally {
        database.close();
      }
    }
  );

  it("rejects an invalid embedding boolean instead of silently changing posture", () => {
    expect(() => createRuntime(new Map([
      ["ALAYA_EMBEDDING_PROVIDER", "local_onnx"],
      ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "yes"]
    ]))).toThrow(/ALAYA_ENABLE_EMBEDDING_SUPPLEMENT/);
  });

  it.each([
    ["ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK", "yes"],
    ["ALAYA_RECALL_D2Q", "enabled"]
  ])("rejects invalid %s boolean configuration", (name, value) => {
    expect(() => createRuntime(new Map([[name, value]]))).toThrow(new RegExp(name));
  });

  it.each([
    ["ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK", "  TrUe  ", "localAnswerRerankEnabled", true],
    ["ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK", "0", "localAnswerRerankEnabled", false],
    ["ALAYA_RECALL_D2Q", "1", "d2qEnabled", true],
    ["ALAYA_RECALL_D2Q", "  FaLsE  ", "d2qEnabled", false]
  ] as const)("parses strict %s=%s", (name, value, field, expected) => {
    const config = readEmbeddingRuntimeConfig(new Map([[name, value]]), vi.fn());
    expect(config[field]).toBe(expected);
  });

  it("rejects an invalid explicit provider instead of silently selecting local", () => {
    expect(() => createRuntime(new Map([
      ["ALAYA_EMBEDDING_PROVIDER", "open_ai"]
    ]))).toThrow(/ALAYA_EMBEDDING_PROVIDER/);
  });

  it("does not infer OpenAI from legacy model and secret settings", async () => {
    const previousSecret = process.env.ALAYA_TEST_LEGACY_EMBEDDING_KEY;
    process.env.ALAYA_TEST_LEGACY_EMBEDDING_KEY = "unused-test-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("API must not be called"));
    const database = initDatabase({ filename: ":memory:" });
    try {
      const runtime = createDaemonEmbeddingRuntime({
        database,
        configEnv: new Map([
          ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"],
          ["ALAYA_OPENAI_SECRET_REF", "env:ALAYA_TEST_LEGACY_EMBEDDING_KEY"],
          ["OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"],
          ["ALAYA_LOCAL_EMBEDDING_CACHE_DIR", "/nonexistent/alaya-test-model-cache"]
        ]),
        eventLogRepo: new SqliteEventLogRepo(database),
        memoryEntryRepo: new SqliteMemoryEntryRepo(database),
        healthJournalService: {
          getRecentEvents: vi.fn(async () => Object.freeze([])),
          record: vi.fn(async () => undefined)
        },
        warn: vi.fn()
      });

      await runtime.providerWarmup;
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(runtime.embeddingStatusService.getStatus("workspace-1")).resolves.toMatchObject({
        model_id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
      });
    } finally {
      database.close();
      fetchSpy.mockRestore();
      if (previousSecret === undefined) delete process.env.ALAYA_TEST_LEGACY_EMBEDDING_KEY;
      else process.env.ALAYA_TEST_LEGACY_EMBEDDING_KEY = previousSecret;
    }
  });

  it("keeps an explicitly selected API provider off unless the operator enables it", async () => {
    const disabledEmbedTexts = vi.fn(async () => [new Float32Array([1])]);
    const disabled = createRuntime(
      new Map([["ALAYA_EMBEDDING_PROVIDER", "openai"]]),
      disabledEmbedTexts
    );
    const enabled = createRuntime(new Map([
      ["ALAYA_EMBEDDING_PROVIDER", "openai"],
      ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "1"]
    ]));
    try {
      await expect(disabled.runtime.providerWarmup).resolves.toBe("not_requested");
      await expect(enabled.runtime.providerWarmup).resolves.toBe("ready");
      expect(isPolicyEnabled(disabled.runtime)).toBe(false);
      expect(isPolicyEnabled(enabled.runtime)).toBe(true);
      expect(disabledEmbedTexts).not.toHaveBeenCalled();
    } finally {
      disabled.database.close();
      enabled.database.close();
    }
  });

  it("keeps policy and status degraded when the local warmup cannot load its artifact", async () => {
    const { database, runtime } = createRuntime(new Map(), async () => {
      throw new Error("model artifact missing");
    });
    try {
      await expect(runtime.providerWarmup).resolves.toBe("failed");
      expect(isPolicyEnabled(runtime)).toBe(false);
      await expect(runtime.embeddingStatusService.getStatus("workspace-1")).resolves.toMatchObject({
        effective_mode: "degraded",
        degraded_reason: "provider_warmup_failed"
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ["zero", new Float32Array([0])],
    ["NaN", new Float32Array([Number.NaN])]
  ])("keeps policy degraded when warmup returns a %s vector", async (_label, vector) => {
    const { database, runtime } = createRuntime(new Map(), async () => [vector]);
    try {
      await expect(runtime.providerWarmup).resolves.toBe("failed");
      expect(isPolicyEnabled(runtime)).toBe(false);
    } finally {
      database.close();
    }
  });

  it("recovers policy and status after a later provider use succeeds", async () => {
    let attempts = 0;
    const { database, runtime } = createRuntime(new Map(), async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient startup failure");
      return [new Float32Array([1])];
    });
    try {
      await expect(runtime.providerWarmup).resolves.toBe("failed");
      expect(isPolicyEnabled(runtime)).toBe(false);

      await runtime.embeddingRecallService!.warmQueryEmbeddings({
        workspaceId: "workspace-1",
        runId: null,
        queryTexts: ["recovery probe"]
      });

      expect(isPolicyEnabled(runtime)).toBe(true);
      await expect(runtime.embeddingStatusService.getStatus("workspace-1")).resolves.toMatchObject({
        effective_mode: "embedding_supplement",
        degraded_reason: null
      });
    } finally {
      database.close();
    }
  });

  it("does not let a stale warmup failure overwrite a later successful use", async () => {
    let attempts = 0;
    let rejectWarmup: (error: Error) => void = () => undefined;
    let markWarmupStarted: () => void = () => undefined;
    const warmupStarted = new Promise<void>((resolve) => { markWarmupStarted = resolve; });
    const { database, runtime } = createRuntime(new Map(), async () => {
      attempts += 1;
      if (attempts > 1) return [new Float32Array([1])];
      markWarmupStarted();
      return await new Promise<readonly Float32Array[]>((_, reject) => {
        rejectWarmup = reject;
      });
    });
    try {
      await warmupStarted;
      await runtime.embeddingRecallService!.warmQueryEmbeddings({
        workspaceId: "workspace-1",
        runId: null,
        queryTexts: ["concurrent recovery"]
      });
      rejectWarmup(new Error("stale startup failure"));

      await expect(runtime.providerWarmup).resolves.toBe("failed");
      expect(isPolicyEnabled(runtime)).toBe(true);
      await expect(runtime.embeddingStatusService.getStatus("workspace-1")).resolves.toMatchObject({
        effective_mode: "embedding_supplement",
        degraded_reason: null
      });
    } finally {
      database.close();
    }
  });

  it("does not enable policy before the startup probe has verified the provider", async () => {
    let resolveWarmup: (value: readonly Float32Array[]) => void = () => undefined;
    const { database, runtime } = createRuntime(
      new Map(),
      () => new Promise((resolve) => { resolveWarmup = resolve; })
    );
    try {
      expect(isPolicyEnabled(runtime)).toBe(false);
      expect(runtime.getWarmupHoldReason()).toBe("provider_warmup_pending");
      await expect(runtime.embeddingStatusService.getStatus("workspace-1")).resolves.toMatchObject({
        effective_mode: "degraded",
        degraded_reason: "provider_warmup_pending"
      });

      resolveWarmup([new Float32Array([1])]);
      await expect(runtime.providerWarmup).resolves.toBe("ready");
      expect(isPolicyEnabled(runtime)).toBe(true);
      expect(runtime.getWarmupHoldReason()).toBeNull();
    } finally {
      database.close();
    }
  });

  it("keeps the shared product policy lexical-only when provider and service are absent", async () => {
    const embedTexts = vi.fn(async () => [new Float32Array([1])]);
    const { database, runtime } = createRuntime(new Map(), embedTexts, null);
    try {
      await expect(runtime.providerWarmup).resolves.toBe("not_requested");
      expect(runtime.defaultPolicyDecorator).toBeUndefined();
      expect(effectiveSharedProductPolicy(runtime).coarse_filter.semantic_supplement)
        .toMatchObject({ enabled: true, embedding_enabled: false });
      expect(embedTexts).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("forces the shared product policy to lexical-only while warmup is pending", async () => {
    let resolveWarmup: (value: readonly Float32Array[]) => void = () => undefined;
    let markWarmupStarted: () => void = () => undefined;
    const warmupStarted = new Promise<void>((resolve) => { markWarmupStarted = resolve; });
    const { database, runtime } = createRuntime(
      new Map(),
      () => new Promise((resolve) => {
        resolveWarmup = resolve;
        markWarmupStarted();
      })
    );
    try {
      await warmupStarted;
      const pending = effectiveSharedProductPolicy(runtime);
      expect(pending.coarse_filter.semantic_supplement.embedding_enabled).toBe(false);
      expect(pending.fine_assessment.max_candidates).toBe(200);

      resolveWarmup([new Float32Array([1])]);
      await expect(runtime.providerWarmup).resolves.toBe("ready");
    } finally {
      database.close();
    }
  });

  it("forces the shared product policy to lexical-only after warmup fails", async () => {
    const { database, runtime } = createRuntime(new Map(), async () => {
      throw new Error("warmup failed");
    });
    try {
      await expect(runtime.providerWarmup).resolves.toBe("failed");
      const failed = effectiveSharedProductPolicy(runtime);
      expect(failed.coarse_filter.semantic_supplement.embedding_enabled).toBe(false);
      expect(failed.fine_assessment.max_candidates).toBe(200);
    } finally {
      database.close();
    }
  });

  it("atomically adds the default injection budget only after warmup is ready", async () => {
    const { database, runtime } = createRuntime(new Map());
    try {
      await expect(runtime.providerWarmup).resolves.toBe("ready");
      const ready = effectiveSharedProductPolicy(runtime);
      expect(ready.coarse_filter.semantic_supplement).toMatchObject({
        embedding_enabled: true,
        injection_cap: 10,
        injection_similarity_floor: 0.5
      });
      expect(ready.fine_assessment.max_candidates).toBe(210);
      expect(runtime.defaultPolicyDecorator!(ready).fine_assessment.max_candidates).toBe(210);
    } finally {
      database.close();
    }
  });
});
