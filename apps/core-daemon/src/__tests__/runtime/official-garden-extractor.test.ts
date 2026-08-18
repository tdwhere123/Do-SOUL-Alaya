import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS,
  fetchProviderChatCompletion
} from "@do-soul/alaya-engine-gateway";
import {
  createOfficialGardenExtractor,
  resolveVendorModelAlias
} from "../../runtime/garden-wiring/official-garden-extractor.js";

vi.mock("@do-soul/alaya-engine-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@do-soul/alaya-engine-gateway")>();
  return {
    ...actual,
    fetchProviderChatCompletion: vi.fn()
  };
});

const fetchMock = vi.mocked(fetchProviderChatCompletion);

afterEach(() => {
  fetchMock.mockReset();
});

describe("resolveVendorModelAlias", () => {
  it("remaps Mimo-V2.5 to vendor id mimo-v2.5 and profile mimo-v2.5-nonthinking-v1", () => {
    expect(resolveVendorModelAlias("Mimo-V2.5")).toEqual({
      id: "mimo-v2.5",
      profile: "mimo-v2.5-nonthinking-v1"
    });
  });

  it("leaves an unknown model unmapped with no request profile", () => {
    expect(resolveVendorModelAlias("unknown-garden-model")).toEqual({
      id: "unknown-garden-model"
    });
  });
});

describe("createOfficialGardenExtractor", () => {
  it("sends the remapped vendor id and table profile to the provider", async () => {
    fetchMock.mockResolvedValue({
      text: '{"signals":[]}',
      finishReason: "stop",
      httpStatus: 200
    });
    const extractor = createOfficialGardenExtractor({
      apiKey: "sk-test",
      model: "Mimo-V2.5",
      endpoint: "https://example.test/v1"
    });

    await extractor.extract({
      systemPrompt: "sys",
      userPrompt: "{}"
    });

    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
      model: "mimo-v2.5",
      profile: "mimo-v2.5-nonthinking-v1",
      timeoutMs: DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS
    }));
  });

  it("does not attach a request profile for an unknown model", async () => {
    fetchMock.mockResolvedValue({
      text: '{"signals":[]}',
      finishReason: "stop",
      httpStatus: 200
    });
    const extractor = createOfficialGardenExtractor({
      apiKey: "sk-test",
      model: "unknown-garden-model",
      endpoint: "https://example.test/v1"
    });

    await extractor.extract({
      systemPrompt: "sys",
      userPrompt: "{}"
    });

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request?.model).toBe("unknown-garden-model");
    expect(request?.profile).toBeUndefined();
  });
});
