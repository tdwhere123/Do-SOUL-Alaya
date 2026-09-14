import { describe, expect, it } from "vitest";
import { inspectObservedTemporalProjection } from "../../../garden/extraction/temporal/observed-projection.js";
import { parseOfficialApiTemporalProjection } from "../../../garden/extraction/temporal/projection-draft.js";
import { resolveTemporalProjection } from "../../../garden/extraction/time-concern-projection.js";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { LocalHeuristics } from "../../../garden/triage/local-heuristics.js";
import { createContext, createOpenSemanticExtractor } from "./compute-provider-fixtures.js";

const year = {
  projection_schema_version: 1 as const,
  event_time_start: "2016-01-01T00:00:00.000Z",
  event_time_end: "2016-12-31T23:59:59.999Z",
  time_precision: "year" as const,
  time_source: "explicit" as const
};

describe("source calendar windows and temporal roles", () => {
  it.each([
    "I released the product in 2016.",
    "The original product was released in 2016 with a promise of cloud access.",
    "In 2016, I released the product.",
    "我在2016年发布产品。"
  ])("derives and verifies a closed explicit year without an observation clock: %s", (source) => {
    expect(inspectObservedTemporalProjection(source, undefined, undefined)).toEqual({
      projection: year, audit: { status: "formed", reason: "source_event_time_derived" }
    });
    expect(inspectObservedTemporalProjection(source, year, undefined)).toEqual({
      projection: year, audit: { status: "formed", reason: "event_time_source_verified" }
    });
  });

  it.each([
    "I own model 2016.", "I own model 2016 or 2017.", "I paid 2016 dollars.", "I processed 2016 requests.",
    "I live in 2016 houses.", "I use version 2016.2.", "I released model X2016.",
    "I waited in 2016.5 seconds.", "I released the product before 2016.",
    "I released the product after 2016.", "I released the product by 2016.",
    "I worked from 2016.", "I worked until 2016.",
    "I released the product in 2016 or 2017.", "I released the product in 2016 and 2017.",
    "I released the product in 2016 or 2017 models.",
    "I released the product in 2016 or the year 2017.", "I worked to 2016.",
    "I released the product last year or in 2016.", "I released the product in 2016 or after 2017.",
    "I worked last year or from 2016 to 2017.",
    "I released the product in 2016, or possibly 2017.",
    "我在2016年或2017年发布产品。", "我在2016年前发布产品。",
    "I released the product in 2016-02-30.", "I released the product in 2016-13.",
    "I released the product in 2016-02-03-04.", "I use version2016-02.",
    "I released the product in 2016-02x."
  ])("does not promote a numeral, unresolved bound or date fragment into an event: %s", (source) => {
    expect(inspectObservedTemporalProjection(source, undefined, undefined).projection).toBeUndefined();
    expect(inspectObservedTemporalProjection(source, year, undefined).audit.status).toBe("rejected");
  });

  it("retains month and day precision instead of selecting their year prefix", () => {
    for (const source of ["I released the product in 2016-02.", "I released the product in February 2016."]) {
      expect(inspectObservedTemporalProjection(source, undefined, undefined).projection).toMatchObject({
        event_time_start: "2016-02-01T00:00:00.000Z", event_time_end: "2016-02-29T23:59:59.999Z", time_precision: "month"
      });
    }
    expect(inspectObservedTemporalProjection("I released the product in 2016-02-29.", undefined, undefined).projection)
      .toMatchObject({ event_time_start: "2016-02-29T00:00:00.000Z", event_time_end: "2016-02-29T23:59:59.999Z", time_precision: "day" });
  });

  it("binds both range endpoints and rejects an individual endpoint nomination", () => {
    const source = "I worked from 2016 to 2017.";
    expect(inspectObservedTemporalProjection(source, undefined, undefined).projection).toMatchObject({
      event_time_start: year.event_time_start, event_time_end: "2017-12-31T23:59:59.999Z", time_precision: "range"
    });
    expect(inspectObservedTemporalProjection(source, year, undefined).audit.status).toBe("rejected");
    expect(inspectObservedTemporalProjection("I worked from December 2016 to January 2017.", undefined, undefined).projection)
      .toMatchObject({ event_time_start: "2016-12-01T00:00:00.000Z", event_time_end: "2017-01-31T23:59:59.999Z" });
  });

  it("keeps v1 inclusive endpoints and canonicalizes historical final-day nominations", () => {
    const source = "I released the product in 2016.";
    const legacy = parseOfficialApiTemporalProjection({ ...year, version: "1", projection_schema_version: undefined,
      event_time_start: "2016-01-01", event_time_end: "2016-12-31" });
    expect(inspectObservedTemporalProjection(source, legacy!, undefined).projection).toEqual(year);
    expect(inspectObservedTemporalProjection(source, { ...year, event_time_end: "2017-01-01T00:00:00.000Z" }, undefined)
      .audit.status).toBe("rejected");
    expect(resolveTemporalProjection("9999", null)?.event_time_end).toBe("9999-12-31T23:59:59.999Z");
    expect(resolveTemporalProjection("0099", null)).toBeNull();
  });

  it("derives open and bounded validity without copying a date into event time", () => {
    for (const source of ["This policy is valid from May 2023.", "I have worked here since May 2023."]) {
      expect(inspectObservedTemporalProjection(source, undefined, undefined)).toEqual({
        projection: { projection_schema_version: 1, valid_from: "2023-05-01T00:00:00.000Z", time_precision: "month", time_source: "explicit" },
        audit: { status: "formed", reason: "source_valid_time_derived" }
      });
    }
    expect(inspectObservedTemporalProjection("This policy is valid from 2016 to 2017.", undefined, undefined).projection).toEqual({
      projection_schema_version: 1, valid_from: year.event_time_start, valid_to: "2017-12-31T23:59:59.999Z", time_precision: "range", time_source: "explicit"
    });
    expect(inspectObservedTemporalProjection("This policy is valid from 2016.", year, undefined).audit.status).toBe("rejected");
    expect(inspectObservedTemporalProjection("This policy is valid from 2016.", {
      projection_schema_version: 1, valid_from: year.event_time_start, valid_to: year.event_time_end,
      time_precision: "year", time_source: "explicit"
    }, undefined).audit.status).toBe("rejected");
  });

  it("does not borrow an undated neighboring clause's validity role", () => {
    expect(inspectObservedTemporalProjection("This policy was announced in 2016 and is effective indefinitely.", undefined, undefined).projection)
      .toEqual(year);
  });

  it("anchors relative years to the supplied fixed offset across the UTC year boundary", () => {
    expect(inspectObservedTemporalProjection("I worked last year.", undefined, "2024-01-01T00:30:00+14:00").projection)
      .toMatchObject({ event_time_start: "2022-12-31T10:00:00.000Z", event_time_end: "2023-12-31T09:59:59.999Z" });
    expect(inspectObservedTemporalProjection("I worked last year.", undefined, undefined).projection).toBeUndefined();
  });

  it("uses the source role owner in both official and local extraction", async () => {
    for (const source of ["I released the product in 2016.", "I worked before 2016.", "This policy is valid from May 2023."]) {
      const context = { ...createContext(), turn_messages: [], allow_legacy_single_user_source: true };
      const [signal] = await new OfficialApiGardenProvider({ apiKey: "test", extractor: createOpenSemanticExtractor(JSON.stringify({ signals: [{
        object_kind: "fact", confidence: 0.9, matched_text: source, distilled_fact: source
      }] })) }).compile(source, context);
      expect(signal).toBeDefined();
      const expected = inspectObservedTemporalProjection(source, undefined, undefined).projection;
      expect(signal?.raw_payload.temporal_projection).toEqual(expected);
      const local = await new LocalHeuristics().compile(source, context);
      const temporal = local.filter((candidate) => candidate.raw_payload.time_concern !== undefined);
      expect(temporal).toHaveLength(1);
      for (const candidate of temporal) {
        if (source === "I released the product in 2016.") {
          expect(candidate.raw_payload.temporal_projection).toMatchObject({ event_time_start: year.event_time_start, event_time_end: year.event_time_end });
        } else {
          expect(candidate.raw_payload.temporal_projection).toBeUndefined();
          expect(candidate.raw_payload.time_concern).not.toHaveProperty("event_time_start");
        }
      }
    }
  });
});
