import { createHash } from "node:crypto";
import { assertValidEmbeddingBatch, toErrorMessage } from "../helpers.js";
import type { EmbeddingProviderPort } from "../types.js";

export interface EvidenceDocumentEmbeddingBatch {
  readonly embeddings: readonly Float32Array[];
  readonly inferenceCalls: number;
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

  public constructor(
    private readonly provider: EmbeddingProviderPort,
    private readonly capacity: number
  ) {}

  public async embedDocuments(
    texts: readonly string[],
    timeoutMs: number
  ): Promise<EvidenceDocumentEmbeddingBatch> {
    const normalizedTexts = texts.map(normalizeDocumentText);
    const keys = normalizedTexts.map((text) => this.cacheKey(text));
    const misses = this.resolveMisses(normalizedTexts, keys);
    try {
      if (misses.length > 0) this.startMissBatch(misses, timeoutMs);
      const embeddings = await Promise.all(keys.map((key) => this.resolveVector(key)));
      return Object.freeze({
        embeddings: Object.freeze(embeddings),
        inferenceCalls: misses.length > 0 ? 1 : 0
      });
    } catch (error) {
      throw new EvidenceDocumentEmbeddingError(misses.length > 0 ? 1 : 0, error);
    } finally {
      for (const miss of misses) this.pending.delete(miss.key);
    }
  }

  private resolveMisses(texts: readonly string[], keys: readonly string[]): DocumentMiss[] {
    const misses: DocumentMiss[] = [];
    const scheduled = new Set<string>();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (
        this.getCached(key) !== null ||
        this.pending.has(key) ||
        scheduled.has(key)
      ) {
        continue;
      }
      scheduled.add(key);
      misses.push({ key, text: texts[index]! });
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

function normalizeDocumentText(text: string): string {
  return text.trim();
}
