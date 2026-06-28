import { afterEach, describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from "../../recall/recall-query-probes.js";
import {
  parseQueryTimeWindow,
  scoreTemporalQueryWindow,
  temporalQueryWindowEnabled
} from "../../recall/temporal-fusion-scoring.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("temporalQueryWindowEnabled", () => {
  afterEach(() => {
    delete process.env.ALAYA_RECALL_TEMPORAL_WINDOW;
  });

  it("defaults off and reads truthy flag spellings", () => {
    expect(temporalQueryWindowEnabled()).toBe(false);
    for (const value of ["1", "true", "on", "yes", "ON"]) {
      process.env.ALAYA_RECALL_TEMPORAL_WINDOW = value;
      expect(temporalQueryWindowEnabled()).toBe(true);
    }
    process.env.ALAYA_RECALL_TEMPORAL_WINDOW = "off";
    expect(temporalQueryWindowEnabled()).toBe(false);
  });
});

describe("parseQueryTimeWindow", () => {
  it("parses an ISO month term into a calendar-month window", () => {
    const window = parseQueryTimeWindow(compileRecallQueryProbes("what changed in 2023-05?"));
    expect(window).toEqual({
      startMs: Date.UTC(2023, 4, 1),
      endMs: Date.UTC(2023, 5, 1) - 1
    });
  });

  it("parses an ISO day term into a single-day window", () => {
    const window = parseQueryTimeWindow(compileRecallQueryProbes("the 2023-05-12 incident"));
    expect(window).toEqual({
      startMs: Date.UTC(2023, 4, 12),
      endMs: Date.UTC(2023, 4, 12) + 86_400_000 - 1
    });
  });

  it("parses a CJK month term into a calendar-month window", () => {
    const window = parseQueryTimeWindow(compileRecallQueryProbes("我2023年5月做了什么"));
    expect(window).toEqual({
      startMs: Date.UTC(2023, 4, 1),
      endMs: Date.UTC(2023, 5, 1) - 1
    });
  });

  it("returns null when date_terms carry only now-relative phrases", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what did we decide last week"))).toBeNull();
    expect(parseQueryTimeWindow(compileRecallQueryProbes("上周的结论"))).toBeNull();
  });

  it("returns null when there is no time intent at all", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("how does recall work"))).toBeNull();
  });
});

describe("scoreTemporalQueryWindow", () => {
  const mayWindow = { startMs: Date.UTC(2023, 4, 1), endMs: Date.UTC(2023, 5, 1) - 1 };

  it("scores an event inside the window at full strength", () => {
    const entry = createMemoryEntry({ event_time_start: "2023-05-15T00:00:00.000Z" });
    expect(scoreTemporalQueryWindow(entry, mayWindow)).toBe(1);
  });

  it("scores an interval that overlaps the window at full strength", () => {
    const entry = createMemoryEntry({
      event_time_start: "2023-04-20T00:00:00.000Z",
      event_time_end: "2023-05-05T00:00:00.000Z"
    });
    expect(scoreTemporalQueryWindow(entry, mayWindow)).toBe(1);
  });

  it("decays for an event before the window by distance", () => {
    const before = createMemoryEntry({ event_time_start: "2023-04-01T00:00:00.000Z" });
    const farBefore = createMemoryEntry({ event_time_start: "2023-01-01T00:00:00.000Z" });
    const beforeScore = scoreTemporalQueryWindow(before, mayWindow);
    expect(beforeScore).toBeGreaterThan(0);
    expect(beforeScore).toBeLessThan(1);
    expect(scoreTemporalQueryWindow(farBefore, mayWindow)).toBeLessThan(beforeScore);
  });

  it("decays for an event after the window by distance", () => {
    const after = createMemoryEntry({ event_time_start: "2023-06-15T00:00:00.000Z" });
    const score = scoreTemporalQueryWindow(after, mayWindow);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("clamps to zero past the decay horizon", () => {
    const distant = createMemoryEntry({ event_time_start: "2024-01-01T00:00:00.000Z" });
    expect(scoreTemporalQueryWindow(distant, mayWindow)).toBe(0);
  });

  it("returns zero when the event falls outside its valid interval", () => {
    const entry = createMemoryEntry({
      event_time_start: "2023-05-15T00:00:00.000Z",
      valid_from: "2023-06-01T00:00:00.000Z"
    });
    expect(scoreTemporalQueryWindow(entry, mayWindow)).toBe(0);
  });

  it("returns zero when the entry carries no event time", () => {
    expect(scoreTemporalQueryWindow(createMemoryEntry(), mayWindow)).toBe(0);
  });
});
