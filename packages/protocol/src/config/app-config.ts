import { z } from "zod";
import {
  BoundedLabelSchema,
  BoundedPathSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";

export const APP_CONFIG_VERSION = 1 as const;
const AppConfigVersionSchema = z.literal(APP_CONFIG_VERSION);

function makeVersionedConfigSchema<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({
      config_version: AppConfigVersionSchema.optional(),
      ...shape
    })
    .strict()
    .readonly();
}

export const SoulConfigSchema = makeVersionedConfigSchema({
  memory_consolidation_enabled: z.boolean(),
  local_heuristics_enabled: z.boolean(),
  garden_backlog_soft_limit: z.number().int().min(10).max(1000),
  memory_hard_cap: z.number().int().min(100).max(10000),
  auto_checkpoint: z.boolean()
});

export const StrategyConfigSchema = makeVersionedConfigSchema({
  require_bash_approval: z.boolean(),
  require_write_approval: z.boolean(),
  require_network_approval: z.boolean(),
  auto_approve_readonly: z.boolean()
});

export const EnvironmentVariablesSchema = z
  .record(BoundedLabelSchema, z.string().max(16384))
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (key.trim().length === 0) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Environment variable names must not be blank."
        });
      }
    }
  })
  .readonly();

export const EnvironmentConfigSchema = makeVersionedConfigSchema({
  env_vars: EnvironmentVariablesSchema,
  worktree_enabled: z.boolean()
});

export const ToolchainStatusSchema = z
  .object({
    tools: z.record(BoundedLabelSchema, z.boolean()).readonly(),
    active_worktrees: NonNegativeIntSchema,
    db_path: BoundedPathSchema,
    files_dir: BoundedPathSchema
  })
  .readonly();

export const RuntimeEmbeddingConfigSchema = makeVersionedConfigSchema({
  provider_url: NonEmptyStringSchema.nullable(),
  secret_ref: NonEmptyStringSchema.nullable(),
  model_id: NonEmptyStringSchema.nullable(),
  embedding_enabled: z.boolean()
});

export const RuntimeEmbeddingConfigPatchSchema = RuntimeEmbeddingConfigSchema.unwrap()
  .partial()
  .strict()
  .readonly();

// Runtime config keeps the patch-compatible keychain:service:account shape.
// Operational keychain reads/writes use parseSecretRefKeychainTarget below so
// platform argv never receives whitespace, quoting, or leading-dash segments.
export const SECRET_REF_ENV_PREFIX = "env:";
export const SECRET_REF_FILE_PREFIX = "file:";
export const SECRET_REF_KEYCHAIN_PREFIX = "keychain:";
export const ENV_SECRET_REF_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// Each segment must start with an alphanumeric or `_`/`.` so platform
// tooling (`security -a <segment>`, `secret-tool account <segment>`)
// cannot interpret it as a flag, and the body uses the same charset
// plus `-` so common service names like `alaya-garden` stay valid.
export const KEYCHAIN_REF_SEGMENT_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9._-]*$/u;

export type SecretRefScheme = "env" | "file" | "keychain";

export interface KeychainRefTarget {
  readonly service: string;
  readonly account: string;
}

export function secretRefScheme(ref: string): SecretRefScheme | null {
  if (ref.startsWith(SECRET_REF_ENV_PREFIX)) {
    return "env";
  }
  if (ref.startsWith(SECRET_REF_FILE_PREFIX)) {
    return "file";
  }
  if (ref.startsWith(SECRET_REF_KEYCHAIN_PREFIX)) {
    return "keychain";
  }
  return null;
}

export function parseSecretRefKeychainTarget(ref: string): KeychainRefTarget | null {
  if (!ref.startsWith(SECRET_REF_KEYCHAIN_PREFIX)) {
    return null;
  }
  const body = ref.slice(SECRET_REF_KEYCHAIN_PREFIX.length);
  const segments = body.split(":");
  if (segments.length !== 2) {
    return null;
  }
  const [service, account] = segments;
  if (service === undefined || account === undefined) {
    return null;
  }
  if (!KEYCHAIN_REF_SEGMENT_PATTERN.test(service) || !KEYCHAIN_REF_SEGMENT_PATTERN.test(account)) {
    return null;
  }
  return { service, account };
}

const RuntimeSecretRefSchema = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((value, context) => {
    if (value.startsWith(SECRET_REF_ENV_PREFIX)) {
      const envName = value.slice(SECRET_REF_ENV_PREFIX.length);
      if (ENV_SECRET_REF_NAME_PATTERN.test(envName)) {
        return;
      }
    }

    if (value.startsWith(SECRET_REF_FILE_PREFIX)) {
      const filePath = value.slice(SECRET_REF_FILE_PREFIX.length);
      if (filePath.startsWith("/") && filePath.length > 1) {
        return;
      }
    }

    if (value.startsWith(SECRET_REF_KEYCHAIN_PREFIX)) {
      const segments = value.slice(SECRET_REF_KEYCHAIN_PREFIX.length).split(":");
      if (segments.length === 2 && segments[0] !== "" && segments[1] !== "") {
        return;
      }
    }

    context.addIssue({
      code: "custom",
      message: 'secret_ref must use "env:NAME", "file:/path", or "keychain:service:account".'
    });
  });

export const RuntimeGardenProviderKindSchema = z.enum(["official_api", "local_heuristics", "host_worker"]);

export const RuntimeGardenComputeConfigSchema = makeVersionedConfigSchema({
  provider_kind: RuntimeGardenProviderKindSchema,
  model_id: NonEmptyStringSchema.nullable(),
  provider_url: NonEmptyStringSchema.nullable(),
  secret_ref: RuntimeSecretRefSchema.nullable(),
  enabled: z.boolean()
});

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
export type RuntimeGardenProviderKind = z.infer<typeof RuntimeGardenProviderKindSchema>;
export type RuntimeGardenComputeConfig = z.infer<typeof RuntimeGardenComputeConfigSchema>;
export type RuntimeGardenComputeConfigPatch = z.infer<typeof RuntimeGardenComputeConfigPatchSchema>;
export type AlayaStatus = z.infer<typeof AlayaStatusSchema>;

export const DEFAULT_SOUL_CONFIG: SoulConfig = {
  config_version: APP_CONFIG_VERSION,
  memory_consolidation_enabled: true,
  local_heuristics_enabled: true,
  garden_backlog_soft_limit: 100,
  memory_hard_cap: 2000,
  auto_checkpoint: true
};

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  config_version: APP_CONFIG_VERSION,
  require_bash_approval: true,
  require_write_approval: true,
  require_network_approval: true,
  auto_approve_readonly: false
};

export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentConfig = {
  config_version: APP_CONFIG_VERSION,
  env_vars: {},
  worktree_enabled: false
};
