import { readFileSync } from "node:fs";
import { secretRefScheme } from "@do-soul/alaya-protocol";
import { resolveSecretRef, type ResolveSecretError, type ResolvedSecret } from "../secrets/index.js";
import { readPlatformKeychainSecret } from "../secrets/keychain/index.js";

export type GardenCredentialProvenance = Readonly<{
  readonly kind: "env" | "file" | "keychain" | "embedding-fallback" | "none";
}>;

export const ALAYA_GARDEN_OPENAI_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
export const ALAYA_LEGACY_GARDEN_OPENAI_SECRET_REF_ENV = "ALAYA_GARDEN_OPENAI_SECRET_REF";
export const ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV = "ALAYA_OPENAI_SECRET_REF";

export function selectGardenCredentialProvenance(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly configEnv: ReadonlyMap<string, string>;
}): GardenCredentialProvenance {
  const dedicatedRef = readFirstConfigValue(input.env, input.configEnv, [
    ALAYA_GARDEN_OPENAI_SECRET_REF_ENV,
    ALAYA_LEGACY_GARDEN_OPENAI_SECRET_REF_ENV
  ]);

  if (dedicatedRef !== null) {
    return { kind: secretRefScheme(dedicatedRef) ?? "file" };
  }

  const embeddingFallbackRef = readConfigValue(input.env, input.configEnv, ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV);
  return embeddingFallbackRef === null
    ? { kind: "none" }
    : { kind: "embedding-fallback" };
}

export function resolveGardenOpenAiCredential(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly configEnv: ReadonlyMap<string, string>;
}): Readonly<{
  readonly apiKey: string | null;
  readonly provenance: GardenCredentialProvenance;
}> {
  const env = input.env ?? process.env;
  const dedicatedRef = readFirstConfigValue(env, input.configEnv, [
    ALAYA_GARDEN_OPENAI_SECRET_REF_ENV,
    ALAYA_LEGACY_GARDEN_OPENAI_SECRET_REF_ENV
  ]);

  if (dedicatedRef !== null) {
    const resolved = resolveSecretRefOrNull(dedicatedRef, ALAYA_GARDEN_OPENAI_SECRET_REF_ENV, env);
    if (resolved === null) {
      return {
        apiKey: null,
        provenance: { kind: "none" }
      };
    }
    return {
      apiKey: resolved.value,
      provenance: { kind: resolved.origin }
    };
  }

  const embeddingFallbackRef = readConfigValue(env, input.configEnv, ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV);
  if (embeddingFallbackRef === null) {
    return {
      apiKey: null,
      provenance: { kind: "none" }
    };
  }

  const resolved = resolveSecretRefOrNull(embeddingFallbackRef, ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV, env);
  if (resolved === null) {
    return {
      apiKey: null,
      provenance: { kind: "embedding-fallback" }
    };
  }
  return {
    apiKey: resolved.value,
    provenance: { kind: "embedding-fallback" }
  };
}

function readFirstConfigValue(
  env: NodeJS.ProcessEnv,
  configEnv: ReadonlyMap<string, string>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = readConfigValue(env, configEnv, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function readConfigValue(
  env: NodeJS.ProcessEnv,
  configEnv: ReadonlyMap<string, string>,
  key: string
): string | null {
  const value = env[key] ?? configEnv.get(key);
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function resolveSecretRefOrNull(
  secretRef: string,
  label: string,
  env: NodeJS.ProcessEnv
): ResolvedSecret | null {
  const resolved = resolveSecretRef(secretRef, {
    readEnv: (name) => env[name],
    readFile: (filePath) => readFileSync(filePath, "utf8"),
    readKeychain: (service, account) => readPlatformKeychainSecret(service, account)
  });
  if ("kind" in resolved) {
    if (resolved.kind === "malformed" || resolved.kind === "empty") {
      throw new Error(formatSecretResolutionError(label, resolved));
    }

    return null;
  }

  return resolved;
}

function formatSecretResolutionError(label: string, error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `${label}: ${error.ref} -> ${error.reason}`;
    case "empty":
      return `${label}: ${error.ref} -> ${error.origin} secret is empty`;
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `${label}: ${error.ref} -> ${error.reason}`;
    case "env_missing":
    case "file_missing":
    case "file_unreadable":
      return `${label}: ${error.ref} -> secret is unavailable`;
  }
}
