import { describe, expect, it } from "vitest";
import { inspectObservedTemporalProjection } from "../../../garden/extraction/temporal/observed-projection.js";
import { parseOfficialApiTemporalProjection } from "../../../garden/extraction/temporal/projection-draft.js";
import { resolveTemporalProjection } from "../../../garden/extraction/time-concern-projection.js";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { LocalHeuristics } from "../../../garden/triage/local-heuristics.js";
import { buildMemoryInput } from "../../../garden/materialization/materialization-router/inputs.js";
import { createContext, createOpenSemanticExtractor } from "./compute-provider-fixtures.js";
import { resolveSourceTemporalCandidates } from "../../../garden/extraction/temporal/source-time.js";

const year = {
  projection_schema_version: 1 as const,
  event_time_start: "2016-01-01T00:00:00.000Z",
  event_time_end: "2016-12-31T23:59:59.999Z",
  time_precision: "year" as const,
  time_source: "explicit" as const
};

describe("relative calendar modifier qualification", () => {
  const anchor = "2023-05-29T10:31:00.000Z";
  const today = { projection_schema_version: 1 as const, time_precision: "day" as const,
    time_source: "relative_resolved" as const, event_time_start: "2023-05-29T00:00:00.000Z",
    event_time_end: "2023-05-29T23:59:59.999Z" };

  it.each([
    "In today’s world, doing what you love shouldn’t mean worrying about components and buying expensive gear.",
    "I shipped today's build.", "I shipped yesterday’s build.", "I use today-based labels.",
    "I use today‑based labels.", "I use today_label.", "I shipped today’sWorld.", "I shipped today's_build.",
    "我喜欢今天的版本。", "我喜欢上周的版本。"
  ])("does not project an attached date modifier: %s", async (source) => {
    expect(resolveSourceTemporalCandidates(source, anchor)).toEqual([]);
    expect(inspectObservedTemporalProjection(source, undefined, anchor).projection).toBeUndefined();
    expect(inspectObservedTemporalProjection(source, today, anchor)).toMatchObject({ audit: { status: "rejected" } });
    expect(inspectObservedTemporalProjection(source, today, anchor).projection).toBeUndefined();
    const local = await new LocalHeuristics().compile(source, { ...createContext(),
      source_observed_at: anchor, turn_messages: [], allow_legacy_single_user_source: true });
    for (const signal of local) {
      expect(signal.raw_payload.temporal_projection).toBeUndefined();
      expect(buildMemoryInput(signal, ["source"]).event_time_start).toBeUndefined();
    }
  });

  it.each(["I shipped today's build yesterday.", "I shipped today’s build yesterday.", "我昨天发布今天的版本。"])(
    "qualifies an independent calendar adjunct without borrowing its modifier date: %s", (source) => {
      const candidates = resolveSourceTemporalCandidates(source, anchor);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.projection.event_time_start).toBe("2023-05-28T00:00:00.000Z");
      expect(inspectObservedTemporalProjection(source, today, anchor).audit.status).toBe("rejected");
    });

  it("preserves standalone adjuncts, surrounding quotes and the original offset clock", () => {
    for (const source of ["I released the product today.", "I released the product 'today'.", "我今天发布产品。"])
      expect(inspectObservedTemporalProjection(source, undefined, anchor).projection).toEqual(today);
    expect(inspectObservedTemporalProjection("I released the product today.", undefined, undefined).projection).toBeUndefined();
    expect(inspectObservedTemporalProjection("I released the product today.", undefined,
      "2024-01-01T00:30:00+14:00").projection).toMatchObject({
      event_time_start: "2023-12-31T10:00:00.000Z", event_time_end: "2024-01-01T09:59:59.999Z" });
  });

  it.each(["yesterday-today", "yesterday–today", "yesterday—today", "2023-05-01–2023-05-03"])(
    "retains existing compact closed-range ownership: %s", (text) => {
      const projection = inspectObservedTemporalProjection(`We worked ${text}.`, undefined, anchor).projection;
      expect(projection).toMatchObject({ time_precision: "range",
        event_time_start: text.startsWith("yesterday") ? "2023-05-28T00:00:00.000Z" : "2023-05-01T00:00:00.000Z",
        event_time_end: text.startsWith("yesterday") ? today.event_time_end : "2023-05-03T23:59:59.999Z" });
    });
});

describe("temporal evidence inventory", () => {
  const laterYear = { ...year, event_time_start: "2017-01-01T00:00:00.000Z", event_time_end: "2017-12-31T23:59:59.999Z" };
  const laterValidity = { projection_schema_version: 1 as const, valid_from: laterYear.event_time_start,
    time_precision: "year" as const, time_source: "explicit" as const };

  it.each(["effective", "valid"])("retains a directly governing %s construction after an earlier date", async (role) => {
    const source = `I announced in 2016 a policy ${role} from 2017.`;
    expect(resolveSourceTemporalCandidates(source, undefined).map((candidate) => candidate.role)).toEqual(["event", "validity"]);
    expect(inspectObservedTemporalProjection(source, undefined, undefined).projection).toBeUndefined();
    expect(inspectObservedTemporalProjection(source, laterYear, undefined)).toMatchObject({ audit: { status: "rejected" } });
    expect(inspectObservedTemporalProjection(source, laterYear, undefined).projection).toBeUndefined();
    expect(inspectObservedTemporalProjection(source, laterValidity, undefined)).toEqual({
      projection: laterValidity, audit: { status: "formed", reason: "valid_time_source_verified" }
    });
    expect(inspectObservedTemporalProjection(source, year, undefined).projection).toEqual(year);
    const context = { ...createContext(), turn_messages: [], allow_legacy_single_user_source: true };
    const local = (await new LocalHeuristics().compile(source, context))
      .filter((signal) => signal.raw_payload.time_concern !== undefined);
    expect(local).toHaveLength(2);
    expect(local[0]!.raw_payload.temporal_projection).toEqual({ ...year, projection_schema_version: "1" });
    expect(local[1]!.raw_payload.temporal_projection).toBeUndefined();
    expect(buildMemoryInput(local[1]!, ["source"]).event_time_start).toBeUndefined();
  });

  it.each([
    "I released the product in 2016/17 or in 2017.",
    "I released the product on 2016/02/03 or in 2017.",
    "I released the product on Christmas or in 2017.",
    "I released the product on Christmas or maybe in 2017.",
    "I released the product on Christmas or, by and large, in 2017.",
    "I released the product on Christmas or e.g. in 2017.",
    "I released the product on Christmas, or perhaps in 2017.",
    "I released the product on Christmas or, perhaps, in 2017.",
    "I released the product on Christmas, perhaps, or maybe in 2017.",
    "I released the product in an unknown year or in 2017.",
    "I released the product in 2017 or on Christmas.",
    "I released the product in 2017 with a partner or on Christmas.",
    "I worked from Christmas to 2017.",
    "I worked from Christmas to perhaps in 2017.",
    "I have a permit valid from 2017 to Christmas.",
    "I released the product on Christmas or Easter. I moved in 2017.",
    "我在2016/02/03或在2017年发布产品。",
    "我在未知年份或在2017年发布产品。",
    "我在未知年份或可能在2017年发布产品。",
    "I released the product on 2016-02/03 or in 2017.",
    "I released the product on 2016-02/03, or in 2017.",
    "I released the product on 2016-02-03x or in 2017.",
    "I released the product on 2016-02_03 or in 2017.",
    "I released the product on 2016-13 or in 2017.",
    "I worked from 2016-02/03 to 2017.",
    "I worked from 2016-02-03x through 2017.",
    "我在2016-02/03或在2017年发布产品。",
    "我在2016-02/03，或在2017年发布产品。",
    "我在2016-02-03x或于2017年发布产品。",
    "我从2016-02/03至2017年工作。"
  ])("retains an unsupported branch in alternative or range evidence: %s", async (source) => {
    expect(resolveSourceTemporalCandidates(source, undefined)).toEqual([]);
    expect(inspectObservedTemporalProjection(source, undefined, undefined).projection).toBeUndefined();
    for (const nomination of [laterYear, laterValidity]) {
      const result = inspectObservedTemporalProjection(source, nomination, undefined);
      expect(result.audit.status).toBe("rejected");
      expect(result.projection).toBeUndefined();
    }
    const context = { ...createContext(), turn_messages: [], allow_legacy_single_user_source: true };
    const local = (await new LocalHeuristics().compile(source, context))
      .filter((signal) => signal.raw_payload.time_concern !== undefined);
    expect(local.length).toBeGreaterThan(0);
    for (const signal of local) {
      expect(signal.raw_payload.temporal_projection).toBeUndefined();
      expect(buildMemoryInput(signal, ["source"]).event_time_start).toBeUndefined();
    }
  });

  it("preserves a governing role across whitespace allowed by date discovery", async () => {
    const source = `I have a permit valid from ${"\t ".repeat(64)}2017.`;
    expect(inspectObservedTemporalProjection(source, undefined, undefined)).toEqual({
      projection: laterValidity, audit: { status: "formed", reason: "source_valid_time_derived" }
    });
    expect(inspectObservedTemporalProjection(source, laterYear, undefined).audit.status).toBe("rejected");
    const local = (await new LocalHeuristics().compile(source, { ...createContext(), turn_messages: [],
      allow_legacy_single_user_source: true })).filter((signal) => signal.raw_payload.time_concern !== undefined);
    expect(local).toHaveLength(1);
    expect(local[0]!.raw_payload.temporal_projection).toBeUndefined();
  });

  it("keeps isolated invalid tokens, descriptive adjectives and separate clauses independent", () => {
    for (const source of ["I own model 2016.", "I paid 2016 dollars.", "I processed 2016 requests.", "I used 2016-02/03."]) {
      expect(resolveSourceTemporalCandidates(source, undefined)).toEqual([]);
    }
    for (const source of ["I used 2016-02/03. I launched an effective product in 2017.",
      "I released the product on Christmas. I moved in 2017.",
      "Product code 2016/02/03. I released the product in 2017.",
      "我在未知年份发布产品。我在2017年搬家。",
      "I released a product or a service in 2017.",
      "I announced in 2016 a policy and released a product in 2017."]) {
      expect(inspectObservedTemporalProjection(source, laterYear, undefined).audit.status).toBe("formed");
    }
    expect(inspectObservedTemporalProjection("I released an effective product in 2017.", undefined, undefined).projection).toEqual(laterYear);
    expect(inspectObservedTemporalProjection("我在2017年发布产品。", undefined, undefined).projection).toEqual(laterYear);
  });

  it("retains the accepted calendar grammar without creating local candidates for unknown words", async () => {
    expect(inspectObservedTemporalProjection("I worked from 2016 through 2017.", undefined, undefined).projection)
      .toMatchObject({ event_time_start: year.event_time_start, event_time_end: laterYear.event_time_end, time_precision: "range" });
    expect(inspectObservedTemporalProjection("I have a permit valid from 2016 to 2017.", undefined, undefined).projection)
      .toMatchObject({ valid_from: year.event_time_start, valid_to: laterYear.event_time_end, time_precision: "range" });
    for (const source of ["I released the product on Christmas.", "I released the product in an unknown year."]) {
      expect(resolveSourceTemporalCandidates(source, undefined)).toEqual([]);
      const local = await new LocalHeuristics().compile(source, { ...createContext(), turn_messages: [],
        allow_legacy_single_user_source: true });
      expect(local.filter((signal) => signal.raw_payload.time_concern !== undefined)).toEqual([]);
    }
  });

  it.each([
    "I released the product in 2016 to help people.",
    "SHADOW’s original product was released in 2016 with the promise of allowing all individuals to enjoy the power of a high-end PC from the cloud."
  ])("retains an occurrence year without turning a purpose or object to into a range: %s", async (source) => {
    expect(inspectObservedTemporalProjection(source, undefined, undefined).projection).toEqual(year);
    expect(inspectObservedTemporalProjection(source, year, undefined).audit.status).toBe("formed");
    const local = (await new LocalHeuristics().compile(source, { ...createContext(), turn_messages: [],
      allow_legacy_single_user_source: true })).filter((signal) => signal.raw_payload.time_concern !== undefined);
    expect(local).toHaveLength(1);
    expect(local[0]!.raw_payload.temporal_projection).toEqual({ ...year, projection_schema_version: "1" });
  });
});

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

  it.each([
    "I launched an effective product in 2016.",
    "I launched the product in 2016 with an effective team."
  ])("does not turn a descriptive adjective into validity: %s", (source) => {
    expect(inspectObservedTemporalProjection(source, undefined, undefined).projection).toEqual(year);
  });

  it("rejects omitted or wrong closed validity ends and preserves the independently derived complete range", () => {
    const source = "I have a permit valid from 2016 to 2017.";
    const open = { projection_schema_version: 1 as const, valid_from: year.event_time_start,
      time_precision: "year" as const, time_source: "explicit" as const };
    const complete = { ...open, valid_to: "2017-12-31T23:59:59.999Z", time_precision: "range" as const };
    for (const nomination of [open, { ...open, valid_to: year.event_time_end }]) {
      const parsed = parseOfficialApiTemporalProjection(nomination)!;
      expect(inspectObservedTemporalProjection(source, parsed, undefined)).toEqual({
        projection: complete, audit: { status: "rejected", reason: "valid_time_role_not_source_grounded" }
      });
    }
    expect(inspectObservedTemporalProjection(source, complete, undefined)).toEqual({
      projection: complete, audit: { status: "formed", reason: "valid_time_source_verified" }
    });
    expect(inspectObservedTemporalProjection("I have a permit valid from 2016.", open, undefined)).toEqual({
      projection: open, audit: { status: "formed", reason: "valid_time_source_verified" }
    });
  });

  it.each([
    "I worked from 2016 until 2017.",
    "I worked from January 1, 2016 until January 3, 2016 (exclusive).",
    "I worked from January 1, 2016 to January 3, 2016 (exclusive).",
    "I worked from January 1, 2016 through January 3, 2016, not including January 3."
  ])("abstains when an endpoint is unresolved or explicitly excluded: %s", (source) => {
    expect(inspectObservedTemporalProjection(source, undefined, undefined).projection).toBeUndefined();
    const nomination = { ...year, time_precision: "range" as const,
      event_time_start: "2016-01-01T00:00:00.000Z", event_time_end: "2016-01-03T23:59:59.999Z" };
    expect(inspectObservedTemporalProjection(source, nomination, undefined)).toMatchObject({
      audit: { status: "rejected" }
    });
    expect(inspectObservedTemporalProjection(source, nomination, undefined).projection).toBeUndefined();
  });

  it.each(["to", "through"])("keeps the supported closed %s endpoint inclusive", (connector) => {
    expect(inspectObservedTemporalProjection(`I worked from January 1, 2016 ${connector} January 3, 2016.`, undefined, undefined).projection)
      .toMatchObject({ event_time_start: year.event_time_start, event_time_end: "2016-01-03T23:59:59.999Z", time_precision: "range" });
  });

  it("uses one complete local range candidate while preserving role-ineligible and unresolved terms", async () => {
    const context = { ...createContext(), turn_messages: [], allow_legacy_single_user_source: true };
    for (const [source, count, projected] of [
      ["I worked from 2016 to 2017.", 1, true],
      ["I worked in 2016.", 1, true],
      ["I have a permit valid from 2016 to 2017.", 1, false],
      ["I worked in 2016 or 2017.", 1, false]
    ] as const) {
      const signals = (await new LocalHeuristics().compile(source, context))
        .filter((signal) => signal.raw_payload.time_concern !== undefined);
      expect(signals).toHaveLength(count);
      for (const signal of signals) {
        expect(signal.raw_payload.temporal_projection !== undefined).toBe(projected);
        const memoryInput = buildMemoryInput(signal, ["source-evidence"]);
        expect(memoryInput.event_time_start ?? null).toBe(projected ? year.event_time_start : null);
        if (source === "I worked from 2016 to 2017.") {
          expect(signal.raw_payload.temporal_projection).toMatchObject({
            event_time_start: year.event_time_start, event_time_end: "2017-12-31T23:59:59.999Z"
          });
          expect(memoryInput.event_time_end).toBe("2017-12-31T23:59:59.999Z");
        }
      }
    }
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
