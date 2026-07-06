import {
  EngineError,
  EngineErrorKind,
  type EngineBinding
} from "@do-soul/alaya-protocol";

export function readApiKey(
  binding: EngineBinding,
  getEnv: (key: string) => string | undefined = (key) => process.env[key]
): string | undefined {
  if ("api_key" in binding && typeof binding.api_key === "string" && binding.api_key.length > 0) {
    return binding.api_key;
  }

  const envName = "api_key_ref" in binding ? binding.api_key_ref : undefined;
  if (typeof envName === "string") {
    // Only allow environment variables ending with _API_KEY and not starting with ALAYA_
    if (/^[a-z0-9_]+_api_key$/i.test(envName) && !/^alaya_/i.test(envName)) {
      return getEnv(envName);
    }
  }
  return undefined;
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
