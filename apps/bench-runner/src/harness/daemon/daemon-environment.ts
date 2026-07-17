import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveSecretRef,
  type ResolveSecretError
} from "@do-soul/alaya";
import { resolveCoreConfigEnvironmentKeys } from "@do-soul/alaya-core";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "./daemon-types.js";
import { emitBenchHarnessWarning } from "./runtime/daemon-warnings.js";
import {
  readOptionalOnnxThreadCount,
  readOptionalTreatmentBoolean
} from "../strict-treatment-config.js";
import { planBenchDaemonConfigDirectory } from "./daemon-config-directory.js";

export function resolveBenchOpenAiSecretRef(
  savedEnv: Partial<Record<string, string | undefined>>
): string {
  return savedEnv.ALAYA_OPENAI_SECRET_REF?.trim() || "env:OPENAI_API_KEY";
}

const DEFAULT_BENCH_REVIEWER_IDENTITY = "user:bench-runner";

export const BENCH_DAEMON_MANAGED_ENV_KEYS = [
  "DATA_DIR",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_PROVIDER_URL",
  "ALAYA_OPENAI_SECRET_REF",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_EMBEDDING_PROVIDER",
  "ALAYA_LOCAL_EMBEDDING_CACHE_DIR",
  "ALAYA_LOCAL_EMBEDDING_MODEL",
  "ALAYA_LOCAL_ONNX_THREADS",
  "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK",
  "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR",
  "ALAYA_LOCAL_CROSS_ENCODER_MODEL",
  "ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT",
  "ALAYA_LOCAL_ONNX_LOCK_PATH",
  "ALAYA_RECALL_D2Q",
  "ALAYA_RECALL_SOURCE_REF_ROBUST",
  "ALAYA_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "ALAYA_REVIEWER_IDENTITY",
  "ALAYA_REVIEWER_TOKEN"
] as const;

export function resolveBenchDaemonManagedEnvKeys(
  launchEnvironment: BenchDaemonEnvironment,
  currentEnvironment: Readonly<Record<string, string | undefined>>
): readonly string[] {
  return Object.freeze([...new Set([
    ...BENCH_DAEMON_MANAGED_ENV_KEYS,
    ...resolveCoreConfigEnvironmentKeys(launchEnvironment, currentEnvironment)
  ])]);
}

export type BenchDaemonEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface BenchReviewerCredentials {
  readonly identity: string;
  readonly token: string;
}

export interface BenchDaemonLaunchConfig {
  readonly dataDir: string;
  readonly configDir: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly environment: BenchDaemonEnvironment;
  readonly reviewerCredentials: BenchReviewerCredentials;
}

export function createBenchDaemonLaunchConfig(input: {
  readonly dataDir: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly ambientEnv?: Readonly<Record<string, string | undefined>>;
  readonly reviewerIdentity?: string;
  readonly reviewerToken?: string;
  readonly tokenFactory?: () => string;
}): BenchDaemonLaunchConfig {
  const ambientEnv = input.ambientEnv ?? process.env;
  validateSavedTreatmentEnvironment(ambientEnv);
  const reviewerCredentials = resolveBenchReviewerCredentials({
    options: input,
    savedEnv: ambientEnv,
    tokenFactory: input.tokenFactory
  });
  const openAiSecretRef = resolveBenchOpenAiSecretRef(ambientEnv);
  if (input.embeddingMode === "env" && input.embeddingProviderKind === "openai") {
    requireBenchOpenAiSecretRef(openAiSecretRef);
  }
  const configDir = planBenchDaemonConfigDirectory();
  const environment = buildBenchDaemonEnvironment({
    ...input,
    configDir,
    ambientEnv,
    reviewerCredentials,
    openAiSecretRef
  });
  return Object.freeze({
    dataDir: input.dataDir,
    configDir,
    embeddingMode: input.embeddingMode,
    embeddingProviderKind: input.embeddingProviderKind,
    environment,
    reviewerCredentials
  });
}

export function resolveBenchReviewerCredentials(input: {
  readonly options: {
    readonly reviewerIdentity?: string;
    readonly reviewerToken?: string;
  };
  readonly savedEnv: Partial<Record<string, string | undefined>>;
  readonly tokenFactory?: () => string;
}): BenchReviewerCredentials {
  const identity = firstNonEmpty(
    input.options.reviewerIdentity,
    input.savedEnv.ALAYA_REVIEWER_IDENTITY,
    DEFAULT_BENCH_REVIEWER_IDENTITY
  );
  const token = firstNonEmpty(
    input.options.reviewerToken,
    input.savedEnv.ALAYA_REVIEWER_TOKEN,
    input.tokenFactory?.() ?? "bench-review-token-" + randomUUID()
  );
  return Object.freeze({ identity, token });
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  throw new Error("expected at least one non-empty value");
}

function buildBenchDaemonEnvironment(input: {
  readonly dataDir: string;
  readonly configDir: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly openAiSecretRef: string;
  readonly ambientEnv: Readonly<Record<string, string | undefined>>;
  readonly reviewerCredentials: BenchReviewerCredentials;
}): BenchDaemonEnvironment {
  const environment: Record<string, string | undefined> = { ...input.ambientEnv };
  setEnvironmentValue(environment, "DATA_DIR", input.dataDir);
  applyEmbeddingEnvironment(environment, input);
  setEnvironmentValue(environment, "ALAYA_CONFIG_DIR", input.configDir);
  setEnvironmentValue(environment, "CODEX_HOME", join(input.dataDir, "codex-home"));
  setEnvironmentValue(environment, "HOME", join(input.dataDir, "home"));
  setEnvironmentValue(environment, "ALAYA_REVIEWER_IDENTITY", input.reviewerCredentials.identity);
  setEnvironmentValue(environment, "ALAYA_REVIEWER_TOKEN", input.reviewerCredentials.token);
  copyTreatmentValue(environment, input.ambientEnv, "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK");
  copyTreatmentValue(environment, input.ambientEnv, "ALAYA_LOCAL_CROSS_ENCODER_MODEL");
  copyTreatmentValue(environment, input.ambientEnv, "ALAYA_RECALL_D2Q");
  copyTreatmentValue(environment, input.ambientEnv, "ALAYA_LOCAL_ONNX_THREADS");
  const crossEnabled = readOptionalTreatmentBoolean(
    input.ambientEnv.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  ) === true;
  setEnvironmentValue(
    environment,
    "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR",
    crossEnabled ? resolveLocalModelCacheRoot(input.ambientEnv, "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR")
      : input.ambientEnv.ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR
  );
  setEnvironmentValue(
    environment,
    "ALAYA_RECALL_SOURCE_REF_ROBUST",
    resolveSourceRefRobust(input.ambientEnv.ALAYA_RECALL_SOURCE_REF_ROBUST) ? "true" : "false"
  );
  return Object.freeze(environment);
}

function validateSavedTreatmentEnvironment(
  savedEnv: Partial<Record<string, string | undefined>>
): void {
  readOptionalTreatmentBoolean(
    savedEnv.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK,
    "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK"
  );
  readOptionalTreatmentBoolean(savedEnv.ALAYA_RECALL_D2Q, "ALAYA_RECALL_D2Q");
  readOptionalOnnxThreadCount(savedEnv.ALAYA_LOCAL_ONNX_THREADS);
}

function applyEmbeddingEnvironment(
  environment: Record<string, string | undefined>,
  input: Parameters<typeof buildBenchDaemonEnvironment>[0]
): void {
  const ambientEnv = input.ambientEnv;
  if (input.embeddingMode === "env") {
    setEnvironmentValue(environment, "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true");
    if (input.embeddingProviderKind === "local_onnx") {
      setEnvironmentValue(environment, "ALAYA_EMBEDDING_PROVIDER", "local_onnx");
      setEnvironmentValue(
        environment,
        "ALAYA_LOCAL_EMBEDDING_CACHE_DIR",
        resolveLocalModelCacheRoot(ambientEnv, "ALAYA_LOCAL_EMBEDDING_CACHE_DIR")
      );
      setEnvironmentValue(environment, "ALAYA_LOCAL_EMBEDDING_MODEL", ambientEnv.ALAYA_LOCAL_EMBEDDING_MODEL);
      setEnvironmentValue(environment, "ALAYA_OPENAI_SECRET_REF", undefined);
      setEnvironmentValue(environment, "OPENAI_API_KEY", undefined);
    } else {
      setEnvironmentValue(environment, "ALAYA_EMBEDDING_PROVIDER", "openai");
      setEnvironmentValue(environment, "ALAYA_LOCAL_EMBEDDING_CACHE_DIR", undefined);
      setEnvironmentValue(environment, "ALAYA_LOCAL_EMBEDDING_MODEL", undefined);
      setEnvironmentValue(environment, "ALAYA_OPENAI_SECRET_REF", input.openAiSecretRef);
      setEnvironmentValue(environment, "OPENAI_API_KEY", ambientEnv.OPENAI_API_KEY);
    }
  } else {
    setEnvironmentValue(environment, "ALAYA_EMBEDDING_PROVIDER", "local_onnx");
    setEnvironmentValue(environment, "ALAYA_LOCAL_EMBEDDING_CACHE_DIR", undefined);
    setEnvironmentValue(environment, "ALAYA_LOCAL_EMBEDDING_MODEL", undefined);
    setEnvironmentValue(environment, "ALAYA_OPENAI_SECRET_REF", undefined);
    setEnvironmentValue(environment, "OPENAI_API_KEY", undefined);
    setEnvironmentValue(environment, "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "false");
  }
}

export function applyBenchDaemonEnvironment(
  environment: BenchDaemonEnvironment,
  managedEnvKeys: readonly string[]
): void {
  for (const key of managedEnvKeys) {
    setEnvValue(key, environment[key]);
  }
}

function setEnvironmentValue(
  environment: Record<string, string | undefined>,
  key: string,
  value: string | undefined
): void {
  if (value === undefined) delete environment[key];
  else environment[key] = value.trim();
}

function copyTreatmentValue(
  environment: Record<string, string | undefined>,
  ambientEnv: Readonly<Record<string, string | undefined>>,
  key: string
): void {
  setEnvironmentValue(environment, key, ambientEnv[key]);
}

function resolveLocalModelCacheRoot(
  env: Readonly<Record<string, string | undefined>>,
  explicitKey: "ALAYA_LOCAL_EMBEDDING_CACHE_DIR" | "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR"
): string {
  const explicit = env[explicitKey]?.trim();
  if (explicit) return resolve(explicit);
  const cacheHome = env.XDG_CACHE_HOME?.trim();
  const home = env.HOME?.trim() || homedir();
  return resolve(cacheHome || join(home, ".cache"), "do-soul-alaya", "models");
}

export function resolveSourceRefRobust(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return true;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error("ALAYA_RECALL_SOURCE_REF_ROBUST must be true, false, 1, or 0");
}

function setEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

export function requireBenchOpenAiSecretRef(secretRef: string): void {
  const resolved = resolveSecretRef(secretRef);
  if (!("kind" in resolved)) {
    return;
  }

  throw new Error(formatBenchEmbeddingSecretError(resolved));
}

function formatBenchEmbeddingSecretError(error: ResolveSecretError): string {
  const prefix = "--embedding env requires a resolvable ALAYA_OPENAI_SECRET_REF";
  switch (error.kind) {
    case "env_missing":
      return `${prefix}; missing environment variable ${error.var_name}`;
    case "empty":
      return `${prefix}; ${error.origin} secret is empty`;
    case "file_missing":
      return `${prefix}; referenced file is missing`;
    case "file_unreadable":
      return `${prefix}; referenced file is unreadable`;
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `${prefix}; keychain secret lookup failed`;
    case "malformed":
      return `${prefix}; secret ref is malformed`;
    default:
      return `${prefix}; secret resolution failed`;
  }
}

export async function closeBenchDaemonResources(resources: {
  readonly mcpClient?: { close(): Promise<unknown> };
  readonly server?: { close(): Promise<unknown> };
  readonly runtime?: { shutdown(): Promise<unknown> };
}): Promise<void> {
  if (resources.mcpClient !== undefined) {
    try {
      await resources.mcpClient.close();
    } catch (error) {
      emitBenchHarnessWarning("ALAYA_BENCH_MCP_CLIENT_CLOSE_FAILED", "mcp_client", error);
    }
  }
  if (resources.server !== undefined) {
    try {
      await resources.server.close();
    } catch (error) {
      emitBenchHarnessWarning("ALAYA_BENCH_SERVER_CLOSE_FAILED", "server", error);
    }
  }
  if (resources.runtime !== undefined) {
    try {
      await resources.runtime.shutdown();
    } catch (error) {
      emitBenchHarnessWarning("ALAYA_BENCH_RUNTIME_SHUTDOWN_FAILED", "runtime", error);
    }
  }
}

export function restoreEnv(
  keys: readonly string[],
  saved: Partial<Record<string, string | undefined>>
): void {
  for (const key of keys) {
    const prev = saved[key];
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}
