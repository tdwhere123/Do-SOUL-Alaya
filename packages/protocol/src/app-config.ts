import { z } from "zod";
import { NonEmptyStringSchema, NonNegativeIntSchema } from "./schema-primitives.js";

export const SoulConfigSchema = z
  .object({
    memory_consolidation_enabled: z.boolean(),
    local_heuristics_enabled: z.boolean(),
    garden_backlog_soft_limit: z.number().int().min(10).max(1000),
    memory_hard_cap: z.number().int().min(100).max(10000),
    auto_checkpoint: z.boolean()
  })
  .readonly();

export const StrategyConfigSchema = z
  .object({
    require_bash_approval: z.boolean(),
    require_write_approval: z.boolean(),
    require_network_approval: z.boolean(),
    auto_approve_readonly: z.boolean()
  })
  .readonly();

export const EnvironmentVariablesSchema = z
  .record(z.string())
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (key.trim().length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Environment variable names must not be blank."
        });
      }
    }
  })
  .readonly();

export const EnvironmentConfigSchema = z
  .object({
    env_vars: EnvironmentVariablesSchema,
    worktree_enabled: z.boolean()
  })
  .readonly();

export const ToolchainStatusSchema = z
  .object({
    tools: z.record(z.boolean()).readonly(),
    active_worktrees: NonNegativeIntSchema,
    db_path: NonEmptyStringSchema,
    files_dir: NonEmptyStringSchema
  })
  .readonly();

export const RuntimeEmbeddingConfigSchema = z
  .object({
    provider_url: NonEmptyStringSchema.nullable(),
    secret_ref: NonEmptyStringSchema.nullable(),
    model_id: NonEmptyStringSchema.nullable(),
    embedding_enabled: z.boolean()
  })
  .readonly();

export const RuntimeEmbeddingConfigPatchSchema = RuntimeEmbeddingConfigSchema.unwrap()
  .partial()
  .strict()
  .readonly();

const RuntimeSecretRefSchema = z
  .string()
  .superRefine((value, context) => {
    if (value.startsWith("env:")) {
      const envName = value.slice("env:".length);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envName)) {
        return;
      }
    }

    if (value.startsWith("file:")) {
      const filePath = value.slice("file:".length);
      if (filePath.startsWith("/") && filePath.length > 1) {
        return;
      }
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'secret_ref must use "env:NAME" or "file:/path".'
    });
  });

export const RuntimeGardenComputeConfigSchema = z
  .object({
    provider_kind: z.enum(["official_api", "local_heuristics", "host_worker"]),
    model_id: NonEmptyStringSchema.nullable(),
    provider_url: NonEmptyStringSchema.nullable(),
    secret_ref: RuntimeSecretRefSchema.nullable(),
    enabled: z.boolean()
  })
  .readonly();

export const RuntimeGardenComputeConfigPatchSchema = RuntimeGardenComputeConfigSchema.unwrap()
  .partial()
  .strict()
  .readonly();

export const AlayaStatusSchema = z
  .object({
    checked_at: NonEmptyStringSchema,
    daemon: z
      .object({
        ready: z.boolean(),
        startup_steps: z.array(NonEmptyStringSchema).readonly(),
        principal_coding_engine_available: z.boolean()
      })
      .readonly(),
    mcp: z
      .object({
        enrolled_tools: NonNegativeIntSchema,
        allowed_servers: z.array(NonEmptyStringSchema).readonly()
      })
      .readonly()
  })
  .readonly();

export type SoulConfig = z.infer<typeof SoulConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type EnvironmentVariables = z.infer<typeof EnvironmentVariablesSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
export type ToolchainStatus = z.infer<typeof ToolchainStatusSchema>;
export type RuntimeEmbeddingConfig = z.infer<typeof RuntimeEmbeddingConfigSchema>;
export type RuntimeEmbeddingConfigPatch = z.infer<typeof RuntimeEmbeddingConfigPatchSchema>;
export type RuntimeGardenComputeConfig = z.infer<typeof RuntimeGardenComputeConfigSchema>;
export type RuntimeGardenComputeConfigPatch = z.infer<typeof RuntimeGardenComputeConfigPatchSchema>;
export type AlayaStatus = z.infer<typeof AlayaStatusSchema>;

export const DEFAULT_SOUL_CONFIG: SoulConfig = {
  memory_consolidation_enabled: true,
  local_heuristics_enabled: true,
  garden_backlog_soft_limit: 100,
  memory_hard_cap: 2000,
  auto_checkpoint: true
};

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  require_bash_approval: true,
  require_write_approval: true,
  require_network_approval: true,
  auto_approve_readonly: false
};

export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentConfig = {
  env_vars: {},
  worktree_enabled: false
};
