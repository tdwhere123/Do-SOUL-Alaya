import { describe, expect, it } from "vitest";
import {
  OfficialApiGardenProvider,
  parseOfficialApiSignals
} from "../../../garden/ingestion/compute-provider.js";
import {
  createContext as createBaseContext,
  createExtractor,
  interpretationEnvelope,
  interpretationRelation,
  withOpenSemanticFactorGraph
} from "./compute-provider-fixtures.js";

function createContext() {
  return {
    ...createBaseContext(),
    turn_messages: [],
    allow_legacy_single_user_source: true
  };
}

function temporalEnvelope(
  projection: Readonly<Record<string, unknown>>,
  matchedText = "I completed the review today."
): string {
  return JSON.stringify({
    signals: [withOpenSemanticFactorGraph({
      signal_kind: "potential_claim",
      object_kind: "activity",
      confidence: 0.9,
      matched_text: matchedText,
      distilled_fact: "The operator completed the review today.",
      temporal_projection: projection
    })]
  });
}

describe("official Garden temporal observation contract", () => {
  it("rejects an entire temporal projection when its provenance is invalid", () => {
    const [draft] = parseOfficialApiSignals(temporalEnvelope({
      projection_schema_version: 1,
      event_time_start: "2025-03-27",
      event_time_end: "2025-03-27",
      time_precision: "day",
      time_source: "turn_text"
    }));

    expect(draft?.temporal_projection).toBeUndefined();
  });

  it("rejects an entire temporal projection when one date is invalid", () => {
    const [draft] = parseOfficialApiSignals(temporalEnvelope({
      projection_schema_version: 1,
      event_time_start: "2026-02-31",
      event_time_end: "2026-03-01",
      time_precision: "day",
      time_source: "explicit"
    }));

    expect(draft?.temporal_projection).toBeUndefined();
    expect(draft?.temporal_projection_audit).toEqual({
      status: "rejected",
      reason: "temporal_projection_invalid"
    });
  });

  it("accepts an open valid-time nomination before source verification", () => {
    const [draft] = parseOfficialApiSignals(temporalEnvelope({
      projection_schema_version: 1,
      valid_from: "2024-03-01",
      time_precision: "month",
      time_source: "explicit"
    }, "I have worked at Acme since March 2024."));

    expect(draft?.temporal_projection).toMatchObject({
      valid_from: "2024-03-01T00:00:00.000Z",
      time_precision: "month",
      time_source: "explicit"
    });
  });

  it("ordinary compile keeps source time phrases and does not attach ISO temporal_projection", async () => {
    const source = "I have worked at Acme since March 2024.";
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(interpretationEnvelope([
        interpretationRelation("worked", [
          { role: "agent", text: "I" }
        ], [
          { role: "event_time", text: "March 2024" }
        ])
      ])),
      generateSignalId: () => "signal-source-time"
    });
    const [signal] = await provider.compile(source, {
      ...createContext(),
      turn_messages: [{ role: "user", content: source, message_id: "user-1" }]
    });
    expect(signal?.interpretation_contract).toBe("source-interpretation-v1");
    expect(signal?.object_kind).toBeNull();
    expect(signal?.confidence).toBeNull();
    expect(signal?.raw_payload).not.toHaveProperty("temporal_projection");
    expect(signal?.raw_payload.source_interpretation.candidates[0]?.qualifiers[0]?.phrase.text)
      .toBe("March 2024");
  });
});
