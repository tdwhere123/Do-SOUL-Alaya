import { describe, expect, it } from "vitest";
import {
  AlayaStatusSchema,
  DEFAULT_ENVIRONMENT_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  EnvironmentConfigSchema,
  parseSecretRefKeychainTarget,
  RuntimeEmbeddingConfigPatchSchema,
  RuntimeEmbeddingConfigSchema,
  RuntimeGardenComputeConfigSchema,
  secretRefScheme,
  SoulConfigSchema,
  StrategyConfigSchema,
  ToolchainStatusSchema
} from "../index.js";

describe("app config schemas", () => {
  it("exports parseable default soul, strategy, and environment configs", () => {
    expect(SoulConfigSchema.parse(DEFAULT_SOUL_CONFIG)).toEqual({
      memory_consolidation_enabled: true,
      local_heuristics_enabled: true,
      garden_backlog_soft_limit: 100,
      memory_hard_cap: 2000,
      auto_checkpoint: true
    });

    expect(StrategyConfigSchema.parse(DEFAULT_STRATEGY_CONFIG)).toEqual({
      require_bash_approval: true,
      require_write_approval: true,
      require_network_approval: true,
      auto_approve_readonly: false
    });

    expect(EnvironmentConfigSchema.parse(DEFAULT_ENVIRONMENT_CONFIG)).toEqual({
      env_vars: {},
      worktree_enabled: false
    });
  });

  it("accepts environment variables with empty values but rejects blank keys", () => {
    expect(
      EnvironmentConfigSchema.parse({
        env_vars: {
          OPENAI_API_KEY: "",
          NODE_ENV: "development"
        },
        worktree_enabled: true
      })
    ).toEqual({
      env_vars: {
        OPENAI_API_KEY: "",
        NODE_ENV: "development"
      },
      worktree_enabled: true
    });

    expect(
      EnvironmentConfigSchema.safeParse({
        env_vars: {
          "   ": "secret"
        },
        worktree_enabled: false
      }).success
    ).toBe(false);
  });

  it("parses toolchain status with storage metadata", () => {
    expect(
      ToolchainStatusSchema.parse({
        tools: {
          git: true,
          node: true,
          pnpm: false,
          rg: true
        },
        active_worktrees: 2,
        db_path: "/tmp/do-what.sqlite",
        files_dir: "/tmp/do-what-files"
      })
    ).toEqual({
      tools: {
        git: true,
        node: true,
        pnpm: false,
        rg: true
      },
      active_worktrees: 2,
      db_path: "/tmp/do-what.sqlite",
      files_dir: "/tmp/do-what-files"
    });
  });

  it("classifies and parses secret refs through the protocol-level grammar", () => {
    expect(secretRefScheme("env:OPENAI_API_KEY")).toBe("env");
    expect(secretRefScheme("file:/etc/alaya/secret")).toBe("file");
    expect(secretRefScheme("keychain:alaya:openai")).toBe("keychain");
    expect(secretRefScheme("vault:alaya:openai")).toBe(null);
    expect(secretRefScheme("OPENAI_API_KEY")).toBe(null);

    expect(parseSecretRefKeychainTarget("keychain:alaya:openai")).toEqual({
      service: "alaya",
      account: "openai"
    });
    expect(parseSecretRefKeychainTarget("keychain:alaya-garden:openai_4o")).toEqual({
      service: "alaya-garden",
      account: "openai_4o"
    });
    expect(parseSecretRefKeychainTarget("keychain:alaya.garden:openai.preview")).toEqual({
      service: "alaya.garden",
      account: "openai.preview"
    });

    for (const malformed of [
      "env:OPENAI_API_KEY",
      "keychain:",
      "keychain:alaya",
      "keychain:alaya:openai:extra",
      "keychain:: openai",
      "keychain:alaya: openai",
      "keychain:alaya:openai ",
      "keychain: alaya:openai",
      "keychain:\talaya:openai",
      "keychain:alaya:open\nai",
      "keychain:alaya:open\"ai",
      "keychain:alaya:open'ai",
      "keychain:alaya:open$ai",
      "keychain:alaya:open(ai)",
      "keychain:-alaya:openai",
      "keychain:alaya:--openai"
    ]) {
      expect(parseSecretRefKeychainTarget(malformed), malformed).toBe(null);
    }
  });

  it("exports runtime embedding and Alaya status schemas for Inspector", () => {
    expect(
      RuntimeEmbeddingConfigSchema.parse({
        provider_url: null,
        secret_ref: "env:OPENAI_API_KEY",
        model_id: "text-embedding-3-small",
        embedding_enabled: true
      })
    ).toEqual({
      provider_url: null,
      secret_ref: "env:OPENAI_API_KEY",
      model_id: "text-embedding-3-small",
      embedding_enabled: true
    });

    expect(RuntimeEmbeddingConfigPatchSchema.safeParse({ embedding_enabled: false }).success).toBe(true);
    expect(RuntimeEmbeddingConfigPatchSchema.safeParse({ unknown: true }).success).toBe(false);

    expect(
      RuntimeGardenComputeConfigSchema.parse({
        provider_kind: "official_api",
        provider_url: null,
        secret_ref: "keychain:alaya-garden:openai",
        model_id: "gpt-4.1-mini",
        enabled: true
      })
    ).toMatchObject({
      secret_ref: "keychain:alaya-garden:openai"
    });

    for (const secretRef of ["keychain:", "keychain:onlyservice", "keychain:a:b:c", "keychain::acct"]) {
      expect(
        RuntimeGardenComputeConfigSchema.safeParse({
          provider_kind: "official_api",
          provider_url: null,
          secret_ref: secretRef,
          model_id: "gpt-4.1-mini",
          enabled: true
        }).success,
        secretRef
      ).toBe(false);
    }

    for (const legacySecretRef of [
      "keychain:alaya: openai",
      "keychain:alaya:openai ",
      "keychain: alaya:openai",
      "keychain:alaya:open\tai",
      "keychain:alaya:openai\n",
      "keychain:alaya:open\"ai",
      "keychain:alaya:open$ai",
      "keychain:-alaya:openai",
      "keychain:alaya:--openai"
    ]) {
      expect(
        RuntimeGardenComputeConfigSchema.safeParse({
          provider_kind: "official_api",
          provider_url: null,
          secret_ref: legacySecretRef,
          model_id: "gpt-4.1-mini",
          enabled: true
        }).success,
        legacySecretRef
      ).toBe(true);
    }

    expect(
      AlayaStatusSchema.parse({
        checked_at: "2026-04-30T00:00:00.000Z",
        daemon: {
          ready: true,
          startup_steps: ["database", "http-app"],
          principal_coding_engine_available: true
        },
        mcp: {
          enrolled_tools: 2,
          allowed_servers: ["filesystem"]
        }
      })
    ).toMatchObject({
      daemon: { ready: true },
      mcp: { enrolled_tools: 2 }
    });
  });
});
