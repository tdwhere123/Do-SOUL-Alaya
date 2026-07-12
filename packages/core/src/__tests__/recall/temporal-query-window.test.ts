import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  parseQueryTimeWindow,
  scoreTemporalEventTime,
  scoreTemporalQueryWindow
} from "../../recall/scoring/temporal-fusion-scoring.js";
import { scoreTemporalFusion } from "../../recall/delivery/fusion-delivery-scoring-streams.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

describe("parseQueryTimeWindow", () => {
  it("parses an ISO month term into a calendar-month window", () => {
    const window = parseQueryTimeWindow(compileRecallQueryProbes("what changed in 2023-05?"));
    expect(window).toEqual({
      startMs: Date.UTC(2023, 4, 1),
      endMs: Date.UTC(2023, 5, 1) - 1
    });
  });

  it("parses natural month and year expressions through the shared calendar contract", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what changed in March 2024?"))).toEqual({
      startMs: Date.UTC(2024, 2, 1),
      endMs: Date.UTC(2024, 3, 1) - 1
    });
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what changed in 2024?"))).toEqual({
      startMs: Date.UTC(2024, 0, 1),
      endMs: Date.UTC(2025, 0, 1) - 1
    });
    expect(parseQueryTimeWindow(compileRecallQueryProbes("2025年发生了什么?"))).toEqual({
      startMs: Date.UTC(2025, 0, 1),
      endMs: Date.UTC(2026, 0, 1) - 1
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

  it("parses only unambiguous slash dates", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what changed on 2023/05/12?"))).toEqual({
      startMs: Date.UTC(2023, 4, 12),
      endMs: Date.UTC(2023, 4, 12) + 86_400_000 - 1
    });
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what changed on 2023/5/2?"))).toEqual({
      startMs: Date.UTC(2023, 4, 2),
      endMs: Date.UTC(2023, 4, 2) + 86_400_000 - 1
    });
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what changed on 05/12/2023?"))).toBeNull();
  });

  it("rejects impossible calendar dates instead of normalizing them", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what changed on 2026-02-31?"))).toBeNull();
  });

  it("does not turn an unparseable date term into ordinary recency", () => {
    const probes = compileRecallQueryProbes("what changed on 05/12/2023?");
    const recent = createMemoryEntry({ event_time_start: "2026-07-11T00:00:00.000Z" });
    expect(scoreTemporalEventTime(recent, "2026-07-12T00:00:00.000Z")).toBeGreaterThan(0);
    expect(scoreTemporalFusion(recent, probes, "2026-07-12T00:00:00.000Z")).toBe(0);
  });

  it("returns null when date_terms carry only now-relative phrases", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what did we decide last week"))).toBeNull();
    expect(parseQueryTimeWindow(compileRecallQueryProbes("上周的结论"))).toBeNull();
  });

  it("returns null when there is no time intent at all", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("how does recall work"))).toBeNull();
  });
});

describe("parseQueryTimeWindow anchored relative resolution", () => {
  // 2023-05-17 is a Wednesday; its Monday-anchored week starts 2023-05-15.
  const anchor = "2023-05-17T08:30:00.000Z";

  it("leaves relative terms unresolved on the un-anchored path (flag-off parity)", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what did we decide last week"))).toBeNull();
    expect(parseQueryTimeWindow(compileRecallQueryProbes("上周的结论"))).toBeNull();
  });

  it("returns null when the anchor is not a parseable timestamp", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("last week"), "not-a-date")).toBeNull();
  });

  it("resolves last week to the prior Monday-anchored 7-day window", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what did we decide last week"), anchor)).toEqual({
      startMs: Date.UTC(2023, 4, 8),
      endMs: Date.UTC(2023, 4, 15) - 1
    });
  });

  it("is case-insensitive for relative phrases", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("What did we decide LAST WEEK?"), anchor)).toEqual({
      startMs: Date.UTC(2023, 4, 8),
      endMs: Date.UTC(2023, 4, 15) - 1
    });
  });

  it("resolves today and yesterday to single-day windows", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what happened today"), anchor)).toEqual({
      startMs: Date.UTC(2023, 4, 17),
      endMs: Date.UTC(2023, 4, 17) + 86_400_000 - 1
    });
    expect(parseQueryTimeWindow(compileRecallQueryProbes("the yesterday outage"), anchor)).toEqual({
      startMs: Date.UTC(2023, 4, 16),
      endMs: Date.UTC(2023, 4, 16) + 86_400_000 - 1
    });
  });

  it("resolves CJK 上个月 to the prior calendar month", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("上个月的决定"), anchor)).toEqual({
      startMs: Date.UTC(2023, 3, 1),
      endMs: Date.UTC(2023, 4, 1) - 1
    });
  });

  it("resolves CJK 去年 to the prior calendar year", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("去年发生了什么"), anchor)).toEqual({
      startMs: Date.UTC(2022, 0, 1),
      endMs: Date.UTC(2023, 0, 1) - 1
    });
  });

  it("keeps absolute-term precedence over relative terms even when anchored", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("compare 2023-05 to last week"), anchor)).toEqual({
      startMs: Date.UTC(2023, 4, 1),
      endMs: Date.UTC(2023, 5, 1) - 1
    });
  });
});

describe("parseQueryTimeWindow relative product terms", () => {
  // 2023-05-17 is a Wednesday; its Monday-anchored week starts 2023-05-15.
  const anchor = "2023-05-17T08:30:00.000Z";

  it("captures relative terms without an environment gate", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what shipped last summer"), anchor)).not.toBeNull();
    expect(parseQueryTimeWindow(compileRecallQueryProbes("the outage 2 weeks ago"), anchor)).not.toBeNull();
  });

  it("resolves last summer to the prior year's June–August window", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what shipped last summer"), anchor)).toEqual({
      startMs: Date.UTC(2022, 5, 1),
      endMs: Date.UTC(2022, 8, 1) - 1
    });
  });

  it("resolves this winter across the Dec–Feb year boundary", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what is planned this winter"), anchor)).toEqual({
      startMs: Date.UTC(2023, 11, 1),
      endMs: Date.UTC(2024, 2, 1) - 1
    });
  });

  it("resolves N days ago to a single-day window", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("what did we decide 3 days ago"), anchor)).toEqual({
      startMs: Date.UTC(2023, 4, 14),
      endMs: Date.UTC(2023, 4, 14) + 86_400_000 - 1
    });
  });

  it("resolves N weeks ago to a Monday-anchored week window", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("the outage 2 weeks ago"), anchor)).toEqual({
      startMs: Date.UTC(2023, 4, 1),
      endMs: Date.UTC(2023, 4, 8) - 1
    });
  });

  it("resolves N months ago to a calendar-month window", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("the plan 2 months ago"), anchor)).toEqual({
      startMs: Date.UTC(2023, 2, 1),
      endMs: Date.UTC(2023, 3, 1) - 1
    });
  });

  it("resolves CJK N天前 to a single-day window", () => {
    expect(parseQueryTimeWindow(compileRecallQueryProbes("3天前的决定"), anchor)).toEqual({
      startMs: Date.UTC(2023, 4, 14),
      endMs: Date.UTC(2023, 4, 14) + 86_400_000 - 1
    });
  });
});

describe("scoreTemporalQueryWindow", () => {
  const mayWindow = { startMs: Date.UTC(2023, 4, 1), endMs: Date.UTC(2023, 5, 1) - 1 };
  const nowIso = "2023-06-15T00:00:00.000Z";

  it("scores an event inside the window at full strength", () => {
    const entry = createMemoryEntry({ event_time_start: "2023-05-15T00:00:00.000Z" });
    expect(scoreTemporalQueryWindow(entry, mayWindow, nowIso)).toBe(1);
  });

  it("scores an interval that overlaps the window at full strength", () => {
    const entry = createMemoryEntry({
      event_time_start: "2023-04-20T00:00:00.000Z",
      event_time_end: "2023-05-05T00:00:00.000Z"
    });
    expect(scoreTemporalQueryWindow(entry, mayWindow, nowIso)).toBe(1);
  });

  it("decays for an event before the window by distance", () => {
    const before = createMemoryEntry({ event_time_start: "2023-04-01T00:00:00.000Z" });
    const farBefore = createMemoryEntry({ event_time_start: "2023-01-01T00:00:00.000Z" });
    const beforeScore = scoreTemporalQueryWindow(before, mayWindow, nowIso);
    expect(beforeScore).toBeGreaterThan(0);
    expect(beforeScore).toBeLessThan(1);
    expect(scoreTemporalQueryWindow(farBefore, mayWindow, nowIso)).toBeLessThan(beforeScore);
  });

  it("decays for an event after the window by distance", () => {
    const after = createMemoryEntry({ event_time_start: "2023-06-15T00:00:00.000Z" });
    const score = scoreTemporalQueryWindow(after, mayWindow, nowIso);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("clamps to zero past the decay horizon", () => {
    const distant = createMemoryEntry({ event_time_start: "2024-01-01T00:00:00.000Z" });
    expect(scoreTemporalQueryWindow(distant, mayWindow, nowIso)).toBe(0);
  });

  it("scores ingested-later historical events when now is inside the valid interval", () => {
    const entry = createMemoryEntry({
      event_time_start: "2023-05-15T00:00:00.000Z",
      valid_from: "2023-06-01T00:00:00.000Z"
    });
    expect(scoreTemporalQueryWindow(entry, mayWindow, nowIso)).toBe(1);
  });

  it("returns zero when now falls outside the valid interval", () => {
    const entry = createMemoryEntry({
      event_time_start: "2023-05-15T00:00:00.000Z",
      valid_to: "2023-06-01T00:00:00.000Z"
    });
    expect(scoreTemporalQueryWindow(entry, mayWindow, nowIso)).toBe(0);
  });

  it("returns zero when now is not parseable", () => {
    const entry = createMemoryEntry({ event_time_start: "2023-05-15T00:00:00.000Z" });
    expect(scoreTemporalQueryWindow(entry, mayWindow, "not-a-date")).toBe(0);
  });

  it("returns zero when the entry carries no event time", () => {
    expect(scoreTemporalQueryWindow(createMemoryEntry(), mayWindow, nowIso)).toBe(0);
  });

  it("normalizes inverted event_time_start/end intervals", () => {
    const canonical = createMemoryEntry({
      event_time_start: "2023-05-15T00:00:00.000Z",
      event_time_end: "2023-05-16T23:59:59.999Z"
    });
    const inverted = createMemoryEntry({
      event_time_start: "2023-05-16T23:59:59.999Z",
      event_time_end: "2023-05-15T00:00:00.000Z"
    });
    expect(scoreTemporalQueryWindow(inverted, mayWindow, nowIso)).toBe(
      scoreTemporalQueryWindow(canonical, mayWindow, nowIso)
    );
    expect(scoreTemporalEventTime(inverted, nowIso)).toBe(scoreTemporalEventTime(canonical, nowIso));
  });
});
