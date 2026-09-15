import { describe, expect, it } from "vitest";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { inspectObservedTemporalProjection } from "../../../garden/extraction/temporal/observed-projection.js";
import {
  createContext,
  createExtractor,
  interpretationEnvelope,
  interpretationRelation
} from "./compute-provider-fixtures.js";

describe("official Garden dual-time observation", () => {
  it("grounds unequal event and validity dates independently through persistence input", async () => {
    const source = "The policy was announced on January 1, 2024 and became effective on February 1, 2024.";
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(interpretationEnvelope([
        interpretationRelation("announced", [], [{ role: "event_time", text: "January 1, 2024" }])
      ])),
      generateSignalId: () => "signal-unequal-dual-time"
    });

    const [signal] = await provider.compile(source, {
      ...createContext(),
      turn_messages: [],
      allow_legacy_single_user_source: true
    });
    expect(signal?.interpretation_contract).toBe("source-interpretation-v1");
    expect(signal?.object_kind).toBeNull();
    expect(signal?.raw_payload).not.toHaveProperty("temporal_projection");
    expect(signal?.raw_payload.source_interpretation.candidates[0]?.qualifiers[0]?.phrase.text)
      .toBe("January 1, 2024");
  });

  it("does not assign a validity cue to the neighboring event date", () => {
    const inspection = inspectObservedTemporalProjection(
      "The policy was announced on January 1, 2024 and became effective on February 1, 2024.",
      {
        projection_schema_version: 1,
        event_time_start: "2024-01-01T00:00:00.000Z",
        event_time_end: "2024-01-01T00:00:00.000Z",
        valid_from: "2024-01-01T00:00:00.000Z",
        time_precision: "day",
        time_source: "explicit"
      },
      undefined
    );

    expect(inspection.audit).toEqual({
      status: "rejected",
      reason: "valid_time_role_not_source_grounded"
    });
    expect(inspection.projection).not.toHaveProperty("valid_from");
  });

  it("keeps a later clause validity cue from the earlier date", () => {
    const inspection = inspectObservedTemporalProjection(
      "The policy was announced January 1, 2024; effective under the revised charter beginning on February 1, 2024.",
      {
        projection_schema_version: 1,
        event_time_start: "2024-01-01T00:00:00.000Z",
        event_time_end: "2024-01-01T00:00:00.000Z",
        valid_from: "2024-01-01T00:00:00.000Z",
        time_precision: "day",
        time_source: "explicit"
      },
      undefined
    );

    expect(inspection.audit).toEqual({
      status: "rejected",
      reason: "valid_time_role_not_source_grounded"
    });
    expect(inspection.projection).not.toHaveProperty("valid_from");
  });

  it("does not assign an earlier clause validity cue to the neighboring event date", () => {
    const inspection = inspectObservedTemporalProjection(
      "January 1, 2024 was the effective date; the policy was announced on February 1, 2024.",
      {
        projection_schema_version: 1,
        event_time_start: "2024-02-01T00:00:00.000Z",
        event_time_end: "2024-02-01T00:00:00.000Z",
        valid_from: "2024-02-01T00:00:00.000Z",
        time_precision: "day",
        time_source: "explicit"
      },
      undefined
    );

    expect(inspection.audit).toEqual({
      status: "rejected",
      reason: "valid_time_role_not_source_grounded"
    });
    expect(inspection.projection).not.toHaveProperty("valid_from");
  });

  it("accepts a validity cue after its date while preserving a later event date", () => {
    const inspection = inspectObservedTemporalProjection(
      "January 1, 2024 was the effective date; the policy was announced on February 1, 2024.",
      {
        projection_schema_version: 1,
        event_time_start: "2024-02-01T00:00:00.000Z",
        event_time_end: "2024-02-01T00:00:00.000Z",
        valid_from: "2024-01-01T00:00:00.000Z",
        time_precision: "day",
        time_source: "explicit"
      },
      undefined
    );

    expect(inspection.audit).toEqual({
      status: "formed",
      reason: "dual_time_source_verified"
    });
    expect(inspection.projection).toMatchObject({
      event_time_start: "2024-02-01T00:00:00.000Z",
      valid_from: "2024-01-01T00:00:00.000Z"
    });
  });
});
