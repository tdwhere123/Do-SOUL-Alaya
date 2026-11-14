import { readFileSync } from "node:fs";
import { secretRefScheme } from "@do-soul/alaya-protocol";
import { resolveSecretRef, type ResolveSecretError, type ResolvedSecret } from "../../secrets/index.js";
import { readPlatformKeychainSecret } from "../../secrets/keychain/index.js";
import { processEnvLookup } from "../../runtime/config/daemon-config-environment.js";

export type GardenCredentialProvenance = Readonly<{
  readonly kind: "env" | "file" | "keychain" | "embedding-fallback" | "none";
}>;

export const ALAYA_GARDEN_OPENAI_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
export const ALAYA_LEGACY_GARDEN_OPENAI_SECRET_REF_ENV = "ALAYA_GARDEN_OPENAI_SECRET_REF";
export const ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV = "ALAYA_OPENAI_SECRET_REF";

/** Per-key source precedence belongs to the caller; credential priority does not. */
export function selectGardenSecretRef(read: (key: string) => string | null | undefined): Readonly<{
  ref: string;
  embeddingFallback: boolean;
}> | null {
  for (const key of [
    ALAYA_GARDEN_OPENAI_SECRET_REF_ENV,
    ALAYA_LEGACY_GARDEN_OPENAI_SECRET_REF_ENV,
    ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV
  ]) {
    const ref = read(key)?.trim();
    if (ref) return { ref, embeddingFallback: key === ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV };
  }
  return null;
}

export function selectGardenCredentialProvenance(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly configEnv: ReadonlyMap<string, string>;
}): GardenCredentialProvenance {
  const selected = selectGardenSecretRef((key) => readConfigValue(input.env, input.configEnv, key));
  if (selected === null) return { kind: "none" };
  return { kind: selected.embeddingFallback ? "embedding-fallback" : secretRefScheme(selected.ref) ?? "file" };
}

export function resolveGardenOpenAiCredential(input: {
  readonly env?: NodeJS.ProcessEnv;
  readonly configEnv: ReadonlyMap<string, string>;
}): Readonly<{
  readonly apiKey: string | null;
  readonly provenance: GardenCredentialProvenance;
}> {
  const env = input.env ?? processEnvLookup();
  const selected = selectGardenSecretRef((key) => readConfigValue(env, input.configEnv, key));
  if (selected === null) return { apiKey: null, provenance: { kind: "none" } };
  const label = selected.embeddingFallback
    ? ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV : ALAYA_GARDEN_OPENAI_SECRET_REF_ENV;
  const resolved = resolveSecretRefOrNull(selected.ref, label, env);
  return {
    apiKey: resolved?.value ?? null,
    provenance: { kind: selected.embeddingFallback ? "embedding-fallback" : resolved?.origin ?? "none" }
  };
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
