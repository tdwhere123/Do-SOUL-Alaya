import { describe, expect, it } from "vitest";
import { createEmbeddingStatusService } from "../../services/embedding-status-service.js";

describe("createEmbeddingStatusService", () => {
  it("reports startup warmup failure as degraded instead of claiming the supplement is live", async () => {
    const service = createEmbeddingStatusService({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: true,
      providerConfigured: true,
      providerAvailable: () => true,
      providerWarmupStatus: () => "failed",
      modelId: "local/model",
      storageAvailable: true
    });

    await expect(service.getStatus("workspace-1")).resolves.toMatchObject({
      embedding_enabled: true,
      provider_configured: true,
      effective_mode: "degraded",
      degraded_reason: "provider_warmup_failed"
    });
  });

  it("re-reads live provider availability after a successful warmup", async () => {
    let available = true;
    const service = createEmbeddingStatusService({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: true,
      providerConfigured: true,
      providerAvailable: () => available,
      providerWarmupStatus: () => "ready",
      modelId: "local/model",
      storageAvailable: true
    });

    await expect(service.getStatus("workspace-1")).resolves.toMatchObject({
      effective_mode: "embedding_supplement",
      degraded_reason: null
    });
    available = false;
    await expect(service.getStatus("workspace-1")).resolves.toMatchObject({
      effective_mode: "degraded",
      degraded_reason: "provider_unavailable"
    });
  });

  it("keeps an explicitly disabled supplement in keyword-only mode", async () => {
    const service = createEmbeddingStatusService({
      embeddingEnabled: false,
      recallPolicyEmbeddingEnabled: false,
      providerConfigured: false,
      providerAvailable: () => false,
      providerWarmupStatus: () => "not_requested",
      modelId: null,
      storageAvailable: true
    });

    await expect(service.getStatus("workspace-1")).resolves.toMatchObject({
      embedding_enabled: false,
      effective_mode: "keyword_only",
      degraded_reason: null
    });
  });
});
