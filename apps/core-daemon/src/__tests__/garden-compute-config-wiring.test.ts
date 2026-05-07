import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV,
  OFFICIAL_API_GARDEN_MODEL_ENV,
  OFFICIAL_API_GARDEN_PROVIDER_URL_ENV,
  readOfficialGardenModelId,
  readOfficialGardenProviderUrl,
  readOfficialGardenSecretRef
} from "../daemon-runtime-support.js";

/**
 * C1 wiring tests — verify the env readers honour the new
 * Garden-compute-only env vars introduced by Codex's diagnostic finding
 * B-PL1 (Garden config previously piggy-backed on embedding's secret).
 *
 * `readOfficialGardenSecretRef` resolves env: refs against process.env, so
 * tests that pass an env: ref must seed the corresponding key.
 */
describe("Garden compute env readers (C1)", () => {
  const seededKeys = new Set<string>();
  beforeEach(() => {
    seededKeys.clear();
  });
  afterEach(() => {
    for (const key of seededKeys) {
      delete process.env[key];
    }
  });
  function seedProcessEnv(key: string, value: string): void {
    process.env[key] = value;
    seededKeys.add(key);
  }

  it("reads ALAYA_OFFICIAL_GARDEN_SECRET_REF as the dedicated Garden key source", () => {
    seedProcessEnv("GARDEN_API_KEY", "sk-test-garden");
    const env = new Map([
      [ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "env:GARDEN_API_KEY"]
    ]);
    // Resolved value is the secret value (not the env: ref) — the resolver
    // walks the process.env to fetch the actual key.
    expect(readOfficialGardenSecretRef(env)).toBe("sk-test-garden");
  });

  it("returns null when the dedicated Garden secret_ref env is absent", () => {
    const env = new Map([
      ["ALAYA_OPENAI_SECRET_REF", "env:OPENAI_API_KEY"]
    ]);
    expect(readOfficialGardenSecretRef(env)).toBeNull();
  });

  it("returns null for an empty/whitespace Garden secret_ref env", () => {
    const env = new Map([[ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "   "]]);
    expect(readOfficialGardenSecretRef(env)).toBeNull();
  });

  it("rejects malformed secret_ref values via readOptionalSecretRef shape rules", () => {
    const env = new Map([
      [ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV, "this-has-no-prefix"]
    ]);
    expect(() => readOfficialGardenSecretRef(env)).toThrow();
  });

  it("reads OFFICIAL_API_GARDEN_MODEL when the operator overrides the default model", () => {
    const env = new Map([[OFFICIAL_API_GARDEN_MODEL_ENV, "gpt-4o-mini"]]);
    expect(readOfficialGardenModelId(env)).toBe("gpt-4o-mini");
  });

  it("returns null when OFFICIAL_API_GARDEN_MODEL is absent", () => {
    expect(readOfficialGardenModelId(new Map())).toBeNull();
  });

  it("reads OFFICIAL_API_GARDEN_PROVIDER_URL when set", () => {
    const env = new Map([
      [OFFICIAL_API_GARDEN_PROVIDER_URL_ENV, "https://garden.example.test/v1"]
    ]);
    expect(readOfficialGardenProviderUrl(env)).toBe(
      "https://garden.example.test/v1"
    );
  });

  it("returns null when OFFICIAL_API_GARDEN_PROVIDER_URL is absent", () => {
    expect(readOfficialGardenProviderUrl(new Map())).toBeNull();
  });
});
