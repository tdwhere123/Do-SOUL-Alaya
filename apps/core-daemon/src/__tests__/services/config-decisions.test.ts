import { describe, expect, it } from "vitest";
import { normalizeLegacyConfigVersion, withConfigVersion } from "../../services/config/config-version.js";
import { selectGardenCredentialProvenance, selectGardenSecretRef } from "../../garden/support/credential.js";
import { mergeDaemonEnvLookup } from "../../runtime/config/daemon-config-environment.js";

describe("pure config version adaptation", () => {
  it("fills only a missing version without mutating stored input", () => {
    const original = Object.freeze({ enabled: false });
    expect(normalizeLegacyConfigVersion(original, 7)).toEqual({ enabled: false, config_version: 7 });
    expect(original).toEqual({ enabled: false });
    for (const config_version of [2, null, "invalid"]) {
      const explicit = Object.freeze({ config_version });
      expect(normalizeLegacyConfigVersion(explicit, 7)).toBe(explicit);
    }
    for (const invalid of [null, [], "text", 0]) expect(normalizeLegacyConfigVersion(invalid, 7)).toBe(invalid);
  });

  it("stamps patches without mutation or replacing explicit versions", () => {
    const patch = Object.freeze({ enabled: true });
    expect(withConfigVersion(patch, 7)).toEqual({ enabled: true, config_version: 7 });
    expect(patch).toEqual({ enabled: true });
    expect(withConfigVersion(Object.freeze({ config_version: 3, enabled: false }), 7))
      .toEqual({ config_version: 3, enabled: false });
  });
});

describe("credential priority and per-key source precedence", () => {
  it("prefers official then legacy then embedding, not process-source before key priority", () => {
    const file = new Map([
      ["ALAYA_OFFICIAL_GARDEN_SECRET_REF", " file:/config/secrets/garden "],
      ["ALAYA_GARDEN_OPENAI_SECRET_REF", "env:LEGACY"],
      ["ALAYA_OPENAI_SECRET_REF", "env:EMBEDDING"]
    ]);
    const env = { ALAYA_GARDEN_OPENAI_SECRET_REF: "env:PROCESS_LEGACY" };
    const effective = mergeDaemonEnvLookup(env, file);
    expect(selectGardenSecretRef(key => effective[key])).toEqual({
      ref: "file:/config/secrets/garden", embeddingFallback: false
    });
    expect(selectGardenCredentialProvenance({ env, configEnv: file })).toEqual({ kind: "file" });
    const masked = { ...env, ALAYA_OFFICIAL_GARDEN_SECRET_REF: "" };
    expect(selectGardenSecretRef(key => masked[key as keyof typeof masked] ?? file.get(key)))
      .toEqual({ ref: "env:PROCESS_LEGACY", embeddingFallback: false });
    expect(selectGardenSecretRef(key => key === "ALAYA_OPENAI_SECRET_REF" ? "env:EMBEDDING" : undefined))
      .toEqual({ ref: "env:EMBEDDING", embeddingFallback: true });
    expect(selectGardenSecretRef(() => " ")).toBeNull();
  });
});
