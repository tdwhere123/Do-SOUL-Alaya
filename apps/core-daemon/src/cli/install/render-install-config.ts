import type { EmbeddingProviderKind, RuntimeGardenComputeConfig } from "@do-soul/alaya-protocol";
import { GARDEN_PROVIDER_KIND_ENV } from "./support.js";

export interface ResolvedInstallConfig {
  readonly db_path: string;
  readonly embedding_enabled: boolean;
  readonly embedding_provider: EmbeddingProviderKind;
  readonly provider_base_url: string | null;
  readonly model_id: string;
  readonly default_workspace: string;
  readonly worktree_enabled: boolean;
  readonly secret_ref: string | null;
  readonly garden_provider_kind: RuntimeGardenComputeConfig["provider_kind"] | null;
  readonly pasted_secret: Readonly<{ readonly path: string; readonly value: string }> | null;
}

export function renderAlayaToml(config: ResolvedInstallConfig): string {
  const lines = [
    "[storage]",
    `db_path = ${quoteTomlString(config.db_path)}`,
    "",
    "[runtime]",
    `default_workspace = ${quoteTomlString(config.default_workspace)}`,
    `worktree_enabled = ${config.worktree_enabled ? "true" : "false"}`,
    "",
    "[embedding]",
    `enabled = ${config.embedding_enabled ? "true" : "false"}`,
    `model_id = ${quoteTomlString(config.model_id)}`
  ];
  if (config.provider_base_url !== null) {
    lines.push(`provider_base_url = ${quoteTomlString(config.provider_base_url)}`);
  }
  return `${lines.join("\n")}\n`;
}

export const INSTALL_ENV_KEYS = [
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "ALAYA_EMBEDDING_PROVIDER",
  "ALAYA_LOCAL_EMBEDDING_MODEL", "ALAYA_OPENAI_SECRET_REF",
  "OPENAI_EMBEDDING_MODEL", "OPENAI_EMBEDDING_PROVIDER_URL", GARDEN_PROVIDER_KIND_ENV
] as const;

export function buildInstallEnvEntries(config: ResolvedInstallConfig): ReadonlyMap<string, string> {
  const entries = new Map([
    ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", config.embedding_enabled ? "true" : "false"],
    ["ALAYA_EMBEDDING_PROVIDER", config.embedding_provider]
  ]);
  if (config.embedding_provider === "local_onnx") {
    entries.set("ALAYA_LOCAL_EMBEDDING_MODEL", config.model_id);
  } else {
    if (config.secret_ref !== null) {
      entries.set("ALAYA_OPENAI_SECRET_REF", config.secret_ref);
    }
    entries.set("OPENAI_EMBEDDING_MODEL", config.model_id);
    if (config.provider_base_url !== null) {
      entries.set("OPENAI_EMBEDDING_PROVIDER_URL", config.provider_base_url);
    }
  }
  if (config.garden_provider_kind !== null) {
    entries.set(GARDEN_PROVIDER_KIND_ENV, config.garden_provider_kind);
  }
  return entries;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}
