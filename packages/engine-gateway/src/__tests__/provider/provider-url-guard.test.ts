import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAllowedProviderChatUrl,
  assertAllowedProviderChatUrlResolved
} from
  "../../provider/chat-completion/provider-url-guard.js";
import { providerChatCompletionsUrl } from
  "../../provider/chat-completion/request-body.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
    const answer = { address: "93.184.216.34", family: 4 };
    return options?.all === true ? [answer] : answer;
  })
}));

const ORIGINAL_REMOTE = process.env.ALAYA_ALLOW_REMOTE_DAEMON;
const ORIGINAL_PRIVATE = process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;

afterEach(() => {
  restoreEnv("ALAYA_ALLOW_REMOTE_DAEMON", ORIGINAL_REMOTE);
  restoreEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", ORIGINAL_PRIVATE);
});

describe("provider url guard", () => {
  it("rejects private and metadata hosts even on the default local daemon", () => {
    delete process.env.ALAYA_ALLOW_REMOTE_DAEMON;
    delete process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;

    expect(() => providerChatCompletionsUrl("http://127.0.0.1:11434/v1"))
      .toThrow(/private, loopback, link-local, or metadata/u);
    expect(() => providerChatCompletionsUrl("http://169.254.169.254/v1"))
      .toThrow(/private, loopback, link-local, or metadata/u);
    expect(() => providerChatCompletionsUrl("http://10.0.0.8/v1"))
      .toThrow(/private, loopback, link-local, or metadata/u);
    expect(providerChatCompletionsUrl("https://api.example/v1"))
      .toBe("https://api.example/v1/chat/completions");
  });

  it("rejects non-http(s) provider URLs", () => {
    delete process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;
    expect(() => assertAllowedProviderChatUrl("file:///etc/passwd")).toThrow(/http or https/u);
    expect(() => assertAllowedProviderChatUrl("not-a-url")).toThrow(/invalid/u);
  });

  it("allows private http hosts only with the extra opt-in", () => {
    delete process.env.ALAYA_ALLOW_REMOTE_DAEMON;
    process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL = "1";
    expect(assertAllowedProviderChatUrl("http://127.0.0.1/v1/chat/completions")).toBeUndefined();
    expect(assertAllowedProviderChatUrl("https://169.254.169.254/v1")).toBeUndefined();
  });

  it("rejects IPv6-mapped private literals before fetch", () => {
    delete process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;
    expect(() => assertAllowedProviderChatUrl("http://[::ffff:a9fe:a9fe]/v1")).toThrow(
      /private, loopback, link-local, or metadata/u
    );
    expect(() => assertAllowedProviderChatUrl("http://[::ffff:7f00:1]/v1")).toThrow(
      /private, loopback, link-local, or metadata/u
    );
  });

  it("rejects a hostname that resolves to a private address", async () => {
    delete process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;
    vi.mocked(lookup).mockImplementationOnce((async () => [
      { address: "169.254.169.254", family: 4 }
    ]) as unknown as typeof lookup);
    await expect(
      assertAllowedProviderChatUrlResolved("https://169.254.169.254.nip.io/v1")
    ).rejects.toThrow(/private, loopback, link-local, or metadata/u);
  });

  it("fails closed when the provider hostname cannot be resolved", async () => {
    delete process.env.ALAYA_ALLOW_PRIVATE_PROVIDER_URL;
    vi.mocked(lookup).mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(
      assertAllowedProviderChatUrlResolved("https://missing.example/v1")
    ).rejects.toThrow(/could not be resolved/u);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
