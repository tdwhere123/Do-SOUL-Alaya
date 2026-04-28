import { describe, expect, it } from "vitest";
import { deriveEmbeddingStatus, deriveProviderStatus } from "../provider/status.js";
import type { ProviderHealthState, ProviderRegistryEntry } from "../provider/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("provider and embedding status", () => {
  it("keeps configured provider/model separate from embedding enablement", () => {
    const providerStatus = deriveProviderStatus({
      checked_at: now,
      provider: provider({
        health: health("configured"),
        model_ref: "text-embedding-3-small"
      })
    });
    const embeddingStatus = deriveEmbeddingStatus({
      checked_at: now,
      embedding_enabled: false,
      provider: providerStatus,
      recall_policy_embedding_enabled: false,
      storage_available: true,
      workspace_id: "workspace-1"
    });

    expect(providerStatus).toMatchObject({
      provider_configured: true,
      provider_enabled: false,
      status: "configured"
    });
    expect(embeddingStatus).toMatchObject({
      degraded_reason: null,
      effective_mode: "keyword_only",
      embedding_enabled: false,
      model_id: "text-embedding-3-small",
      provider_configured: true,
      provider_status: "configured"
    });
  });

  it("distinguishes missing, disabled, unavailable, enabled, and degraded provider states", () => {
    expect(deriveProviderStatus({
      checked_at: now,
      provider: null
    })).toMatchObject({
      provider_configured: false,
      provider_enabled: false,
      reason: "provider_missing",
      status: "missing"
    });
    expect(deriveProviderStatus({
      checked_at: now,
      provider: provider({ health: health("disabled", "operator_disabled") })
    })).toMatchObject({
      provider_configured: true,
      provider_enabled: false,
      reason: "operator_disabled",
      status: "disabled"
    });
    expect(deriveProviderStatus({
      checked_at: now,
      provider: provider({ health: health("unavailable", "network_down") })
    })).toMatchObject({
      provider_configured: true,
      provider_enabled: false,
      reason: "network_down",
      status: "unavailable"
    });
    expect(deriveProviderStatus({
      checked_at: now,
      provider: provider({ health: health("enabled") })
    })).toMatchObject({
      provider_configured: true,
      provider_enabled: true,
      reason: null,
      status: "enabled"
    });
    expect(deriveProviderStatus({
      checked_at: now,
      provider: provider({ health: health("degraded", "rate_limited") })
    })).toMatchObject({
      degraded_reason: "rate_limited",
      provider_configured: true,
      provider_enabled: false,
      status: "degraded"
    });
  });

  it("degrades enabled embedding when provider, storage, or secret resolution is unavailable", () => {
    const missingSecretProvider = deriveProviderStatus({
      checked_at: now,
      provider: provider({ health: health("enabled") }),
      secret_resolution: {
        checked_at: now,
        reason: "env_var_missing",
        resolved: false,
        secret_ref: "secret:provider",
        source_key: "ALAYA_PROVIDER_KEY",
        source_type: "env",
        state: "missing"
      }
    });

    expect(missingSecretProvider).toMatchObject({
      audit_context: {
        reason: "env_var_missing",
        secret_ref: "secret:provider",
        secret_state: "missing"
      },
      degraded_reason: "secret_ref_missing:secret:provider",
      status: "degraded"
    });
    expect(JSON.stringify(missingSecretProvider)).not.toContain("sk-");

    expect(deriveEmbeddingStatus({
      checked_at: now,
      embedding_enabled: true,
      provider: missingSecretProvider,
      recall_policy_embedding_enabled: true,
      storage_available: true,
      workspace_id: "workspace-1"
    })).toMatchObject({
      degraded_reason: "secret_ref_missing:secret:provider",
      effective_mode: "degraded"
    });

    expect(deriveEmbeddingStatus({
      checked_at: now,
      embedding_enabled: true,
      provider: deriveProviderStatus({
        checked_at: now,
        provider: provider({ health: health("enabled") })
      }),
      recall_policy_embedding_enabled: true,
      storage_available: false,
      workspace_id: "workspace-1"
    })).toMatchObject({
      degraded_reason: "storage_unavailable",
      effective_mode: "degraded"
    });
  });

  it("requires degraded reasons and keeps disabled embedding keyword-only", () => {
    expect(() =>
      deriveProviderStatus({
        checked_at: now,
        provider: provider({ health: health("degraded") })
      })
    ).toThrow("degraded provider status requires reason");

    expect(() =>
      deriveEmbeddingStatus({
        checked_at: now,
        degradation_reason: "",
        embedding_enabled: true,
        provider: deriveProviderStatus({
          checked_at: now,
          provider: provider({ health: health("enabled") })
        }),
        recall_policy_embedding_enabled: true,
        storage_available: true,
        workspace_id: "workspace-1"
      })
    ).toThrow("degraded embedding status requires reason");

    expect(deriveEmbeddingStatus({
      checked_at: now,
      degradation_reason: "query_embedding_failed",
      embedding_enabled: false,
      provider: deriveProviderStatus({
        checked_at: now,
        provider: provider({ health: health("enabled") })
      }),
      recall_policy_embedding_enabled: false,
      storage_available: true,
      workspace_id: "workspace-1"
    })).toMatchObject({
      degraded_reason: null,
      effective_mode: "keyword_only",
      embedding_enabled: false
    });
  });
});

function provider(overrides: Partial<ProviderRegistryEntry> = {}): ProviderRegistryEntry {
  return {
    capabilities: ["embedding"],
    config_ref: "config:provider",
    health: health("enabled"),
    model_ref: "text-embedding-3-small",
    priority: 10,
    provider_id: "provider-a",
    provider_kind: "local",
    scope_refs: ["workspace-1"],
    ...overrides
  };
}

function health(status: ProviderHealthState["status"], reason: string | null = null): ProviderHealthState {
  return {
    checked_at: now,
    reason,
    status
  };
}
