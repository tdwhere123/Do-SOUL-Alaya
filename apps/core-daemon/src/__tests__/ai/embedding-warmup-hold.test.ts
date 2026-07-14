import { describe, expect, it } from "vitest";
import {
  annotateRecallEmbeddingWarmupHold,
  resolveEmbeddingWarmupHoldReason
} from "../../ai/embedding-warmup-hold.js";

describe("embedding warmup hold", () => {
  it("maps readiness to an explicit hold reason", () => {
    expect(resolveEmbeddingWarmupHoldReason("pending")).toBe("provider_warmup_pending");
    expect(resolveEmbeddingWarmupHoldReason("failed")).toBe("provider_warmup_failed");
    expect(resolveEmbeddingWarmupHoldReason("ready")).toBeNull();
    expect(resolveEmbeddingWarmupHoldReason("not_requested")).toBeNull();
  });

  it("stamps provider_degradation_reason on lexical-only recall during pending warmup", () => {
    const result = annotateRecallEmbeddingWarmupHold(
      {
        diagnostics: {
          embedding_provider_status: "provider_not_requested",
          provider_degradation_reason: null
        }
      },
      "provider_warmup_pending"
    );
    expect(result.diagnostics.provider_degradation_reason).toBe("provider_warmup_pending");
  });

  it("does not claim embedding_on by overwriting an active embedding result", () => {
    const result = annotateRecallEmbeddingWarmupHold(
      {
        diagnostics: {
          embedding_provider_status: "provider_returned",
          provider_degradation_reason: null
        }
      },
      "provider_warmup_pending"
    );
    expect(result.diagnostics.provider_degradation_reason).toBeNull();
  });
});
