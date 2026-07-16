import {
  assertValidEmbeddingBatch,
  type EmbeddingProviderPort
} from "@do-soul/alaya-core";
import type { EmbeddingProviderWarmupStatus } from "../services/embedding-status-service.js";

export interface EmbeddingProviderReadiness {
  readonly status: EmbeddingProviderWarmupStatus;
  readonly dimensions: number | null;
  markReady(dimensions: number): void;
  markFailed(): void;
}

export function createEmbeddingProviderReadiness(
  provider: EmbeddingProviderPort | null
): EmbeddingProviderReadiness {
  let status: EmbeddingProviderWarmupStatus = provider === null ? "not_requested" : "pending";
  let dimensions: number | null = null;
  return {
    get status() {
      return status;
    },
    get dimensions() {
      return dimensions;
    },
    markReady: (observedDimensions) => {
      if (dimensions !== null && observedDimensions !== dimensions) {
        throw new Error(
          `Embedding provider dimensions changed from ${dimensions} to ${observedDimensions}.`
        );
      }
      dimensions ??= observedDimensions;
      status = "ready";
    },
    // A successful use is stronger evidence than a failed, possibly stale startup probe.
    markFailed: () => { if (status !== "ready") status = "failed"; }
  };
}

export function observeEmbeddingProviderReadiness(
  provider: EmbeddingProviderPort | null,
  readiness: EmbeddingProviderReadiness
): EmbeddingProviderPort | null {
  if (provider === null) return null;
  return {
    providerKind: provider.providerKind,
    modelId: provider.modelId,
    schemaVersion: provider.schemaVersion,
    get isAvailable() {
      return provider.isAvailable;
    },
    embedTexts: async (texts, options) => {
      const embeddings = await provider.embedTexts(texts, options);
      assertValidEmbeddingBatch(embeddings, texts.length);
      if (embeddings.length === 0) return embeddings;
      const responseDimensions = embeddings[0]!.length;
      readiness.markReady(responseDimensions);
      return embeddings;
    }
  };
}
