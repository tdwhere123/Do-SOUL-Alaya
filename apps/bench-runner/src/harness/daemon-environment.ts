import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  resolveSecretRef,
  type AlayaDaemonRuntime,
  type ResolveSecretError
} from "@do-soul/alaya";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind
} from "./daemon-types.js";
import { emitBenchHarnessWarning } from "./daemon-warnings.js";

export function resolveBenchOpenAiSecretRef(
  savedEnv: Partial<Record<string, string | undefined>>
): string {
  return savedEnv.ALAYA_OPENAI_SECRET_REF?.trim() || "env:OPENAI_API_KEY";
}

const DEFAULT_BENCH_REVIEWER_IDENTITY = "user:bench-runner";

export interface BenchReviewerCredentials {
  readonly identity: string;
  readonly token: string;
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

export function applyBenchDaemonEnvironment(input: {
  readonly dataDir: string;
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly effectiveOpenAiSecretRef: string;
  readonly savedEnv: Partial<Record<string, string | undefined>>;
  readonly reviewerCredentials: BenchReviewerCredentials;
}): void {
  const savedEnv = input.savedEnv;
  setEnvValue("DATA_DIR", input.dataDir);
  if (input.embeddingMode === "env") {
    setEnvValue("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true");
    if (input.embeddingProviderKind === "local_onnx") {
      setEnvValue("ALAYA_EMBEDDING_PROVIDER", "local_onnx");
      setEnvValue("ALAYA_LOCAL_EMBEDDING_CACHE_DIR", savedEnv.ALAYA_LOCAL_EMBEDDING_CACHE_DIR);
      setEnvValue("ALAYA_LOCAL_EMBEDDING_MODEL", savedEnv.ALAYA_LOCAL_EMBEDDING_MODEL);
      setEnvValue("ALAYA_OPENAI_SECRET_REF", "env:OPENAI_API_KEY");
      setEnvValue("OPENAI_API_KEY", "test-openai-key");
    } else {
      clearEnvValue("ALAYA_EMBEDDING_PROVIDER");
      clearEnvValue("ALAYA_LOCAL_EMBEDDING_CACHE_DIR");
      clearEnvValue("ALAYA_LOCAL_EMBEDDING_MODEL");
      setEnvValue("ALAYA_OPENAI_SECRET_REF", input.effectiveOpenAiSecretRef);
      setEnvValue("OPENAI_API_KEY", savedEnv.OPENAI_API_KEY);
    }
  } else {
    clearEnvValue("ALAYA_EMBEDDING_PROVIDER");
    clearEnvValue("ALAYA_LOCAL_EMBEDDING_CACHE_DIR");
    clearEnvValue("ALAYA_LOCAL_EMBEDDING_MODEL");
    setEnvValue("ALAYA_OPENAI_SECRET_REF", "env:OPENAI_API_KEY");
    setEnvValue("OPENAI_API_KEY", "test-openai-key");
    setEnvValue("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "false");
  }
  setEnvValue("ALAYA_CONFIG_DIR", join(input.dataDir, "config"));
  setEnvValue("CODEX_HOME", join(input.dataDir, "codex-home"));
  setEnvValue("HOME", join(input.dataDir, "home"));
  setEnvValue("ALAYA_REVIEWER_IDENTITY", input.reviewerCredentials.identity);
  setEnvValue("ALAYA_REVIEWER_TOKEN", input.reviewerCredentials.token);
  setEnvValue("ALAYA_RECALL_SOURCE_REF_ROBUST", savedEnv.ALAYA_RECALL_SOURCE_REF_ROBUST ?? "true");
}

function setEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function clearEnvValue(key: string): void {
  delete process.env[key];
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
  readonly mcpClient?: Client;
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
