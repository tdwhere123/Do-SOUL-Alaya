import { resolveSecretRef, type SecretRefReader, type ResolveSecretError } from "@do-soul/alaya";

export interface EmbeddingProviderPreflightResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface EmbeddingProviderPreflightOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly secretRefReader?: SecretRefReader;
  readonly timeoutMs?: number;
}

const DEFAULT_EMBEDDING_PROVIDER_URL = "https://api.openai.com/v1";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export async function preflightEmbeddingProvider(
  options: EmbeddingProviderPreflightOptions = {}
): Promise<EmbeddingProviderPreflightResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const secretRef = env.ALAYA_OPENAI_SECRET_REF?.trim() || "env:OPENAI_API_KEY";
  const resolved =
    options.secretRefReader === undefined
      ? resolveSecretRef(secretRef)
      : resolveSecretRef(secretRef, options.secretRefReader);
  if ("kind" in resolved) {
    return {
      ok: false,
      message: formatSecretResolutionPreflightFailure(resolved)
    };
  }

  const baseUrl = (env.OPENAI_EMBEDDING_PROVIDER_URL?.trim() || DEFAULT_EMBEDDING_PROVIDER_URL).replace(/\/+$/, "");
  const model = env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return {
      ok: false,
      message: "embedding provider preflight failed: provider URL is malformed"
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  timeout.unref?.();
  try {
    const response = await fetchImpl(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resolved.value}`
      },
      body: JSON.stringify({ model, input: ["alaya embedding preflight"] }),
      signal: controller.signal
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `embedding provider preflight failed: host=${host} status=${response.status}`
      };
    }
    return {
      ok: true,
      message: `embedding provider preflight ok: host=${host} model=${model}`
    };
  } catch (error) {
    const causeCode =
      typeof error === "object" &&
      error !== null &&
      "cause" in error &&
      typeof (error as { readonly cause?: { readonly code?: unknown } }).cause?.code === "string"
        ? ` cause=${(error as { readonly cause: { readonly code: string } }).cause.code}`
        : "";
    return {
      ok: false,
      message: `embedding provider preflight failed: host=${host}${causeCode}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatSecretResolutionPreflightFailure(error: ResolveSecretError): string {
  const prefix = "embedding provider preflight failed";
  switch (error.kind) {
    case "malformed":
      return `${prefix}: secret_ref is malformed`;
    case "env_missing":
      return `${prefix}: missing environment variable ${error.var_name}`;
    case "empty":
      return `${prefix}: ${error.origin} secret is empty`;
    case "file_missing":
      return `${prefix}: referenced file is missing`;
    case "file_unreadable":
      return `${prefix}: referenced file is unreadable`;
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `${prefix}: keychain secret lookup failed`;
  }
}
