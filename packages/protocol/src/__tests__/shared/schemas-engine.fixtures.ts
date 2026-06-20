import { EngineProvider } from "../../index.js";

export function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

export const validTimestamp = "2026-03-15T00:00:00.000Z";

export const engineBindingBase = {
  binding_id: "binding-1",
  provider: EngineProvider.OPENAI,
  base_url: null,
  model: "gpt-4o-mini",
  api_key_ref: "OPENAI_API_KEY",
  config: {}
} as const;

export const engineBindingInputBase = {
  provider_type: EngineProvider.OPENAI,
  base_url: null,
  api_key: "sk-openai",
  model: "gpt-4o-mini",
  config: {}
} as const;
