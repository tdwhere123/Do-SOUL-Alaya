import { describe, expect, it, vi } from "vitest";
import {
  EngineError,
  EngineErrorKind,
  EngineProvider,
  type EngineBinding
} from "@do-soul/alaya-protocol";
import {
  readApiKey,
  resolveApiKey
} from "../../provider/provider-registry.js";

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

  it("falls back to api_key_ref when inline api_key is empty", () => {
    const getEnv = vi.fn().mockReturnValue("sk-env");

    expect(resolveApiKey(createBinding({
      api_key: "",
      api_key_ref: "OPENAI_API_KEY"
    } as Partial<EngineBinding>), getEnv)).toBe("sk-env");
    expect(getEnv).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  it("does not read env when api_key_ref is null", () => {
    const getEnv = vi.fn().mockReturnValue("sk-env");

    expect(readApiKey(createBinding({
      api_key: undefined,
      api_key_ref: null
    } as Partial<EngineBinding>), getEnv)).toBeUndefined();
    expect(getEnv).not.toHaveBeenCalled();
  });

  it("throws auth when api_key_ref resolves to an empty string", () => {
    expect(() => resolveApiKey(createBinding({
      api_key_ref: "EMPTY_KEY"
    }), () => "")).toThrowError(
      new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH)
    );
  });

  it("throws auth when both api_key and api_key_ref resolution are missing", () => {
    expect(() => resolveApiKey(createBinding({
      api_key: undefined,
      api_key_ref: undefined
    } as Partial<EngineBinding>), () => undefined)).toThrowError(
      new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH)
    );
  });

  it("rejects api_key_ref referencing non-API-key variables or ALAYA_ variables", () => {
    const getEnv = vi.fn().mockReturnValue("sensitive-token");

    // Block ALAYA_ variable
    expect(readApiKey(createBinding({
      api_key: undefined,
      api_key_ref: "ALAYA_MCP_TOOL_CONFIRMATION_TOKEN"
    }), getEnv)).toBeUndefined();

    // Block non-API-key variable
    expect(readApiKey(createBinding({
      api_key: undefined,
      api_key_ref: "PATH"
    }), getEnv)).toBeUndefined();

    expect(getEnv).not.toHaveBeenCalled();
  });
});
