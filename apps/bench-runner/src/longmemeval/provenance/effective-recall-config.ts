import { createHash } from "node:crypto";
import {
  EMBEDDING_WORKSPACE_SCAN_CAP,
  parseCoreConfigFromEnv,
  resolveBackfillBatchConcurrency,
  resolveEmbeddingRecallTiersFromConfig,
  resolvePathRelContentStrengthEnabledFromConfig,
  stableStringify
} from "@do-soul/alaya-core";
import { buildBenchDiagnosticRecallPolicy } from "../../harness/daemon-recall-result.js";
import {
  applyBenchRecallWeightOverrides,
  type BenchRecallWeightOverrides
} from "../../harness/recall-weight-overrides.js";
import { resolveSourceRefRobust } from "../../harness/daemon-environment.js";

export const EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION = 2 as const;

export interface EffectiveRecallOptions {
  readonly maxResults: number;
  readonly conflictAwareness: boolean;
}

export interface EffectiveRecallConfigIdentity {
  readonly schema_version: typeof EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION;
  readonly max_results: number;
  readonly conflict_awareness: boolean;
  readonly effective_config_sha256: string;
}

const FORBIDDEN_RECALL_EVAL_POLICY_ENV_KEYS = [
  "ALAYA_BENCH_EMBEDDING_INJECTION_CAP",
  "ALAYA_BENCH_EMBEDDING_INJECTION_FLOOR",
  "ALAYA_BENCH_RECALL_MAX_TOKENS",
  "ALAYA_RECALL_COARSE_FLOOR"
] as const;

export function assertRecallEvalProductPolicyEnvironment(
  env: Readonly<Record<string, string | undefined>>
): void {
  for (const key of FORBIDDEN_RECALL_EVAL_POLICY_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      throw new Error(`${key} is not allowed in the recall-eval product matrix`);
    }
  }
}

export function readRecallEvalMaxResults(raw: string | undefined): number {
  if (raw === undefined) return 10;
  const normalized = raw.trim();
  if (!/^[0-9]+$/u.test(normalized)) {
    throw new Error("ALAYA_RECALL_EVAL_MAX_RESULTS must be an integer from 1 to 1000");
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("ALAYA_RECALL_EVAL_MAX_RESULTS must be an integer from 1 to 1000");
  }
  return value;
}

export function buildEffectiveRecallConfigIdentity(
  env: Readonly<Record<string, string | undefined>>,
  options: EffectiveRecallOptions,
  recallWeightOverrides?: BenchRecallWeightOverrides
): EffectiveRecallConfigIdentity {
  if (!Number.isSafeInteger(options.maxResults) ||
      options.maxResults < 1 || options.maxResults > 1_000) {
    throw new Error("effective recall maxResults must be an integer from 1 to 1000");
  }
  const normalized = {
    schema_version: EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION,
    request: {
      max_results: options.maxResults,
      conflict_awareness: options.conflictAwareness
    },
    runtime: normalizedCoreRuntime(env),
    recall_policy: normalizedRecallPolicy(options, recallWeightOverrides),
    daemon_adapter: {
      source_ref_robust: resolveSourceRefRobust(
        env.ALAYA_RECALL_SOURCE_REF_ROBUST
      )
    }
  };
  return Object.freeze({
    schema_version: EFFECTIVE_RECALL_CONFIG_SCHEMA_VERSION,
    max_results: options.maxResults,
    conflict_awareness: options.conflictAwareness,
    effective_config_sha256: createHash("sha256")
      .update(stableStringify(normalized), "utf8")
      .digest("hex")
  });
}

function normalizedCoreRuntime(
  env: Readonly<Record<string, string | undefined>>
) {
  const config = parseCoreConfigFromEnv(env);
  return {
    recall: config.recall,
    embedding: {
      backfill_concurrency: resolveBackfillBatchConcurrency(
        config.embedding.backfillConcurrency
      ),
      recall_tiers: resolveEmbeddingRecallTiersFromConfig(config.embedding),
      workspace_scan_cap: config.embedding.workspaceScanCap ??
        EMBEDDING_WORKSPACE_SCAN_CAP
    },
    path_graph: {
      content_strength_enabled:
        resolvePathRelContentStrengthEnabledFromConfig(config.pathGraph)
    }
  };
}

function normalizedRecallPolicy(
  options: EffectiveRecallOptions,
  recallWeightOverrides: BenchRecallWeightOverrides | undefined
) {
  const policy = applyBenchRecallWeightOverrides(
    buildBenchDiagnosticRecallPolicy(
      "effective-recall-policy",
      options.maxResults,
      options.conflictAwareness
    ),
    recallWeightOverrides
  );
  const {
    runtime_id: _runtimeId,
    task_surface_ref: _taskSurfaceRef,
    expires_at: _expiresAt,
    ...normalized
  } = policy;
  return normalized;
}
