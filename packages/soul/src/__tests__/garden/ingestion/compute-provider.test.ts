import { describe, expect, it, vi } from "vitest";
import { SOURCE_INTERPRETATION_CONTRACT } from "@do-soul/alaya-protocol";
import {
  GardenProviderError,
  OFFICIAL_API_SYSTEM_PROMPT,
  OfficialApiGardenProvider
} from "../../../garden/ingestion/compute-provider.js";
import { SignalExtractorError } from "../../../garden/extraction/pi-mono-extractor.js";
import {
  createContext as createBaseContext,
  createExtractor,
  EMPTY_INTERPRETATIONS_JSON,
  interpretationEnvelope,
  interpretationRelation
} from "./compute-provider-fixtures.js";

function createContext() {
  return {
    ...createBaseContext(),
    turn_messages: [],
    allow_legacy_single_user_source: true
  };
}

describe("OfficialApiGardenProvider", () => {
  it("materializes source interpretation signals from a successful official API response", async () => {
    const extractor = createExtractor(interpretationEnvelope([
      interpretationRelation("uses", [
        { role: "agent", text: "Alice" },
        { role: "object", text: "tools" }
      ])
    ]));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      now: () => "2026-04-23T09:00:00.000Z",
      generateSignalId: () => "signal-1"
    });

    const signals = await provider.compile("Alice uses tools.", {
      ...createContext(),
      turn_messages: [{ role: "user", content: "Alice uses tools.", message_id: "user-1" }]
    });
    expect(signals).toEqual([
      expect.objectContaining({
        signal_id: "signal-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        source: "garden_compile",
        signal_kind: "potential_semantic_observation",
        interpretation_contract: SOURCE_INTERPRETATION_CONTRACT,
        object_kind: null,
        confidence: null,
        created_at: "2026-04-23T09:00:00.000Z"
      })
    ]);
    expect(extractor.extract).toHaveBeenCalledTimes(1);
  });

  it("instructs the model to emit source-supported relations without kind or confidence", () => {
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(SOURCE_INTERPRETATION_CONTRACT);
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not emit confidence, object_kind");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Preserve relative-date meaning");
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"identity_observation"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"preference_profile"');
  });

  it("returns no signal for a valid empty interpretation envelope", async () => {
    const extractor = createExtractor(EMPTY_INTERPRETATIONS_JSON);
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor
    });
    await expect(provider.compile("Call me Ash.", createContext())).resolves.toEqual([]);
    expect(JSON.parse(vi.mocked(extractor.extract).mock.calls[0]![0].userPrompt)).toEqual({
      schema_version: 2,
      source_locator_contract_version: 4,
      batch_contract_version: 1,
      source_corpus_identity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      batch_index: 0,
      batch_count: 1,
      source_assertions: [{ assertion_id: 1, text: "User: Call me Ash." }]
    });
  });

  it("fails closed when official provider credentials are missing", async () => {
    const extractor = createExtractor(EMPTY_INTERPRETATIONS_JSON);
    const provider = new OfficialApiGardenProvider({ extractor });
    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "auth",
      message: "Official garden provider credentials are missing."
    });
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("permits only an explicitly injected cache-only extractor without credentials", async () => {
    const extractor = createExtractor(EMPTY_INTERPRETATIONS_JSON);
    const provider = new OfficialApiGardenProvider({
      extractor,
      injectedExtractorCapability: "cache_only"
    });
    await expect(provider.compile("Call me Ash.", createContext())).resolves.toEqual([]);
    expect(extractor.extract).toHaveBeenCalledOnce();
  });

  it("surfaces extractor transport failures as network errors", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: vi.fn(async () => {
          throw new SignalExtractorError("transport_failure", "Signal extractor request failed.");
        })
      }
    });
    await expect(provider.compile("Call me Ash.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "network",
      message: "Signal extractor request failed."
    } satisfies Partial<GardenProviderError>);
  });

  it("refuses to construct a live provider without an injected extractor", () => {
    expect(() => new OfficialApiGardenProvider({ apiKey: "sk-test" }))
      .toThrow(/injected extractor/u);
  });

  it("still fails the turn hard when the response envelope itself is malformed", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({ not_interpretations: [] }))
    });
    await expect(provider.compile("turn text", createContext())).rejects.toMatchObject({
      name: "OfficialApiGardenCompileIncompleteError"
    });
  });
});
