import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import {
  EngineError,
  EngineErrorKind,
  EngineProvider,
  type EngineBinding
} from "@do-what/protocol";

const openAIFactoryMock = vi.hoisted(() => vi.fn());
const anthropicFactoryMock = vi.hoisted(() => vi.fn());

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: openAIFactoryMock
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: anthropicFactoryMock
}));

import { resolveLanguageModel } from "../provider/provider-registry.js";

function createLanguageModel(modelId: string): LanguageModel {
  return { modelId } as unknown as LanguageModel;
}

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

describe("resolveLanguageModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an OpenAI chat model for openai bindings", () => {
    const model = createLanguageModel("openai-chat");
    const chat = vi.fn().mockReturnValue(model);

    openAIFactoryMock.mockReturnValue({ chat });

    const result = resolveLanguageModel(createBinding(), key => (
      key === "OPENAI_API_KEY" ? "sk-openai" : undefined
    ));

    expect(openAIFactoryMock).toHaveBeenCalledWith({
      apiKey: "sk-openai",
      baseURL: undefined
    });
    expect(chat).toHaveBeenCalledWith("gpt-4o-mini");
    expect(result).toBe(model);
  });

  it("returns an Anthropic language model for anthropic bindings", () => {
    const model = createLanguageModel("anthropic-language-model");
    const languageModel = vi.fn().mockReturnValue(model);

    anthropicFactoryMock.mockReturnValue({ languageModel });

    const result = resolveLanguageModel(
      createBinding({
        provider: EngineProvider.ANTHROPIC,
        model: "claude-sonnet-4-5",
        api_key_ref: "ANTHROPIC_API_KEY"
      }),
      key => (key === "ANTHROPIC_API_KEY" ? "sk-anthropic" : undefined)
    );

    expect(anthropicFactoryMock).toHaveBeenCalledWith({
      apiKey: "sk-anthropic"
    });
    expect(languageModel).toHaveBeenCalledWith("claude-sonnet-4-5");
    expect(result).toBe(model);
  });

  it("returns an OpenAI-compatible chat model for custom bindings with a base_url", () => {
    const model = createLanguageModel("custom-chat");
    const chat = vi.fn().mockReturnValue(model);

    openAIFactoryMock.mockReturnValue({ chat });

    const result = resolveLanguageModel(createBinding({
      provider: EngineProvider.CUSTOM,
      model: "custom-model",
      base_url: "https://proxy.example/v1",
      api_key_ref: "CUSTOM_API_KEY"
    }), key => (key === "CUSTOM_API_KEY" ? "sk-custom" : undefined));

    expect(openAIFactoryMock).toHaveBeenCalledWith({
      apiKey: "sk-custom",
      baseURL: "https://proxy.example/v1"
    });
    expect(chat).toHaveBeenCalledWith("custom-model");
    expect(result).toBe(model);
  });

  it("rejects base_url overrides for openai bindings", () => {
    expect(() => resolveLanguageModel(createBinding({
      base_url: "https://proxy.example/v1",
      api_key: "sk-openai",
      api_key_ref: undefined
    }))).toThrowError(
      new EngineError(
        "OpenAI bindings do not accept a base URL override.",
        EngineErrorKind.MODEL_ERROR
      )
    );
  });

  it("rejects base_url overrides for anthropic bindings", () => {
    expect(() => resolveLanguageModel(createBinding({
      provider: EngineProvider.ANTHROPIC,
      base_url: "https://proxy.example/v1",
      api_key: "sk-anthropic",
      api_key_ref: undefined
    }))).toThrowError(
      new EngineError(
        "Anthropic bindings do not accept a base URL override.",
        EngineErrorKind.MODEL_ERROR
      )
    );
  });

  it("throws model_error when a custom binding omits base_url", () => {
    expect(() => resolveLanguageModel(createBinding({
      provider: EngineProvider.CUSTOM,
      api_key: "sk-custom",
      api_key_ref: undefined
    }))).toThrowError(
      new EngineError("Custom providers require a base URL.", EngineErrorKind.MODEL_ERROR)
    );
  });

  it.each([
    "http://proxy.example/v1",
    "https://localhost/v1",
    "https://localhost./v1",
    "https://localhost../v1",
    "https://foo.localhost./v1",
    "https://foo.localhost../v1",
    "https://127.0.0.1/v1",
    "https://10.0.0.1/v1",
    "https://172.16.0.1/v1",
    "https://172.31.255.255/v1",
    "https://192.168.1.20/v1",
    "https://100.64.0.1/v1",
    "https://100.127.255.255/v1",
    "https://169.254.169.254/v1",
    "https://2130706433/v1",
    "https://0x7f.1/v1",
    "https://[::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::]/v1",
    "https://[0000:0000:0000:0000:0000:0000:0000:0000]/v1",
    "https://[0000:0000:0000:0000:0000:0000:0000:0001]/v1",
    "https://[fc00::1]/v1",
    "https://[fdff::1]/v1",
    "https://[fe80::1]/v1",
    "https://[0000:0000:0000:0000:0000:ffff:127.0.0.1]/v1"
  ])("rejects unsafe custom base_url values: %s", (baseUrl) => {
    expect(() => resolveLanguageModel(createBinding({
      provider: EngineProvider.CUSTOM,
      base_url: baseUrl,
      api_key: "sk-custom",
      api_key_ref: undefined
    }))).toThrowError(
      new EngineError(
        "Custom providers require a public HTTPS base URL.",
        EngineErrorKind.MODEL_ERROR
      )
    );
  });

  it("allows unsafe custom base_url values only behind the explicit local-test opt-in", () => {
    const model = createLanguageModel("custom-local-chat");
    const chat = vi.fn().mockReturnValue(model);
    const getEnv = vi.fn((key: string) =>
      key === "CUSTOM_API_KEY"
        ? "sk-custom"
        : key === "DO_WHAT_ALLOW_UNSAFE_CUSTOM_PROVIDER_BASE_URL"
          ? "1"
          : undefined
    );

    openAIFactoryMock.mockReturnValue({ chat });

    const result = resolveLanguageModel(createBinding({
      provider: EngineProvider.CUSTOM,
      model: "custom-local-model",
      base_url: "http://127.0.0.1:4111/v1",
      api_key_ref: "CUSTOM_API_KEY"
    }), getEnv);

    expect(openAIFactoryMock).toHaveBeenCalledWith({
      apiKey: "sk-custom",
      baseURL: "http://127.0.0.1:4111/v1"
    });
    expect(chat).toHaveBeenCalledWith("custom-local-model");
    expect(result).toBe(model);
  });

  it("keeps non-loopback custom base_url values blocked even when local-test opt-in is set", () => {
    const getEnv = vi.fn((key: string) =>
      key === "CUSTOM_API_KEY"
        ? "sk-custom"
        : key === "DO_WHAT_ALLOW_UNSAFE_CUSTOM_PROVIDER_BASE_URL"
          ? "1"
          : undefined
    );

    expect(() => resolveLanguageModel(createBinding({
      provider: EngineProvider.CUSTOM,
      model: "custom-local-model",
      base_url: "http://169.254.169.254/v1",
      api_key_ref: "CUSTOM_API_KEY"
    }), getEnv)).toThrowError(
      new EngineError(
        "Custom providers require a public HTTPS base URL.",
        EngineErrorKind.MODEL_ERROR
      )
    );
  });

  it("prefers inline api_key over getEnv", () => {
    const model = createLanguageModel("openai-inline");
    const chat = vi.fn().mockReturnValue(model);
    const getEnv = vi.fn();

    openAIFactoryMock.mockReturnValue({ chat });

    const result = resolveLanguageModel(createBinding({
      api_key: "sk-inline",
      api_key_ref: "OPENAI_API_KEY"
    }), getEnv);

    expect(getEnv).not.toHaveBeenCalled();
    expect(openAIFactoryMock).toHaveBeenCalledWith({
      apiKey: "sk-inline",
      baseURL: undefined
    });
    expect(result).toBe(model);
  });

  it("resolves api_key_ref from getEnv when inline api_key is absent", () => {
    const model = createLanguageModel("anthropic-env");
    const languageModel = vi.fn().mockReturnValue(model);
    const getEnv = vi.fn().mockReturnValue("sk-env");

    anthropicFactoryMock.mockReturnValue({ languageModel });

    const result = resolveLanguageModel(createBinding({
      provider: EngineProvider.ANTHROPIC,
      model: "claude-sonnet-4-5",
      api_key_ref: "ANTHROPIC_API_KEY"
    }), getEnv);

    expect(getEnv).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
    expect(result).toBe(model);
  });

  it("throws auth when both api_key and api_key_ref resolution are missing", () => {
    expect(() => resolveLanguageModel(createBinding({
      api_key: undefined,
      api_key_ref: undefined
    } as Partial<EngineBinding>), () => undefined)).toThrowError(
      new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH)
    );
  });
});
