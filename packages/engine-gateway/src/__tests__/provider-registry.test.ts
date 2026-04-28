import { describe, expect, it, vi } from "vitest";
import {
  EngineError,
  EngineErrorKind,
  EngineProvider,
  type EngineBinding
} from "@do-soul/alaya-protocol";
import {
  providerAdaptersDeferredMessage,
  readApiKey,
  resolveApiKey,
  resolveLanguageModel
} from "../provider/provider-registry.js";

function createBinding(overrides: Partial<EngineBinding> = {}): EngineBinding {
  return {
    binding_id: "binding-1",
    provider: EngineProvider.OPENAI,
    model: "gpt-4o-mini",
    base_url: null,
    api_key_ref: "OPENAI_API_KEY",
    config: {},
    ...overrides
  } as EngineBinding;
}

describe("provider registry skeleton", () => {
  it("fails closed instead of constructing deferred provider adapters", () => {
    expect(() =>
      resolveLanguageModel(createBinding(), (key) =>
        key === "OPENAI_API_KEY" ? "sk-openai" : undefined
      )
    ).toThrowError(
      new EngineError(providerAdaptersDeferredMessage, EngineErrorKind.MODEL_ERROR)
    );
  });

  it("does not read environment credentials while failing closed", () => {
    const getEnv = vi.fn().mockReturnValue("sk-openai");

    expect(() => resolveLanguageModel(createBinding(), getEnv)).toThrowError(
      providerAdaptersDeferredMessage
    );
    expect(getEnv).not.toHaveBeenCalled();
  });

  it("prefers inline api_key over getEnv", () => {
    const getEnv = vi.fn();

    const result = readApiKey(createBinding({
      api_key: "sk-inline",
      api_key_ref: "OPENAI_API_KEY"
    }), getEnv);

    expect(getEnv).not.toHaveBeenCalled();
    expect(result).toBe("sk-inline");
  });

  it("resolves api_key_ref from getEnv when inline api_key is absent", () => {
    const getEnv = vi.fn().mockReturnValue("sk-env");

    const result = resolveApiKey(createBinding({
      provider: EngineProvider.ANTHROPIC,
      model: "claude-sonnet-4-5",
      api_key_ref: "ANTHROPIC_API_KEY"
    }), getEnv);

    expect(getEnv).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
    expect(result).toBe("sk-env");
  });

  it("throws auth when both api_key and api_key_ref resolution are missing", () => {
    expect(() => resolveApiKey(createBinding({
      api_key: undefined,
      api_key_ref: undefined
    } as Partial<EngineBinding>), () => undefined)).toThrowError(
      new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH)
    );
  });
});
