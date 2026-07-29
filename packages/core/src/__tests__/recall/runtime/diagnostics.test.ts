import { describe, expect, it } from "vitest";
import { NO_STORED_VECTORS_DEGRADATION_REASON } from "../../../embedding-recall/constants.js";
import { normalizeEmbeddingProviderDegradationReason } from "../../../recall/runtime/diagnostics.js";

describe("normalizeEmbeddingProviderDegradationReason", () => {
  it("preserves no_stored_vectors instead of collapsing to provider_unavailable", () => {
    expect(normalizeEmbeddingProviderDegradationReason("no_stored_vectors")).toBe(
      NO_STORED_VECTORS_DEGRADATION_REASON
    );
    expect(normalizeEmbeddingProviderDegradationReason("  NO_STORED_VECTORS  ")).toBe(
      NO_STORED_VECTORS_DEGRADATION_REASON
    );
  });

  it("keeps known embedding degradation reasons", () => {
    expect(normalizeEmbeddingProviderDegradationReason("local_vector_lookup_failed")).toBe(
      "local_vector_lookup_failed"
    );
    expect(normalizeEmbeddingProviderDegradationReason("query_embedding_pending")).toBe(
      "query_embedding_pending"
    );
  });

  it("maps unknown reasons to provider_unavailable", () => {
    expect(normalizeEmbeddingProviderDegradationReason("unexpected_upstream")).toBe(
      "provider_unavailable"
    );
  });
});
