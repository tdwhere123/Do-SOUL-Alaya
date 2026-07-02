import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingBackfillHandler } from "../../embedding-recall/embedding-backfill-handler.js";
import type { EmbeddingVectorRecord } from "../../embedding-recall/embedding-recall-service.js";
import { D2Q_SCHEMA_VERSION, type HqProvider } from "../../embedding-recall/embed-text-resolver.js";
import {
  createEmbeddingMetadata,
  createMemoryEntry,
  hashContent
} from "./embedding-backfill-handler.test-support.js";

function captureProvider(schemaVersion: number) {
  const calls: string[][] = [];
  const provider = {
    providerKind: "local_onnx",
    modelId: "minilm",
    schemaVersion,
    isAvailable: true,
    embedTexts: vi.fn(async (texts: readonly string[]) => {
      calls.push([...texts]);
      return texts.map(() => new Float32Array([1, 0, 0]));
    })
  };
  return { provider, calls };
}

function hqProviderFor(map: Record<string, readonly string[]>): HqProvider {
  return {
    getHqByObjectIds: vi.fn(async (objectIds: readonly string[]) => {
      const entries = objectIds
        .filter((id) => map[id] !== undefined)
        .map((id) => [id, map[id]!] as const);
      return new Map(entries);
    })
  };
}

describe("EmbeddingBackfillHandler doc2query path", () => {
  beforeEach(() => {
    vi.stubEnv("ALAYA_EMBEDDING_RECALL_TIERS", "hot");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("embeds content + HQ and persists the d2q schema version, leaving content_hash on raw content", async () => {
    const { provider, calls } = captureProvider(D2Q_SCHEMA_VERSION);
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => [
          createMemoryEntry({ object_id: "m-hq", content: "Pinned repo workflow." }),
          createMemoryEntry({ object_id: "m-plain", content: "Plain note." })
        ])
      },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => []),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider,
      hqProvider: hqProviderFor({ "m-hq": ["What workflow is pinned?"] }),
      retryDelayMs: 0,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    await handler.handle({ workspace_id: "workspace-1" });

    expect(calls[0]).toEqual(["Pinned repo workflow. What workflow is pinned?", "Plain note."]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        object_id: "m-hq",
        schema_version: D2Q_SCHEMA_VERSION,
        content_hash: hashContent("Pinned repo workflow.")
      })
    );
  });

  it("re-embeds rows whose stored schema version predates the d2q bump even when content_hash is unchanged", async () => {
    const { provider } = captureProvider(D2Q_SCHEMA_VERSION);
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => [
          createMemoryEntry({ object_id: "m-1", content: "Pinned repo workflow." })
        ])
      },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => [
          createEmbeddingMetadata({
            object_id: "m-1",
            provider_kind: "local_onnx",
            model_id: "minilm",
            schema_version: 1,
            content_hash: hashContent("Pinned repo workflow.")
          })
        ]),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider,
      hqProvider: hqProviderFor({ "m-1": ["What workflow is pinned?"] }),
      now: () => "2026-04-23T00:00:00.000Z"
    });

    const result = await handler.handle({ workspace_id: "workspace-1" });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ object_id: "m-1", schema_version: D2Q_SCHEMA_VERSION })
    );
    expect(result.objectsAffected).toEqual(["m-1"]);
  });

  it("embeds raw content and the default schema version with no HQ provider (d2q off, byte-identical)", async () => {
    const { provider, calls } = captureProvider(1);
    const upsert = vi.fn(async (record: EmbeddingVectorRecord) => record);
    const handler = new EmbeddingBackfillHandler({
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => [
          createMemoryEntry({ object_id: "m-1", content: "Pinned repo workflow." })
        ])
      },
      memoryEmbeddingRepo: {
        findMetadataByObjectIds: vi.fn(async () => []),
        upsert,
        upsertIfContentHashMatchesCurrentMemory: upsert
      },
      provider,
      now: () => "2026-04-23T00:00:00.000Z"
    });

    await handler.handle({ workspace_id: "workspace-1" });

    expect(calls[0]).toEqual(["Pinned repo workflow."]);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ object_id: "m-1", schema_version: 1 }));
  });
});
