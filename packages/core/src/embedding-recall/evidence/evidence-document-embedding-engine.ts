import { createHash } from "node:crypto";
import { assertValidEmbeddingBatch, hashMemoryContent, toErrorMessage } from "../helpers.js";
import type {
  EmbeddingProviderPort,
  EvidenceDocumentEmbeddingRecord,
  EvidenceDocumentEmbeddingRef,
  EvidenceDocumentEmbeddingRepoPort
} from "../types.js";

export interface EvidenceDocumentEmbeddingBatch {
  readonly embeddings: readonly Float32Array[];
  readonly inferenceCalls: number;
  readonly persistedCount: number;
}

export interface EvidenceDocumentEmbeddingInput {
  readonly workspaceId: string;
  readonly documents: readonly Readonly<{
    readonly ownerObjectId: string;
    readonly documentIdentity: string;
    readonly content: string;
  }>[];
}

interface PreparedDocument extends EvidenceDocumentEmbeddingRef {
  readonly content: string;
  readonly cacheKey: string;
}

interface DocumentMiss {
  readonly key: string;
  readonly text: string;
}

const DOCUMENT_ROLE = "evidence_document";

export class EvidenceDocumentEmbeddingError extends Error {
  public constructor(
    public readonly inferenceCalls: number,
    cause: unknown
  ) {
    super(toErrorMessage(cause), { cause });
    this.name = "EvidenceDocumentEmbeddingError";
  }
}

export class EvidenceDocumentEmbeddingEngine {
  private readonly cache = new Map<string, Float32Array>();
  private readonly pending = new Map<string, Promise<Float32Array>>();
  private readonly persistedKeys = new Set<string>();
  private readonly warn: (message: string, meta: Record<string, unknown>) => void;

  public constructor(
    private readonly provider: EmbeddingProviderPort,
    private readonly capacity: number,
    private readonly store?: EvidenceDocumentEmbeddingRepoPort,
    private readonly now: () => string = () => new Date().toISOString(),
    warn?: (message: string, meta: Record<string, unknown>) => void
  ) {
    this.warn = warn ?? (() => undefined);
  }

  public async embedDocuments(
    input: EvidenceDocumentEmbeddingInput,
    timeoutMs: number
  ): Promise<EvidenceDocumentEmbeddingBatch> {
    const documents = input.documents.map((document) => this.prepareDocument(document));
    await this.hydrateStored(
      input.workspaceId,
      documents.filter((document) => this.needsStoreLookup(document))
    );
    const misses = this.resolveMisses(documents);
    try {
      if (misses.length > 0) this.startMissBatch(misses, timeoutMs);
      const embeddings = await Promise.all(
        documents.map((document) => this.resolveVector(document.cacheKey))
      );
      const persistedCount = await this.persistMissing(
        input.workspaceId,
        documents,
        embeddings,
        this.persistedKeys
      );
      return Object.freeze({
        embeddings: Object.freeze(embeddings),
        inferenceCalls: misses.length > 0 ? 1 : 0,
        persistedCount
      });
    } catch (error) {
      throw new EvidenceDocumentEmbeddingError(misses.length > 0 ? 1 : 0, error);
    } finally {
      for (const miss of misses) this.pending.delete(miss.key);
    }
  }

  private prepareDocument(
    document: EvidenceDocumentEmbeddingInput["documents"][number]
  ): PreparedDocument {
    const content = normalizeDocumentText(document.content);
    return {
      ownerObjectId: document.ownerObjectId,
      documentIdentity: document.documentIdentity,
      content,
      contentHash: hashMemoryContent(content),
      cacheKey: this.cacheKey(content)
    };
  }

  private async hydrateStored(
    workspaceId: string,
    documents: readonly PreparedDocument[]
  ): Promise<void> {
    if (this.store === undefined || documents.length === 0) return;
    try {
      const records = await this.store.findByDocuments({
        workspaceId,
        documents,
        documentRole: DOCUMENT_ROLE,
        providerKind: this.provider.providerKind,
        modelId: this.provider.modelId,
        schemaVersion: this.provider.schemaVersion
      });
      for (const record of records) {
        const document = documents.find((candidate) => matchesRecord(candidate, record));
        if (document === undefined) continue;
        this.putCached(document.cacheKey, record.embedding);
        this.persistedKeys.add(persistentKey(document));
      }
    } catch (error) {
      this.warnStoreFailure("read", workspaceId, error);
    }
  }

  private needsStoreLookup(document: PreparedDocument): boolean {
    return this.getCached(document.cacheKey) === null ||
      !this.persistedKeys.has(persistentKey(document));
  }

  private resolveMisses(documents: readonly PreparedDocument[]): DocumentMiss[] {
    const misses: DocumentMiss[] = [];
    const scheduled = new Set<string>();
    for (const document of documents) {
      if (
        this.getCached(document.cacheKey) !== null ||
        this.pending.has(document.cacheKey) ||
        scheduled.has(document.cacheKey)
      ) {
        continue;
      }
      scheduled.add(document.cacheKey);
      misses.push({ key: document.cacheKey, text: document.content });
    }
    return misses;
  }

  private startMissBatch(misses: readonly DocumentMiss[], timeoutMs: number): void {
    const batch = this.provider.embedTexts(
      misses.map((miss) => miss.text),
      { timeoutMs }
    ).then((embeddings) => {
      assertValidEmbeddingBatch(embeddings, misses.length);
      return embeddings;
    });
    misses.forEach((miss, index) => {
      const pending = batch.then((embeddings) => {
        const vector = new Float32Array(embeddings[index]!);
        this.putCached(miss.key, vector);
        return vector;
      });
      this.pending.set(miss.key, pending);
    });
  }

  private async persistMissing(
    workspaceId: string,
    documents: readonly PreparedDocument[],
    embeddings: readonly Float32Array[],
    storedKeys: ReadonlySet<string>
  ): Promise<number> {
    if (this.store === undefined) return 0;
    const timestamp = this.now();
    const records = uniqueMissingRecords(
      workspaceId,
      documents,
      embeddings,
      storedKeys,
      this.provider,
      timestamp
    );
    if (records.length === 0) return 0;
    try {
      await this.store.upsertMany(records);
      for (const record of records) this.persistedKeys.add(persistentKey(record));
      return records.length;
    } catch (error) {
      this.warnStoreFailure("write", workspaceId, error);
      return 0;
    }
  }

  private warnStoreFailure(
    phase: "read" | "write",
    workspaceId: string,
    error: unknown
  ): void {
    this.warn("evidence document embedding store degraded", {
      workspace_id: workspaceId,
      phase,
      error: toErrorMessage(error)
    });
  }

  private async resolveVector(key: string): Promise<Float32Array> {
    const cached = this.getCached(key);
    if (cached !== null) return cached;
    const pending = this.pending.get(key);
    if (pending === undefined) {
      throw new Error("Evidence document embedding was neither cached nor scheduled.");
    }
    return new Float32Array(await pending);
  }

  private getCached(key: string): Float32Array | null {
    const vector = this.cache.get(key);
    if (vector === undefined) return null;
    this.cache.delete(key);
    this.cache.set(key, vector);
    return new Float32Array(vector);
  }

  private putCached(key: string, vector: Float32Array): void {
    if (this.capacity <= 0) return;
    this.cache.delete(key);
    this.cache.set(key, new Float32Array(vector));
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.cache.delete(oldest);
    }
  }

  private cacheKey(text: string): string {
    const identity = [
      DOCUMENT_ROLE,
      this.provider.providerKind,
      this.provider.modelId,
      this.provider.schemaVersion,
      text
    ].join("\u0000");
    return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
  }
}

function matchesRecord(
  document: Readonly<PreparedDocument>,
  record: Readonly<EvidenceDocumentEmbeddingRecord>
): boolean {
  return document.ownerObjectId === record.ownerObjectId &&
    document.documentIdentity === record.documentIdentity &&
    document.contentHash === record.contentHash;
}

function persistentKey(document: Readonly<EvidenceDocumentEmbeddingRef>): string {
  return [
    document.ownerObjectId,
    document.documentIdentity,
    document.contentHash
  ].join("\u0000");
}

function uniqueMissingRecords(
  workspaceId: string,
  documents: readonly PreparedDocument[],
  embeddings: readonly Float32Array[],
  storedKeys: ReadonlySet<string>,
  provider: EmbeddingProviderPort,
  timestamp: string
): readonly EvidenceDocumentEmbeddingRecord[] {
  const records = new Map<string, EvidenceDocumentEmbeddingRecord>();
  documents.forEach((document, index) => {
    const key = persistentKey(document);
    if (storedKeys.has(key) || records.has(key)) return;
    const embedding = new Float32Array(embeddings[index]!);
    records.set(key, Object.freeze({
      workspaceId,
      ownerObjectId: document.ownerObjectId,
      documentIdentity: document.documentIdentity,
      contentHash: document.contentHash,
      documentRole: DOCUMENT_ROLE,
      providerKind: provider.providerKind,
      modelId: provider.modelId,
      schemaVersion: provider.schemaVersion,
      dimensions: embedding.length,
      embedding,
      createdAt: timestamp,
      updatedAt: timestamp
    }));
  });
  return Object.freeze([...records.values()]);
}

function normalizeDocumentText(text: string): string {
  return text.trim();
}
