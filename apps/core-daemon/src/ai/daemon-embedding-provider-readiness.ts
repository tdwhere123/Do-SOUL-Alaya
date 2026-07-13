import type { EmbeddingProviderPort } from "@do-soul/alaya-core";
import type { EmbeddingProviderWarmupStatus } from "../services/embedding-status-service.js";

export interface EmbeddingProviderReadiness {
  readonly status: EmbeddingProviderWarmupStatus;
  markReady(): void;
  markFailed(): void;
}

export function createEmbeddingProviderReadiness(
  provider: EmbeddingProviderPort | null
): EmbeddingProviderReadiness {
  let status: EmbeddingProviderWarmupStatus = provider === null ? "not_requested" : "pending";
  return {
    get status() {
      return status;
    },
    markReady: () => { status = "ready"; },
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
      readiness.markReady();
      return embeddings;
    }
  };
}
