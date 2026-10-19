import { afterAll, describe, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../../../../../apps/bench-runner/src/__tests__/support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
afterAll(() => {
  isolation.strict.restore();
  isolation.safe.restore();
  expect(isolation.safe.violations).toEqual([]);
  expect(isolation.strict.forbidden).toEqual([]);
});
import { SOURCE_INTERPRETATION_CONTRACT } from "@do-soul/alaya-protocol";
import { createPiMonoExtractor, type SignalExtractor } from "../../../garden/extraction/pi-mono-extractor.js";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { parseOfficialApiExtractionRequest } from "../../../garden/ingestion/official-api/extraction-request.js";
import { classifyOfficialApiExtractionResult } from "../../../garden/ingestion/official-api/source-interpretation-receive.js";
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

  it.each([
    { rawJson: '{"signals":[]}', reason: "malformed_response" },
    { rawJson: interpretationEnvelope(9, "uses", []), reason: "source_assertion_mismatch" },
    { rawJson: interpretationEnvelope(1, "invented", []), reason: "candidate_rejected" }
  ])("keeps $reason admission failures invalid rather than network failures", async ({ rawJson, reason }) => {
    const turn = "Alice uses tools.";
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: rawJson }] }));
    const delegate = createPiMonoExtractor({ apiKey: "sk-test", model: "model", complete });
    const extractor: SignalExtractor = { extract: (input) => delegate.extract({
      ...input,
      validateRawJson: (value) => {
        classifyOfficialApiExtractionResult(value, parseOfficialApiExtractionRequest(JSON.parse(input.userPrompt)), input.sourceCorpus);
        input.validateRawJson?.(value);
      }
    }) };
    const provider = new OfficialApiGardenProvider({ apiKey: "sk-test", extractor, diagnosticDir: null });

    await expect(provider.compile(turn, {
      ...createContext(), turn_messages: [{ role: "user", content: turn, message_id: "user-1" }]
    })).rejects.toMatchObject({
      name: "GardenProviderError", kind: "invalid_response",
      cause: { name: "OfficialApiInterpretationAdmissionError",
        receive: { status: "partial", rejections: [expect.objectContaining({ reason })] } }
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("keeps a genuine completion-port failure classified as network failure", async () => {
    const failure = new Error("connection failed");
    const complete = vi.fn(async () => { throw failure; });
    const provider = new OfficialApiGardenProvider({ apiKey: "sk-test", diagnosticDir: null,
      extractor: createPiMonoExtractor({ apiKey: "sk-test", model: "model", complete }) });

    await expect(provider.compile("Alice uses tools.", createContext())).rejects.toMatchObject({
      name: "GardenProviderError", kind: "network",
      cause: { name: "SignalExtractorError", kind: "transport_failure", cause: failure,
        retryClassification: "failure_transport_port" }
    });
    expect(complete).toHaveBeenCalledOnce();
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
      extractor: createPiMonoExtractor({ apiKey: "sk-test", model: "model",
        complete: async () => ({ content: [{ type: "text", text: '{"interpretations":[]}' }] }) }),
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
