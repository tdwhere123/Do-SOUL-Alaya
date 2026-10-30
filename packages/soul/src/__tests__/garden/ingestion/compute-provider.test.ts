import { describe, expect, it } from "vitest";
import { OfficialApiGardenProvider, GardenProviderKind } from "../../../garden/ingestion/compute-provider.js";
import { UnavailableGardenProvider } from "../../../garden/ingestion/unavailable-garden-provider.js";
import { SOURCE_STATEMENTS_PROMPT } from "../../../garden/ingestion/source-statements.js";
import { createContext, createExtractor } from "./compute-provider-fixtures.js";

const context = () => ({ ...createContext(), source_root_id: "root-1" });
const rawJson = '{"messages":[{"message_id":"message-1","statements":[]}]}';

describe("conversation provider authorization and unavailable mode", () => {
  it("fails closed without credentials even when an extractor is injected", async () => {
    const extractor = createExtractor(rawJson), provider = new OfficialApiGardenProvider({ extractor });
    await expect(provider.compile("Call me Ash.", context())).rejects.toMatchObject({ kind: "auth" });
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("permits an explicitly injected cache-only extractor and records a genuine empty completion", async () => {
    const extractor = createExtractor(rawJson);
    const provider = new OfficialApiGardenProvider({ extractor, injectedExtractorCapability: "cache_only" });
    expect(provider.provider_kind).toBe(GardenProviderKind.OFFICIAL_API);
    await expect(provider.compile("Call me Ash.", context())).resolves.toEqual([]);
    expect(extractor.extract).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: SOURCE_STATEMENTS_PROMPT, rawResponse: true, retryMode: "disabled"
    }));
  });

  it("refuses authorized construction without an owned transport", () => {
    expect(() => new OfficialApiGardenProvider({ apiKey: "test" })).toThrow("injected extractor");
    expect(() => new OfficialApiGardenProvider({ injectedExtractorCapability: "cache_only" })).toThrow("injected extractor");
  });

  it("does not invent a host occurrence from the legacy single-user flag", async () => {
    const extractor = createExtractor(rawJson);
    const provider = new OfficialApiGardenProvider({ apiKey: "test", extractor });
    await expect(provider.compile("Call me Ash.", { ...context(), turn_messages: [], allow_legacy_single_user_source: true }))
      .rejects.toMatchObject({ kind: "invalid_response" });
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("does not run a second source semantic extractor", async () => {
    const extractor = createExtractor(rawJson);
    const provider = new OfficialApiGardenProvider({ apiKey: "test", extractor });
    await expect(provider.extractOpenSemanticFactors("evidence", "I prefer strict mode.")).resolves.toBeNull();
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("keeps the persisted local selector unavailable rather than inventing preference memory", async () => {
    await expect(new UnavailableGardenProvider().compile("I always use strict mode.", context()))
      .rejects.toMatchObject({ kind: "provider_failure", message: expect.stringContaining("unavailable") });
  });
});
