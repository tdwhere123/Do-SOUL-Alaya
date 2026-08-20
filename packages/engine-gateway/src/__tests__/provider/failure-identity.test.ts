import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  providerFailureIdentityFromBody,
  safeProviderIdentityToken
} from "../../provider/chat-completion/index.js";

describe("safeProviderIdentityToken", () => {
  it("keeps allowlisted tokens and drops the rest", () => {
    expect(safeProviderIdentityToken("ECONNRESET")).toBe("ECONNRESET");
    expect(safeProviderIdentityToken("provider.error:1")).toBe("provider.error:1");
    expect(safeProviderIdentityToken("600003")).toBe("600003");
    expect(safeProviderIdentityToken("a".repeat(128))).toBe("a".repeat(128));
    expect(safeProviderIdentityToken("")).toBeNull();
    expect(safeProviderIdentityToken("has space")).toBeNull();
    expect(safeProviderIdentityToken("slash/token")).toBeNull();
    expect(safeProviderIdentityToken("a".repeat(129))).toBeNull();
  });

  it("applies the same allowlist to provider code and type", () => {
    expect(providerFailureIdentityFromBody(JSON.stringify({
      error: { code: "not a token", type: "provider_error" }
    }))).toEqual({
      providerCode: null,
      providerType: "provider_error",
      bodyDigest: null
    });

    const rawBody = JSON.stringify({
      error: { code: "not a token", type: "also bad!" }
    });
    expect(providerFailureIdentityFromBody(rawBody)).toEqual({
      providerCode: null,
      providerType: null,
      bodyDigest: createHash("sha256").update(rawBody, "utf8").digest("hex")
    });
  });
});
