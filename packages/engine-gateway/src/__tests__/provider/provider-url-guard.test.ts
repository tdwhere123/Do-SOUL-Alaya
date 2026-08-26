import { afterEach, describe, expect, it } from "vitest";
import { assertAllowedProviderChatUrl } from
  "../../provider/chat-completion/provider-url-guard.js";
import { providerChatCompletionsUrl } from
  "../../provider/chat-completion/request-body.js";

const ORIGINAL_REMOTE = process.env.ALAYA_ALLOW_REMOTE_DAEMON;
const ORIGINAL_PRIVATE = process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;

afterEach(() => {
  restoreEnv("ALAYA_ALLOW_REMOTE_DAEMON", ORIGINAL_REMOTE);
  restoreEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", ORIGINAL_PRIVATE);
});

describe("provider url guard", () => {
  it("does not restrict loopback-default provider URLs", () => {
    delete process.env.ALAYA_ALLOW_REMOTE_DAEMON;
    expect(providerChatCompletionsUrl("http://127.0.0.1:11434/v1"))
      .toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("requires https and rejects private hosts when remote daemon is allowed", () => {
    process.env.ALAYA_ALLOW_REMOTE_DAEMON = "1";
    delete process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;

    expect(() => providerChatCompletionsUrl("http://api.example/v1"))
      .toThrow(/must use https/u);
    expect(() => providerChatCompletionsUrl("https://127.0.0.1/v1"))
      .toThrow(/private, loopback, link-local, or metadata/u);
    expect(() => providerChatCompletionsUrl("https://169.254.169.254/v1"))
      .toThrow(/private, loopback, link-local, or metadata/u);
    expect(() => providerChatCompletionsUrl("https://10.0.0.8/v1"))
      .toThrow(/private, loopback, link-local, or metadata/u);
    expect(providerChatCompletionsUrl("https://api.example/v1"))
      .toBe("https://api.example/v1/chat/completions");
  });

  it("allows private https hosts only with the extra opt-in", () => {
    process.env.ALAYA_ALLOW_REMOTE_DAEMON = "1";
    process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = "1";
    expect(assertAllowedProviderChatUrl("https://127.0.0.1/v1/chat/completions")).toBeUndefined();
    expect(() => assertAllowedProviderChatUrl("http://127.0.0.1/v1/chat/completions"))
      .toThrow(/must use https/u);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
