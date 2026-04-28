import { describe, expect, it } from "vitest";
import {
  createOperationsStatusReport,
  deriveProviderPosture
} from "../operations/index.js";

const now = "2026-04-28T00:00:00.000Z";

describe("operations status report", () => {
  it("returns a read-only secret-free status shape", () => {
    const report = createOperationsStatusReport({
      checked_at: now,
      local_data_path: {
        source: "DATA_DIR",
        path_ref: "/tmp/alaya"
      },
      storage: {
        driver: "node:sqlite",
        ready: true,
        database_state: "initialized"
      },
      profile: {
        ready: true,
        scopes: [
          { scope_id: "user:default", scope_kind: "user", ready: true },
          { scope_id: "project:repo", scope_kind: "project", ready: true }
        ]
      },
      provider: {
        provider_id: "openai",
        provider_configured: true,
        model_ref: "text-embedding-3-small",
        enabled: false,
        storage_available: true,
        secret_refs: [{
          secret_ref: "env:OPENAI_API_KEY",
          source_type: "env",
          resolution_state: "available",
          secret_value: "sk-test-should-not-leak"
        } as never]
      },
      attachments: {
        mcp: "not_attached",
        cli: "available"
      },
      host_prereqs: [{
        name: "node",
        required: true,
        available: true
      }],
      backup: {
        export_ready: true,
        backup_ready: true,
        last_backup_id: null
      }
    });

    expect(report).toMatchObject({
      schema_version: 1,
      checked_at: now,
      read_only: true,
      durable_truth_written: false,
      mutation_count: 0,
      provider: {
        posture: "configured",
        embedding: {
          embedding_enabled: false,
          provider_configured: true,
          model_ref: "text-embedding-3-small",
          storage_available: true,
          effective_mode: "keyword_only",
          degraded_reason: null
        },
        secret_refs: [{
          secret_ref: "env:OPENAI_API_KEY",
          source_type: "env",
          resolution_state: "available"
        }]
      },
      backup: {
        export_ready: true,
        backup_ready: true
      }
    });
    expect(JSON.stringify(report)).not.toContain("sk-test-should-not-leak");
  });

  it("distinguishes configured, enabled, disabled, degraded, and unavailable provider posture", () => {
    expect(deriveProviderPosture({
      provider_configured: false,
      enabled: false,
      storage_available: true
    })).toBe("missing");

    expect(deriveProviderPosture({
      provider_configured: true,
      enabled: false,
      storage_available: true
    })).toBe("configured");

    expect(deriveProviderPosture({
      provider_configured: true,
      enabled: false,
      storage_available: true,
      disabled_reason: "operator_disabled"
    })).toBe("disabled");

    expect(deriveProviderPosture({
      provider_configured: true,
      enabled: true,
      storage_available: true
    })).toBe("enabled");

    expect(deriveProviderPosture({
      provider_configured: true,
      enabled: true,
      storage_available: true,
      secret_refs: [{
        secret_ref: "env:OPENAI_API_KEY",
        source_type: "env",
        resolution_state: "missing"
      }]
    })).toBe("degraded");

    expect(deriveProviderPosture({
      provider_configured: true,
      enabled: true,
      storage_available: false
    })).toBe("unavailable");
  });

  it("reports missing provider without fake provider id and degrades missing secret refs", () => {
    const missingProvider = createOperationsStatusReport({
      checked_at: now,
      local_data_path: {
        source: "default",
        path_ref: "~/.do-soul/alaya"
      },
      storage: {
        driver: "node:sqlite",
        ready: true,
        database_state: "initialized"
      },
      profile: {
        ready: true,
        scopes: []
      },
      provider: {
        provider_id: null,
        provider_configured: false,
        model_ref: null,
        enabled: false,
        storage_available: true,
        secret_refs: []
      },
      attachments: {
        mcp: "not_attached",
        cli: "available"
      },
      host_prereqs: [],
      backup: {
        export_ready: true,
        backup_ready: false,
        last_backup_id: null
      }
    });

    expect(missingProvider.provider).toMatchObject({
      provider_id: null,
      posture: "missing",
      embedding: {
        effective_mode: "keyword_only",
        provider_configured: false
      }
    });

    const missingSecret = createOperationsStatusReport({
      checked_at: now,
      local_data_path: {
        source: "DATA_DIR",
        path_ref: "/tmp/alaya"
      },
      storage: {
        driver: "node:sqlite",
        ready: true,
        database_state: "initialized"
      },
      profile: {
        ready: true,
        scopes: []
      },
      provider: {
        provider_id: "openai",
        provider_configured: true,
        model_ref: "text-embedding-3-small",
        enabled: true,
        storage_available: true,
        secret_refs: [{
          secret_ref: "env:OPENAI_API_KEY",
          source_type: "env",
          resolution_state: "missing"
        }]
      },
      attachments: {
        mcp: "not_attached",
        cli: "available"
      },
      host_prereqs: [],
      backup: {
        export_ready: true,
        backup_ready: false,
        last_backup_id: null
      }
    });

    expect(missingSecret.provider).toMatchObject({
      provider_id: "openai",
      posture: "degraded",
      embedding: {
        effective_mode: "degraded",
        degraded_reason: "secret_ref_missing"
      }
    });
    expect(missingSecret.degraded_reasons).toContain("secret_ref_missing");
  });
});
