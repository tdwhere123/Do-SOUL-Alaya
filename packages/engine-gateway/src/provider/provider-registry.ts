import {
  EngineError,
  EngineErrorKind,
  type EngineBinding
} from "@do-soul/alaya-protocol";

export const providerAdaptersDeferredMessage =
  "Engine provider adapters are deferred to #BL-008.";

export function resolveLanguageModel(
  _binding: EngineBinding,
  _getEnv: (key: string) => string | undefined = (key) => process.env[key],
  _apiKeyOverride?: string
): never {
  throw new EngineError(providerAdaptersDeferredMessage, EngineErrorKind.MODEL_ERROR);
}

export function readApiKey(
  binding: EngineBinding,
  getEnv: (key: string) => string | undefined = (key) => process.env[key]
): string | undefined {
  if ("api_key" in binding && typeof binding.api_key === "string" && binding.api_key.length > 0) {
    return binding.api_key;
  }

  const envName = "api_key_ref" in binding ? binding.api_key_ref : undefined;
  return typeof envName === "string" ? getEnv(envName) : undefined;
}

export function resolveApiKey(
  binding: EngineBinding,
  getEnv: (key: string) => string | undefined
): string {
  const apiKey = readApiKey(binding, getEnv);

  if (!apiKey) {
    throw new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH);
  }

  return apiKey;
}
