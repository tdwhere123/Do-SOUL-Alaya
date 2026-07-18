import { afterEach, describe, expect, it } from "vitest";
import { normalizeRequestTimeoutMs } from "../../../runtime/recall-read-worker/client-config.js";

const timeoutEnvName = "ALAYA_RECALL_READ_WORKER_REQUEST_TIMEOUT_MS";
const originalTimeoutEnv = process.env[timeoutEnvName];

describe("recall read worker request timeout", () => {
  afterEach(() => {
    if (originalTimeoutEnv === undefined) delete process.env[timeoutEnvName];
    else process.env[timeoutEnvName] = originalTimeoutEnv;
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects an explicit Node timer delay outside the supported integer range: %s",
    (value) => {
      expect(() => normalizeRequestTimeoutMs(value)).toThrow(
        "recall read worker request timeout must be a safe integer between 1 and 2147483647"
      );
    }
  );

  it("rejects an invalid configured environment delay instead of silently using the default", () => {
    process.env[timeoutEnvName] = "0.5";
    expect(() => normalizeRequestTimeoutMs(undefined)).toThrow(
      "recall read worker request timeout must be a safe integer between 1 and 2147483647"
    );
  });

  it("uses the default only when neither an explicit nor environment delay is configured", () => {
    delete process.env[timeoutEnvName];
    expect(normalizeRequestTimeoutMs(undefined)).toBe(30_000);
  });
});
