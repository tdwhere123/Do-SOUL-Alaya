import { describe, expect, it } from "vitest";
import { SOURCE_INTERPRETATION_CONTRACT } from "@do-soul/alaya-protocol";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { createContext, createExtractor } from "./compute-provider-fixtures.js";

function interpretationEnvelope(assertionId: number, predicate: string, args: readonly {
  readonly role: string;
  readonly text: string;
}[]) {
  return JSON.stringify({
    interpretations: [{
      assertion_id: assertionId,
      relations: [{
        predicate: { text: predicate },
        arguments: args.map((item) => ({ role: item.role, phrase: { text: item.text } })),
        qualifiers: []
      }]
    }]
  });
}

describe("official API ordinary extraction compile", () => {
  it("extracts proposals without source publication authority and preserves empty versus malformed reception", async () => {
    const { source_observation: _sourceObservation, ...withoutObservation } = createContext();
    const turn = "Alice uses tools.";
    const context = { ...withoutObservation,
      turn_messages: [{ role: "user" as const, content: turn, message_id: "user-1" }] };
    const proposals = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(interpretationEnvelope(1, "uses", [
        { role: "agent", text: "Alice" }
      ])),
      generateSignalId: () => { throw new Error("proposal extraction must not emit signals"); }
    });
    await expect(proposals.extractSourceInterpretations(turn, context)).resolves.toHaveLength(1);
    const empty = new OfficialApiGardenProvider({
      apiKey: "sk-test", extractor: createExtractor('{"interpretations":[]}')
    });
    await expect(empty.extractSourceInterpretations(turn, context)).resolves.toMatchObject([
      { outcome: "empty", candidates: [], diagnostics: [] }
    ]);
    const malformed = new OfficialApiGardenProvider({
      apiKey: "sk-test", extractor: createExtractor('{"signals":[]}'), diagnosticDir: null
    });
    await expect(malformed.extractSourceInterpretations(turn, context)).rejects.toThrow();
  });

  it("emits a source interpretation signal without kind or confidence routing fields", async () => {
    const turn = "Alice uses tools.";
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(interpretationEnvelope(1, "uses", [
        { role: "agent", text: "Alice" },
        { role: "object", text: "tools" }
      ])),
      generateSignalId: () => "signal-interpretation"
    });
    const signals = await provider.compile(turn, {
      ...createContext(),
      turn_messages: [{ role: "user", content: turn, message_id: "user-1" }]
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      signal_id: "signal-interpretation",
      source: "garden_compile",
      signal_kind: "potential_semantic_observation",
      interpretation_contract: SOURCE_INTERPRETATION_CONTRACT,
      object_kind: null,
      confidence: null
    });
    expect(signals[0]!.raw_payload.source_interpretation).toMatchObject({
      contract: SOURCE_INTERPRETATION_CONTRACT,
      outcome: "candidates",
      assertion_binding: { text: "User: Alice uses tools." }
    });
    expect(signals[0]!.raw_payload).not.toHaveProperty("matched_text");
  });

  it("returns no signal for a valid empty interpretation envelope", async () => {
    const turn = "Alice uses tools.";
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor('{"interpretations":[]}'),
      generateSignalId: () => "signal-empty"
    });
    await expect(provider.compile(turn, {
      ...createContext(),
      turn_messages: [{ role: "user", content: turn, message_id: "user-1" }]
    })).resolves.toEqual([]);
  });

  it("fails compile loudly when source observation is missing after the extractor ran", async () => {
    const turn = "Alice uses tools.";
    const { source_observation: _sourceObservation, ...withoutObservation } = createContext();
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(interpretationEnvelope(1, "uses", [
        { role: "agent", text: "Alice" },
        { role: "object", text: "tools" }
      ])),
      generateSignalId: () => "signal-missing-observation"
    });
    await expect(provider.compile(turn, {
      ...withoutObservation,
      turn_messages: [{ role: "user", content: turn, message_id: "user-1" }]
    })).rejects.toMatchObject({
      name: "GardenProviderError",
      kind: "invalid_response",
      message: "Official garden compile requires admitted source observation."
    });
  });
});
