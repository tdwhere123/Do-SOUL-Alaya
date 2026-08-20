import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { safeProviderIdentityToken } from "@do-soul/alaya-engine-gateway";
import {
  markGardenHttpFailure,
  toBenchTransportFailureAttempt
} from "../../../../bench/compile-seed/http/garden-http-failure-attempt.js";

describe("garden HTTP failure attempt identity", () => {
  it("reuses the provider identity allowlist for Error.name and Error.code", () => {
    const safe = fingerprintOf(Object.assign(new Error("payload"), {
      name: "TypeError",
      code: "ECONNRESET"
    }));
    const numeric = fingerprintOf(Object.assign(new Error("payload"), {
      name: "TypeError",
      code: 12345
    }));
    const omitted = fingerprintOf(Object.assign(new Error("payload"), {
      name: "has space",
      code: "not/a/code"
    }));

    expect(safe).toBe(fingerprintBytes({
      errorName: safeProviderIdentityToken("TypeError"),
      errorCode: safeProviderIdentityToken("ECONNRESET")
    }));
    expect(numeric).toBe(fingerprintBytes({
      errorName: safeProviderIdentityToken("TypeError"),
      errorCode: safeProviderIdentityToken("12345")
    }));
    expect(omitted).toBe(fingerprintBytes({
      errorName: null,
      errorCode: null
    }));
    expect(omitted).not.toBe(safe);
  });
});

function fingerprintOf(error: Error): string {
  const attempt = toBenchTransportFailureAttempt(
    markGardenHttpFailure(error, { kind: "network_error", phase: "request" }),
    0
  );
  if (attempt === undefined) throw new Error("expected marked transport failure");
  return attempt.fingerprint;
}

function fingerprintBytes(input: {
  readonly errorName: string | null;
  readonly errorCode: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    kind: "network_error",
    phase: "request",
    httpStatus: null,
    errorName: input.errorName,
    errorCode: input.errorCode,
    providerCode: null,
    providerType: null,
    rawBodyDigest: null
  }), "utf8").digest("hex");
}
