import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EvidenceDocumentEmbeddingEngine
} from "../../embedding-recall/evidence/evidence-document-embedding-engine.js";
import type {
  EvidenceDocumentEmbeddingRecord,
  EvidenceDocumentEmbeddingRepoPort
} from "../../embedding-recall/types.js";
import { createProvider, mockEmbedTexts } from "./embedding-recall-test-helpers.js";

describe("EvidenceDocumentEmbeddingEngine", () => {
  it("reuses an identity-preserving document batch without another provider call", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);
    const texts = Array.from({ length: 25 }, (_, index) => `document ${index}`);

    const first = await engine.embedDocuments(request(texts), 5_000);
    const second = await engine.embedDocuments(request(texts), 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(first.inferenceCalls).toBe(1);
    expect(second.inferenceCalls).toBe(0);
    expect(second.embeddings).toEqual(first.embeddings);
    expect(second.embeddings[0]).not.toBe(first.embeddings[0]);
  });

  it("binds cache identity and provider input to normalized document text", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);

    const first = await engine.embedDocuments(request(["  same document  "]), 5_000);
    const second = await engine.embedDocuments(request(["same document"]), 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(embedTexts).toHaveBeenCalledWith(["same document"], { timeoutMs: 5_000 });
    expect(second.embeddings).toEqual(first.embeddings);
  });

  it("binds cached documents to the active provider model identity", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const provider = createProvider({ embedTexts });
    const engine = new EvidenceDocumentEmbeddingEngine(provider, 50);

    await engine.embedDocuments(request(["same document"]), 5_000);
    Object.assign(provider, { modelId: "replacement-model" });
    await engine.embedDocuments(request(["same document"]), 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(2);
  });

  it("preserves exact input order when a batch contains duplicate documents", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);

    const result = await engine.embedDocuments(request(["beta", "alpha", "beta"]), 5_000);

    expect(embedTexts).toHaveBeenCalledWith(["beta", "alpha"], { timeoutMs: 5_000 });
    expect(result.embeddings).toEqual([
      vectorFor("beta"),
      vectorFor("alpha"),
      vectorFor("beta")
    ]);
  });

  it("single-flights overlapping document misses", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) => {
      await blocked;
      return texts.map((text) => vectorFor(text));
    });
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);

    const first = engine.embedDocuments(request(["shared", "first"]), 5_000);
    const second = engine.embedDocuments(request(["shared"]), 5_000);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(firstResult.inferenceCalls).toBe(1);
    expect(secondResult.inferenceCalls).toBe(0);
    expect(secondResult.embeddings[0]).toEqual(firstResult.embeddings[0]);
  });

  it("clears failed single-flight entries so a later request can retry", async () => {
    let shouldFail = true;
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) => {
      if (shouldFail) throw new Error("transient failure");
      return texts.map((text) => vectorFor(text));
    });
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 50);

    await expect(engine.embedDocuments(request(["retry"]), 5_000)).rejects.toThrow("transient failure");
    shouldFail = false;
    const retried = await engine.embedDocuments(request(["retry"]), 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(2);
    expect(retried.inferenceCalls).toBe(1);
    expect(retried.embeddings).toEqual([vectorFor("retry")]);
  });

  it("evicts the least-recently-used document at the configured bound", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const engine = new EvidenceDocumentEmbeddingEngine(createProvider({ embedTexts }), 2);

    await engine.embedDocuments(request(["a", "b"]), 5_000);
    await engine.embedDocuments(request(["a"]), 5_000);
    await engine.embedDocuments(request(["c"]), 5_000);
    const evicted = await engine.embedDocuments(request(["b"]), 5_000);

    expect(embedTexts).toHaveBeenCalledTimes(3);
    expect(evicted.inferenceCalls).toBe(1);
  });

  it("hydrates exact persisted identities without document inference", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const store = createStore([
      persistedRecord("document 0", "object-0", "owner")
    ]);
    const engine = new EvidenceDocumentEmbeddingEngine(
      createProvider({ embedTexts }),
      50,
      store
    );

    const result = await engine.embedDocuments(request(["document 0"]), 5_000);
    await engine.embedDocuments(request(["document 0"]), 5_000);

    expect(result.embeddings).toEqual([vectorFor("document 0")]);
    expect(result.inferenceCalls).toBe(0);
    expect(embedTexts).not.toHaveBeenCalled();
    expect(store.findByDocuments).toHaveBeenCalledOnce();
    expect(store.upsertMany).not.toHaveBeenCalled();
  });

  it("joins an unordered persisted batch by exact document identity", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const store = createStore([
      persistedRecord("second", "object-1", "owner"),
      persistedRecord("first", "object-0", "owner")
    ]);
    const engine = new EvidenceDocumentEmbeddingEngine(
      createProvider({ embedTexts }),
      50,
      store
    );

    const result = await engine.embedDocuments(request(["first", "second"]), 5_000);

    expect(result.embeddings).toEqual([vectorFor("first"), vectorFor("second")]);
    expect(result.inferenceCalls).toBe(0);
    expect(embedTexts).not.toHaveBeenCalled();
    expect(store.upsertMany).not.toHaveBeenCalled();
  });

  it("embeds one mixed cold batch, preserves order, and persists each missing identity", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const store = createStore([
      persistedRecord("stored", "object-1", "owner")
    ]);
    const engine = new EvidenceDocumentEmbeddingEngine(
      createProvider({ embedTexts }),
      50,
      store,
      () => "2026-07-28T00:00:00.000Z"
    );

    const result = await engine.embedDocuments({
      workspaceId: "workspace-1",
      documents: [
        { ownerObjectId: "object-2", documentIdentity: "owner", content: "cold" },
        { ownerObjectId: "object-1", documentIdentity: "owner", content: "stored" },
        {
          ownerObjectId: "object-3",
          documentIdentity: "assistant_observation:1",
          content: "cold"
        }
      ]
    }, 5_000);

    expect(embedTexts).toHaveBeenCalledOnce();
    expect(embedTexts).toHaveBeenCalledWith(["cold"], { timeoutMs: 5_000 });
    expect(result.embeddings).toEqual([
      vectorFor("cold"),
      vectorFor("stored"),
      vectorFor("cold")
    ]);
    expect(store.upsertMany).toHaveBeenCalledOnce();
    expect(store.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        ownerObjectId: "object-2",
        documentIdentity: "owner",
        documentRole: "evidence_document"
      }),
      expect.objectContaining({
        ownerObjectId: "object-3",
        documentIdentity: "assistant_observation:1",
        documentRole: "evidence_document"
      })
    ]);
  });

  it("reuses a document persisted by a previous engine instance", async () => {
    const embedTexts = mockEmbedTexts(async (texts: readonly string[]) =>
      texts.map((text) => vectorFor(text))
    );
    const records: EvidenceDocumentEmbeddingRecord[] = [];
    const store = createStore(records);
    const provider = createProvider({ embedTexts });

    await new EvidenceDocumentEmbeddingEngine(provider, 50, store)
      .embedDocuments(request(["restart-safe"]), 5_000);
    const afterRestart = await new EvidenceDocumentEmbeddingEngine(provider, 50, store)
      .embedDocuments(request(["restart-safe"]), 5_000);

    expect(embedTexts).toHaveBeenCalledOnce();
    expect(afterRestart.inferenceCalls).toBe(0);
    expect(afterRestart.embeddings).toEqual([vectorFor("restart-safe")]);
  });
});

function vectorFor(text: string): Float32Array {
  return new Float32Array([text.length, text.charCodeAt(0) ?? 0]);
}

function request(texts: readonly string[]) {
  return {
    workspaceId: "workspace-1",
    documents: texts.map((content, index) => ({
      ownerObjectId: `object-${index}`,
      documentIdentity: "owner",
      content
    }))
  };
}

function persistedRecord(
  content: string,
  ownerObjectId: string,
  documentIdentity: string
): EvidenceDocumentEmbeddingRecord {
  return {
    workspaceId: "workspace-1",
    ownerObjectId,
    documentIdentity,
    contentHash: hash(content.trim()),
    documentRole: "evidence_document",
    providerKind: "openai",
    modelId: "text-embedding-3-small",
    schemaVersion: 1,
    dimensions: 2,
    embedding: vectorFor(content.trim()),
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z"
  };
}

function createStore(
  records: EvidenceDocumentEmbeddingRecord[]
): EvidenceDocumentEmbeddingRepoPort & {
  readonly findByDocuments: ReturnType<typeof vi.fn>;
  readonly upsertMany: ReturnType<typeof vi.fn>;
} {
  return {
    listSourcesByWorkspace: vi.fn(async () => []),
    findByDocuments: vi.fn(async (input) => records.filter((record) =>
      record.workspaceId === input.workspaceId &&
      record.providerKind === input.providerKind &&
      record.modelId === input.modelId &&
      record.schemaVersion === input.schemaVersion &&
      input.documents.some((document: {
        readonly ownerObjectId: string;
        readonly documentIdentity: string;
        readonly contentHash: string;
      }) =>
        document.ownerObjectId === record.ownerObjectId &&
        document.documentIdentity === record.documentIdentity &&
        document.contentHash === record.contentHash
      )
    )),
    upsertMany: vi.fn(async (incoming: readonly EvidenceDocumentEmbeddingRecord[]) => {
      for (const record of incoming) {
        const index = records.findIndex((candidate) =>
          candidate.workspaceId === record.workspaceId &&
          candidate.ownerObjectId === record.ownerObjectId &&
          candidate.documentIdentity === record.documentIdentity
        );
        if (index < 0) records.push(record);
        else records[index] = record;
      }
    })
  };
}

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
