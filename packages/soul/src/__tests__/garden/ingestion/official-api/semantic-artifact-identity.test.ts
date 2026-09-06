import { describe, expect, it } from "vitest";
import {
  computeSemanticArtifactKey,
  defaultSourceEnrichmentProfile,
  semanticExtractionProfilesEqual,
  tenantArtifactReuseAllowed
} from "../../../../garden/ingestion/official-api/semantic-artifact-identity.js";
import { OfficialApiSemanticArtifactCodec } from
  "../../../../garden/ingestion/official-api/semantic-artifact.js";
import { capabilityIdentity, OFFICIAL_API_SIGNALS_CAPABILITY, resolveExtractionCapability } from
  "../../../../garden/ingestion/official-api/extraction-capability.js";

describe("official API semantic artifact identity", () => {
  const source = {
    workspaceId: "ws", objectId: "obj", revision: "a".repeat(64), sourceEventRevision: 0,
    content: "Alice owns Orion", runId: "run", createdAt: "2026-05-31T12:00:00.000Z", trustedRole: "user" as const
  };
  const profile = defaultSourceEnrichmentProfile({ model: "fixture-model" });

  it("includes assertion context, capability, model, prompt, and schema in the reusable key", () => {
    const codec = new OfficialApiSemanticArtifactCodec();
    const work = codec.plan(source, profile);
    expect(work.length).toBeGreaterThan(0);
    expect(work[0]!.key).toBe(computeSemanticArtifactKey(work[0]!.semanticKey, profile));
    const changedModel = codec.plan(source, { ...profile, model: "other-model" });
    expect(changedModel[0]!.key).not.toBe(work[0]!.key);
    const changedPrompt = codec.plan(source, { ...profile, promptRevision: "other-prompt" });
    expect(changedPrompt[0]!.key).not.toBe(work[0]!.key);
    const otherContext = codec.plan({ ...source, content: "Bob owns Vega" }, profile);
    expect(otherContext[0]!.semanticKey).not.toBe(work[0]!.semanticKey);
  });

  it("keeps tenant reuse workspace-scoped and names official-api capability identity", () => {
    expect(tenantArtifactReuseAllowed("ws-a", "ws-a")).toBe(true);
    expect(tenantArtifactReuseAllowed("ws-a", "ws-b")).toBe(false);
    expect(capabilityIdentity(OFFICIAL_API_SIGNALS_CAPABILITY)).toBe("official_api_signals:v1");
    expect(resolveExtractionCapability("official_api_signals:v1").materializer).toBe("official_api_signals");
    expect(semanticExtractionProfilesEqual(profile, { ...profile })).toBe(true);
    expect(() => resolveExtractionCapability("not-a-capability")).toThrow(/unknown extraction capability/);
  });
});
