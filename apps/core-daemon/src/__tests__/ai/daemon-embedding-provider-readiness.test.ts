import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { createHash } from "node:crypto";
import * as core from "@do-soul/alaya-core";
import { initDatabase, SqliteEventLogRepo, SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { createDaemonEmbeddingRuntime } from "../../ai/daemon-embedding-runtime.js";
import {
  EmbeddingBackfillHandler,
  type EmbeddingProviderPort,
  type EmbeddingVectorRecord
} from "@do-soul/alaya-core";
import {
  MemoryDimension,
  ScopeClass,
  StorageTier,
  sourceIndexProfileId,
  type SourceIndexProfile,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  createEmbeddingProviderReadiness,
  observeEmbeddingProviderReadiness
} from "../../ai/daemon-embedding-provider-readiness.js";

describe("embedding provider dimensional readiness", () => {
  it("rejects a later response from a different vector space", async () => {
    let call = 0;
    const provider = createProvider(async (texts) => {
      if (texts.length === 0) return [];
      call += 1;
      const dimensions = call === 1 ? 2 : 3;
      return texts.map(() => unitVector(dimensions));
    });
    const readiness = createEmbeddingProviderReadiness(provider);
    const observed = observeEmbeddingProviderReadiness(provider, readiness)!;

    expect(readiness.dimensions).toBeNull();
    await expect(observed.embedTexts([], { timeoutMs: 1_000 })).resolves.toEqual([]);
    expect(readiness.status).toBe("pending");
    await expect(observed.embedTexts(["first"], { timeoutMs: 1_000 }))
      .resolves.toHaveLength(1);
    expect(readiness.dimensions).toBe(2);
    await expect(observed.embedTexts(["second"], { timeoutMs: 1_000 }))
      .rejects.toThrow(/dimensions/u);
    expect(readiness.status).toBe("ready");
    expect(readiness.dimensions).toBe(2);
  });

  it("forwards close so daemon shutdown can reap the inner isolate", async () => {
    const close = vi.fn(async () => undefined);
    const provider = { ...createProvider(async () => []), close };
    const readiness = createEmbeddingProviderReadiness(provider);
    const observed = observeEmbeddingProviderReadiness(provider, readiness)!;

    await observed.close?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("prevents a concurrent backfill batch from persisting a second dimension", async () => {
    const memories = Array.from({ length: 17 }, (_, index) => createMemory(index));
    const provider = createProvider(async (texts) =>
      texts.map(() => unitVector(texts.length === 1 ? 3 : 2))
    );
    const readiness = createEmbeddingProviderReadiness(provider);
    const observed = observeEmbeddingProviderReadiness(provider, readiness)!;
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async (_workspaceId, tier) =>
          tier === StorageTier.HOT ? memories : []
        )
      },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => []),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider: observed,
      batchConcurrency: 2,
      retryDelayMs: 0
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    expect(upsert).toHaveBeenCalledTimes(16);
    expect(upsert.mock.calls.every(([record]) => record.dimensions === 2)).toBe(true);
    expect(result.objectsAffected).toEqual(memories.slice(0, 16).map(({ object_id }) => object_id));
    expect(result.auditEntries.some((entry) =>
      entry.startsWith("embedding_failed:provider:memory-16:")
    )).toBe(true);
  });
});

describe("Source capability readiness (mock provider, no model execution)", () => {
  it("preserves absent and unsupported capabilities instead of manufacturing Source readiness", async () => {
    const provider = createProvider(async () => []);
    const readiness = createEmbeddingProviderReadiness(provider);
    expect(observeEmbeddingProviderReadiness(provider, readiness)!.bindSourceEmbedding).toBeUndefined();
    const bindSourceEmbedding = vi.fn(async () => ({ status: "unsupported" as const, reason: "fixture_no_tokenizer" }));
    const observed = observeEmbeddingProviderReadiness({ ...provider, bindSourceEmbedding }, readiness)!;
    await expect(observed.bindSourceEmbedding!({ window_bytes: 1024 })).resolves.toEqual({ status: "unsupported", reason: "fixture_no_tokenizer" });
    expect(readiness.status).toBe("pending");
    expect(readiness.dimensions).toBeNull();
  });

  it("forwards the same provider's bound capability, raw inputs, cancellation, and close", async () => {
    const fixture = sourceProvider();
    const readiness = createEmbeddingProviderReadiness(fixture.provider);
    const observed = observeEmbeddingProviderReadiness(fixture.provider, readiness)!;
    const binding = await observed.bindSourceEmbedding!({ window_bytes: 1024 });
    if (binding.status !== "ready") throw new Error("fixture must bind");
    expect(fixture.bind.mock.contexts[0]).toBe(fixture.provider);
    expect(readiness.status).toBe("pending");
    const inputs = [{ input_id: "raw", text: "  原文🙂\r\n " }];
    const options = { profile_id: binding.profile_id, timeoutMs: 1234, signal: new AbortController().signal };
    const rows = await binding.embedInputs(inputs, options);
    expect(fixture.embed).toHaveBeenCalledWith(inputs, options);
    expect(fixture.embed.mock.contexts[0]).toBe(fixture.binding);
    expect(rows[0]).toMatchObject({ status: "embedded", input_id: "raw", input_digest: `sha256:${sha256(inputs[0]!.text)}` });
    expect(readiness.dimensions).toBe(2);
    expect(readiness.status).toBe("ready");
    await observed.close?.();
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it("does not turn an empty Source result or a per-input refusal into dimensional readiness", async () => {
    const fixture = sourceProvider();
    const readiness = createEmbeddingProviderReadiness(fixture.provider);
    const observed = observeEmbeddingProviderReadiness(fixture.provider, readiness)!;
    const binding = await observed.bindSourceEmbedding!({ window_bytes: 1024 });
    if (binding.status !== "ready") throw new Error("fixture must bind");
    await expect(binding.embedInputs([], { profile_id: binding.profile_id, timeoutMs: 1_000 })).resolves.toEqual([]);
    fixture.embed.mockImplementation(async inputs => inputs.map(input => ({ status: "not_embedded", input_id: input.input_id,
      input_digest: `sha256:${sha256(input.text)}`, token_count: null, reason: "fixture_unavailable" })));
    await expect(binding.embedInputs([{ input_id: "raw", text: "raw" }], { profile_id: binding.profile_id, timeoutMs: 1_000 }))
      .resolves.toMatchObject([{ status: "not_embedded", reason: "fixture_unavailable" }]);
    expect(readiness.dimensions).toBeNull();
    expect(readiness.status).toBe("pending");
  });

  it.each(["profile dimensions", "established dimensions", "non-finite"])("rejects Source vectors with %s without replacing established readiness", async fault => {
    const fixture = sourceProvider();
    const readiness = createEmbeddingProviderReadiness(fixture.provider);
    const observed = observeEmbeddingProviderReadiness(fixture.provider, readiness)!;
    await observed.embedTexts(["probe"], { timeoutMs: 1_000 });
    if (fault === "established dimensions") fixture.binding.profile = { ...fixture.binding.profile, dimensions: 3 };
    const binding = await observed.bindSourceEmbedding!({ window_bytes: 1024 });
    if (binding.status !== "ready") throw new Error("fixture must bind");
    fixture.embed.mockImplementation(async inputs => inputs.map(input => ({ status: "embedded", input_id: input.input_id,
      input_digest: `sha256:${sha256(input.text)}`, token_count: 3, truncated: false,
      vector: fault === "non-finite" ? new Float32Array([NaN, 0]) : unitVector(3) })));
    await expect(binding.embedInputs([{ input_id: "raw", text: "raw" }], { profile_id: binding.profile_id, timeoutMs: 1_000 }))
      .rejects.toThrow(/dimensions|finite/i);
    expect(readiness.status).toBe("ready");
    expect(readiness.dimensions).toBe(2);
  });

  it("pins legacy readiness to the dimension first established by Source evidence", async () => {
    const fixture = sourceProvider();
    const readiness = createEmbeddingProviderReadiness(fixture.provider);
    const observed = observeEmbeddingProviderReadiness(fixture.provider, readiness)!;
    const binding = await observed.bindSourceEmbedding!({ window_bytes: 1024 });
    if (binding.status !== "ready") throw new Error("fixture must bind");
    await binding.embedInputs([{ input_id: "raw", text: "raw" }], { profile_id: binding.profile_id, timeoutMs: 1_000 });
    fixture.embedTexts.mockResolvedValue([unitVector(3)]);
    await expect(observed.embedTexts(["legacy"], { timeoutMs: 1_000 })).rejects.toThrow(/dimensions/);
    expect(readiness.status).toBe("ready");
    expect(readiness.dimensions).toBe(2);
    expect(fixture.bind).toHaveBeenCalledTimes(1);
  });

  it("uses the injected provider for daemon warmup and Source forwarding without constructing a second local runtime", async () => {
    const fixture = sourceProvider();
    const constructor = vi.spyOn(core, "LocalOnnxEmbeddingClient");
    const database = initDatabase({ filename: ":memory:" });
    const runtime = createDaemonEmbeddingRuntime({ database,
      configEnv: new Map([["ALAYA_EMBEDDING_PROVIDER", "local_onnx"], ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"]]),
      eventLogRepo: new SqliteEventLogRepo(database), memoryEntryRepo: new SqliteMemoryEntryRepo(database),
      runtimeNotifier: { notifyEntry: () => undefined },
      healthJournalService: { getRecentEvents: vi.fn(async () => []), record: vi.fn(async () => undefined) },
      warn: vi.fn(), embeddingProviderOverride: fixture.provider
    });
    try {
      await expect(runtime.providerWarmup).resolves.toBe("ready");
      expect(fixture.embedTexts).toHaveBeenCalledTimes(1);
      const binding = await runtime.bindSourceEmbedding({ window_bytes: 1024 });
      if (binding.status !== "ready") throw new Error("fixture must bind");
      await expect(binding.embedInputs([{ input_id: "source", text: "raw" }], { profile_id: binding.profile_id, timeoutMs: 1_000 }))
        .resolves.toMatchObject([{ status: "embedded", input_id: "source" }]);
      expect(fixture.bind).toHaveBeenCalledTimes(1);
      expect(fixture.bind.mock.contexts[0]).toBe(fixture.provider);
      expect(runtime.getProviderDimensions()).toBe(2);
      expect(constructor).not.toHaveBeenCalled();
    } finally { await runtime.closeProvider(); database.close(); }
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });
});

function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function sourceProvider() {
  const profile: SourceIndexProfile = { provider_kind: "local_onnx", model_id: "fixture-model", model_revision: "fixture-only",
    artifact_digest: `sha256:${"a".repeat(64)}`, tokenizer_revision: "fixture-tokenizer", dimensions: 2,
    preprocessing: "fixture-raw", normalization: "fixture-unit", max_input_tokens: 32,
    windowing: "utf8-byte-windows.v1", window_bytes: 1024 };
  type BindingResult = Awaited<ReturnType<NonNullable<EmbeddingProviderPort["bindSourceEmbedding"]>>>;
  type Binding = Extract<BindingResult, { status: "ready" }>;
  const embed = vi.fn<Binding["embedInputs"]>(async inputs => inputs.map(input => ({ status: "embedded", input_id: input.input_id,
    input_digest: `sha256:${sha256(input.text)}`, vector: unitVector(2), token_count: 3, truncated: false })));
  const binding = { status: "ready" as const, profile, profile_id: sourceIndexProfileId(profile, sha256), embedInputs: embed };
  const bind = vi.fn<NonNullable<EmbeddingProviderPort["bindSourceEmbedding"]>>(async () => binding);
  const close = vi.fn(async () => undefined);
  const embedTexts = vi.fn<EmbeddingProviderPort["embedTexts"]>(async texts => texts.map(() => unitVector(2)));
  return { provider: { ...createProvider(embedTexts), providerKind: "local_onnx" as const, bindSourceEmbedding: bind, close },
    binding, bind, embed, embedTexts, close };
}

function createProvider(
  embedTexts: EmbeddingProviderPort["embedTexts"]
): EmbeddingProviderPort {
  return {
    providerKind: "openai",
    modelId: "fixture-model",
    schemaVersion: 1,
    isAvailable: true,
    embedTexts
  };
}

function unitVector(dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  vector[0] = 1;
  return vector;
}

function createMemory(index: number): MemoryEntry {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    object_id: `memory-${index}`,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: now,
    updated_at: now,
    created_by: "provider-readiness-test",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Provider readiness content ${index}.`,
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}
