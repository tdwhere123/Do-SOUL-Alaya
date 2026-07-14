import type { EmbeddingProviderWarmupStatus } from "../services/embedding-status-service.js";

export type EmbeddingWarmupHoldReason =
  | "provider_warmup_pending"
  | "provider_warmup_failed";

/** Lexical-only hold while bi-default-on warmup has not verified the provider. */
export function resolveEmbeddingWarmupHoldReason(
  status: EmbeddingProviderWarmupStatus
): EmbeddingWarmupHoldReason | null {
  if (status === "pending") return "provider_warmup_pending";
  if (status === "failed") return "provider_warmup_failed";
  return null;
}

export function annotateRecallEmbeddingWarmupHold<T extends {
  readonly diagnostics?: {
    readonly embedding_provider_status: string;
    readonly provider_degradation_reason: string | null;
  };
}>(result: T, holdReason: EmbeddingWarmupHoldReason | null): T {
  if (holdReason === null) return result;
  const diagnostics = result.diagnostics;
  if (diagnostics === undefined) return result;
  // Only annotate successful lexical-only recalls that would otherwise look intentional.
  if (
    diagnostics.embedding_provider_status !== "provider_not_requested" &&
    diagnostics.embedding_provider_status !== "provider_pending"
  ) {
    return result;
  }
  if (diagnostics.provider_degradation_reason !== null) return result;
  return {
    ...result,
    diagnostics: {
      ...diagnostics,
      provider_degradation_reason: holdReason
    }
  };
}
