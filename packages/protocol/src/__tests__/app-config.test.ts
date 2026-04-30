import { describe, expect, it } from "vitest";
import {
  AlayaStatusSchema,
  DEFAULT_ENVIRONMENT_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_STRATEGY_CONFIG,
  EnvironmentConfigSchema,
  RuntimeEmbeddingConfigPatchSchema,
  RuntimeEmbeddingConfigSchema,
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
