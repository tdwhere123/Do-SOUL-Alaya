import { resolveSecretRef, type ResolveSecretError, type ResolvedSecret } from "./secrets.js";

export type GardenCredentialProvenance = Readonly<{
  readonly kind: "env" | "file" | "embedding-fallback" | "none";
}>;

export const ALAYA_GARDEN_OPENAI_SECRET_REF_ENV = "ALAYA_GARDEN_OPENAI_SECRET_REF";
export const ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV = "ALAYA_OPENAI_SECRET_REF";

export function selectGardenCredentialProvenance(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly configEnv: ReadonlyMap<string, string>;
}): GardenCredentialProvenance {
  const dedicatedRef = readConfigValue(input.env, input.configEnv, ALAYA_GARDEN_OPENAI_SECRET_REF_ENV);

  if (dedicatedRef !== null) {
    return { kind: secretRefKind(dedicatedRef) ?? "file" };
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
  const dedicatedRef = readConfigValue(env, input.configEnv, ALAYA_GARDEN_OPENAI_SECRET_REF_ENV);

  if (dedicatedRef !== null) {
    const resolved = resolveSecretRefOrThrow(dedicatedRef, ALAYA_GARDEN_OPENAI_SECRET_REF_ENV);
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

  const resolved = resolveSecretRefOrThrow(embeddingFallbackRef, ALAYA_EMBEDDING_OPENAI_SECRET_REF_ENV);
  return {
    apiKey: resolved.value,
    provenance: { kind: "embedding-fallback" }
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

function secretRefKind(secretRef: string): "env" | "file" | null {
  if (secretRef.startsWith("env:")) {
    return "env";
  }

  if (secretRef.startsWith("file:")) {
    return "file";
  }

  return null;
}

function resolveSecretRefOrThrow(secretRef: string, label: string): ResolvedSecret {
  const resolved = resolveSecretRef(secretRef);
  if ("kind" in resolved) {
    throw new Error(formatSecretResolutionError(label, resolved));
  }

  return resolved;
}

function formatSecretResolutionError(label: string, error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `${label}: ${error.ref} -> ${error.reason}`;
    case "env_missing":
      return `${label}: ${error.ref} -> environment variable ${error.var_name} is not set`;
    case "file_missing":
      return `${label}: ${error.ref} -> file not found at ${error.path}`;
    case "file_unreadable":
      return `${label}: ${error.ref} -> file unreadable at ${error.path} (${error.cause})`;
    case "empty":
      return `${label}: ${error.ref} -> ${error.origin} secret is empty`;
  }
}
