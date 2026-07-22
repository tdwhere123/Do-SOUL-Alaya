import { describe, expect, it, vi } from "vitest";
import {
  OfficialApiGardenProvider,
  parseOfficialApiSignals,
  type GardenCompileContext
} from "../../garden/compute-provider.js";
import {
  createContext as createBaseContext,
  createExtractor
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
    signals: [{
      signal_kind: "potential_claim",
      object_kind: "activity",
      confidence: 0.9,
      matched_text: matchedText,
      distilled_fact: "The operator completed the review today.",
      temporal_projection: projection
    }]
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
  });

  it("derives relative time from source observation after raw extraction", async () => {
    const extractor = createExtractor(temporalEnvelope({
      projection_schema_version: 1,
      event_time_start: "2025-03-27",
      event_time_end: "2025-03-27",
      time_precision: "day",
      time_source: "turn_text"
    }));
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor,
      now: () => "2030-01-01T00:00:00.000Z",
      generateSignalId: () => "signal-observed"
    });
    const context: GardenCompileContext = {
      ...createContext(),
      source_observed_at: "2024-06-15T14:30:00.000Z"
    };

    const [signal] = await provider.compile("I completed the review today.", context);

    expect(signal?.created_at).toBe("2024-06-15T14:30:00.000Z");
    expect(signal?.raw_payload.temporal_projection).toEqual({
      projection_schema_version: 1,
      event_time_start: "2024-06-15T00:00:00.000Z",
      event_time_end: "2024-06-15T23:59:59.999Z",
      time_precision: "day",
      time_source: "relative_resolved"
    });
    const prompt = JSON.parse(vi.mocked(extractor.extract).mock.calls[0]![0].userPrompt);
    expect(prompt).not.toHaveProperty("source_observed_at");
  });

  it.each([
    [
      "today",
      "2024-06-15T00:30:00+08:00",
      "2024-06-14T16:00:00.000Z",
      "2024-06-15T15:59:59.999Z"
    ],
    [
      "today",
      "2024-06-15T00:30:00-08:00",
      "2024-06-15T08:00:00.000Z",
      "2024-06-16T07:59:59.999Z"
    ],
    [
      "last Saturday",
      "2024-06-16T00:30:00+08:00",
      "2024-06-14T16:00:00.000Z",
      "2024-06-15T15:59:59.999Z"
    ],
    [
      "last Saturday",
      "2024-06-16T00:30:00-08:00",
      "2024-06-15T08:00:00.000Z",
      "2024-06-16T07:59:59.999Z"
    ],
    [
      "last month",
      "2024-07-01T00:30:00+08:00",
      "2024-05-31T16:00:00.000Z",
      "2024-06-30T15:59:59.999Z"
    ],
    [
      "last month",
      "2024-07-01T00:30:00-08:00",
      "2024-06-01T08:00:00.000Z",
      "2024-07-01T07:59:59.999Z"
    ]
  ])("preserves fixed-offset civil semantics for %s at %s", async (term, sourceObservedAt, start, end) => {
    const matchedText = `I completed the review ${term}.`;
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(temporalEnvelope({}, matchedText)),
      generateSignalId: () => `signal-fixed-offset-${term}`
    });
    const [signal] = await provider.compile(matchedText, {
      ...createContext(),
      source_observed_at: sourceObservedAt
    });
    expect(signal?.raw_payload.temporal_projection).toMatchObject({
      event_time_start: start,
      event_time_end: end,
      time_source: "relative_resolved"
    });
  });

  it("keeps relative durable content grounded in the source wording", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({
        signals: [{
          signal_kind: "potential_claim",
          object_kind: "activity",
          confidence: 0.9,
          matched_text: "I completed the review today.",
          distilled_fact: "The operator completed the review on 2025-03-27.",
          temporal_projection: {
            projection_schema_version: 1,
            event_time_start: "2025-03-27",
            event_time_end: "2025-03-27",
            time_precision: "day",
            time_source: "relative_resolved"
          }
        }]
      })),
      generateSignalId: () => "signal-source-grounded"
    });

    const [signal] = await provider.compile("I completed the review today.", {
      ...createContext(),
      source_observed_at: "2024-06-15T14:30:00.000Z"
    });

    expect(signal?.raw_payload.distilled_fact).toBe("I completed the review today.");
    expect(signal?.raw_payload.distilled_fact).not.toContain("2025-03-27");
  });

  it("rejects an absolute date added by untrusted cached extraction", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({
        signals: [{
          signal_kind: "potential_claim",
          object_kind: "activity",
          confidence: 0.9,
          matched_text: "I completed the review.",
          distilled_fact: "The operator completed the review on 2025-03-27."
        }]
      })),
      generateSignalId: () => "signal-untrusted-date"
    });

    const [signal] = await provider.compile("I completed the review.", createContext());

    expect(signal?.raw_payload.distilled_fact).toBe("I completed the review.");
  });

  it("keeps source month precision when extraction invents a day", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({
        signals: [{
          signal_kind: "potential_claim",
          object_kind: "activity",
          confidence: 0.9,
          matched_text: "I started my job in March 2024.",
          distilled_fact: "Alice started her job on 2024-03-01."
        }]
      })),
      generateSignalId: () => "signal-month-precision"
    });

    const [signal] = await provider.compile(
      "I started my job in March 2024.",
      createContext()
    );

    expect(signal?.raw_payload.distilled_fact).toBe("I started my job in March 2024.");
    expect(signal?.raw_payload.temporal_projection).toMatchObject({
      event_time_start: "2024-03-01T00:00:00.000Z",
      event_time_end: "2024-03-31T23:59:59.999Z",
      time_precision: "month",
      time_source: "explicit"
    });
  });

  it("derives an explicit source range instead of collapsing to its first month", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(temporalEnvelope({
        projection_schema_version: 1,
        event_time_start: "2024-03-01",
        event_time_end: "2024-04-30",
        time_precision: "range",
        time_source: "explicit"
      }, "I worked at Acme from March 2024 to April 2024.")),
      generateSignalId: () => "signal-explicit-range"
    });
    const [signal] = await provider.compile(
      "I worked at Acme from March 2024 to April 2024.",
      createContext()
    );
    expect(signal?.raw_payload.temporal_projection).toEqual({
      projection_schema_version: 1,
      event_time_start: "2024-03-01T00:00:00.000Z",
      event_time_end: "2024-04-30T23:59:59.999Z",
      time_precision: "range",
      time_source: "explicit"
    });
  });

  it("does not accept extracted precision or field semantics that source text cannot prove", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(temporalEnvelope({
        projection_schema_version: 1,
        valid_from: "2024-03-01",
        valid_to: "2024-03-31",
        time_precision: "day",
        time_source: "explicit"
      }, "I started my job in March 2024.")),
      generateSignalId: () => "signal-source-temporal-semantics"
    });
    const [signal] = await provider.compile("I started my job in March 2024.", createContext());
    expect(signal?.raw_payload.temporal_projection).toEqual({
      projection_schema_version: 1,
      event_time_start: "2024-03-01T00:00:00.000Z",
      event_time_end: "2024-03-31T23:59:59.999Z",
      time_precision: "month",
      time_source: "explicit"
    });
  });

  it("accepts a natural-language explicit date only when the source verifies it", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(temporalEnvelope({
        projection_schema_version: 1,
        event_time_start: "2026-03-19",
        event_time_end: "2026-03-19",
        time_precision: "day",
        time_source: "explicit"
      }, "The deployment happened on March 19, 2026.")),
      generateSignalId: () => "signal-natural-date"
    });

    const [signal] = await provider.compile(
      "The deployment happened on March 19, 2026.",
      createContext()
    );

    expect(signal?.raw_payload.temporal_projection).toMatchObject({
      event_time_start: "2026-03-19T00:00:00.000Z",
      event_time_end: "2026-03-19T23:59:59.999Z",
      time_source: "explicit"
    });
  });

  it.each([
    ["one week ago", "2024-06-03T00:00:00.000Z", "2024-06-09T23:59:59.999Z"],
    ["last Saturday", "2024-06-08T00:00:00.000Z", "2024-06-08T23:59:59.999Z"]
  ])("resolves %s without an environment gate", async (term, start, end) => {
    const matchedText = `I completed the review ${term}.`;
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(temporalEnvelope({
        projection_schema_version: 1,
        event_time_start: "2025-03-27",
        event_time_end: "2025-03-27",
        time_precision: "day",
        time_source: "relative_resolved"
      }, matchedText)),
      generateSignalId: () => `signal-${term}`
    });

    const [signal] = await provider.compile(matchedText, {
      ...createContext(),
      source_observed_at: "2024-06-15T14:30:00.000Z"
    });

    expect(signal?.raw_payload.temporal_projection).toMatchObject({
      event_time_start: start,
      event_time_end: end,
      time_source: "relative_resolved"
    });
  });

  it("does not persist a model-resolved relative date without a source observation", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(temporalEnvelope({
        projection_schema_version: 1,
        event_time_start: "2025-03-27",
        event_time_end: "2025-03-27",
        time_precision: "day",
        time_source: "relative_resolved"
      })),
      generateSignalId: () => "signal-unanchored"
    });

    const [signal] = await provider.compile("I completed the review today.", createContext());

    expect(signal?.raw_payload).not.toHaveProperty("temporal_projection");
  });

  it("retains a later explicit date when an unanchored relative term appears first", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(temporalEnvelope({
        projection_schema_version: 1,
        event_time_start: "2025-03-27",
        event_time_end: "2025-03-27",
        time_precision: "day",
        time_source: "relative_resolved"
      }, "Yesterday I confirmed the review happened on 2024-05-01.")),
      generateSignalId: () => "signal-explicit-after-relative"
    });

    const [signal] = await provider.compile(
      "Yesterday I confirmed the review happened on 2024-05-01.",
      createContext()
    );

    expect(signal?.raw_payload.temporal_projection).toMatchObject({
      event_time_start: "2024-05-01T00:00:00.000Z",
      event_time_end: "2024-05-01T23:59:59.999Z",
      time_source: "explicit"
    });
  });

  it("does not treat source observation as semantic event time", async () => {
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(temporalEnvelope({
        projection_schema_version: 1,
        event_time_start: "2025-03-27",
        event_time_end: "2025-03-27",
        time_precision: "day",
        time_source: "session_timestamp"
      }, "I completed the review.")),
      generateSignalId: () => "signal-session-time"
    });
    const context: GardenCompileContext = {
      ...createContext(),
      source_observed_at: "2024-06-15T14:30:00.000Z"
    };

    const [signal] = await provider.compile("I completed the review.", context);

    expect(signal?.raw_payload).not.toHaveProperty("temporal_projection");
  });
});
