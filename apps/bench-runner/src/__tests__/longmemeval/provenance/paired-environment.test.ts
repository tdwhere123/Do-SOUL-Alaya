import { describe, expect, it } from "vitest";
import {
  collectPairedEnvironment,
  resolveCredentialStateMarker
} from "../../../longmemeval/provenance/paired-environment.js";

describe("paired-environment bench provenance", () => {
  it("resolves credential state markers correctly without leaking secret values", () => {
    expect(resolveCredentialStateMarker(undefined)).toBe("unset");
    expect(resolveCredentialStateMarker("")).toBe("empty");
    expect(resolveCredentialStateMarker("   ")).toBe("empty");
    expect(resolveCredentialStateMarker("secret:my-vault-ref")).toBe("configured");
    expect(resolveCredentialStateMarker("sk-proj-1234567890")).toBe("configured");
  });

  it("records non-authoritative launch credential markers without secret values", () => {
    const ruleOnlyEnv = collectPairedEnvironment({
      ALAYA_ENABLE_GARDEN_OFFICIAL: "false",
      OFFICIAL_API_GARDEN_PROVIDER_URL: "https://api.fshencoding.cn/v1",
      ALAYA_OFFICIAL_GARDEN_SECRET_REF: "",
      ALAYA_OFFICIAL_GARDEN_API_KEY: ""
    });

    const liveGardenEnv = collectPairedEnvironment({
      ALAYA_ENABLE_GARDEN_OFFICIAL: "true",
      OFFICIAL_API_GARDEN_PROVIDER_URL: "https://api.fshencoding.cn/v1",
      ALAYA_OFFICIAL_GARDEN_SECRET_REF: "env:GARDEN_KEY",
      ALAYA_OFFICIAL_GARDEN_API_KEY: "sk-live-secret-key-999"
    });

    expect(ruleOnlyEnv.ALAYA_ENABLE_GARDEN_OFFICIAL).toBe("false");
    expect(liveGardenEnv.ALAYA_ENABLE_GARDEN_OFFICIAL).toBe("true");
    expect(ruleOnlyEnv).not.toEqual(liveGardenEnv);

    // Launch markers are diagnostic only; runtime provenance carries the effective basis.
    expect(ruleOnlyEnv.OFFICIAL_API_GARDEN_PROVIDER_URL).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(ruleOnlyEnv.OFFICIAL_API_GARDEN_PROVIDER_URL).not.toContain("https://");

    expect(ruleOnlyEnv.ALAYA_OFFICIAL_GARDEN_SECRET_REF_STATE).toBe("empty");
    expect(ruleOnlyEnv.ALAYA_OFFICIAL_GARDEN_API_KEY_STATE).toBe("empty");

    expect(liveGardenEnv.ALAYA_OFFICIAL_GARDEN_SECRET_REF_STATE).toBe("configured");
    expect(liveGardenEnv.ALAYA_OFFICIAL_GARDEN_API_KEY_STATE).toBe("configured");

    // Raw credential material never enters provenance.
    const ruleJson = JSON.stringify(ruleOnlyEnv);
    const liveJson = JSON.stringify(liveGardenEnv);

    expect(ruleJson).not.toContain("GARDEN_KEY");
    expect(ruleJson).not.toContain("sk-live-secret-key-999");
    expect(liveJson).not.toContain("GARDEN_KEY");
    expect(liveJson).not.toContain("sk-live-secret-key-999");
    expect(liveJson).not.toContain("ALAYA_OFFICIAL_GARDEN_SECRET_REF=");
    expect(liveJson).not.toContain("ALAYA_OFFICIAL_GARDEN_API_KEY=");
  });

  it("ignores forged input *_STATE keys and derives markers strictly from raw credentials", () => {
    const forgedInputEnv = {
      ALAYA_OFFICIAL_GARDEN_SECRET_REF_STATE: "configured",
      ALAYA_OFFICIAL_GARDEN_API_KEY_STATE: "configured",
      ALAYA_OFFICIAL_GARDEN_SECRET_REF: undefined,
      ALAYA_OFFICIAL_GARDEN_API_KEY: "   "
    };

    const paired = collectPairedEnvironment(forgedInputEnv);

    expect(paired.ALAYA_OFFICIAL_GARDEN_SECRET_REF_STATE).toBe("unset");
    expect(paired.ALAYA_OFFICIAL_GARDEN_API_KEY_STATE).toBe("empty");

    expect(paired).not.toHaveProperty("ALAYA_OFFICIAL_GARDEN_SECRET_REF");
    expect(paired).not.toHaveProperty("ALAYA_OFFICIAL_GARDEN_API_KEY");
  });
});
