import { describe, expect, it } from "vitest";
import {
  classifyGovernedValidity,
  groundDualTime,
  isHardActive,
  orderCompetingStates,
  requireRecordedAt
} from "../../governance/effects/dual-time.js";

const RECORDED = "2026-08-16T00:00:00.000Z";
const EARLIER = "2026-08-15T00:00:00.000Z";
const LATER = "2026-08-17T00:00:00.000Z";

describe("dual-time grounding", () => {
  it("requires recorded_at and never copies storage time into valid or event time", () => {
    expect(() => requireRecordedAt(null)).toThrow(/recorded_at is required/u);
    expect(groundDualTime({
      recorded_at: RECORDED,
      event_time: RECORDED,
      valid_from: RECORDED,
      valid_to: LATER,
      event_time_source: "storage",
      valid_time_source: "storage"
    })).toEqual({
      recorded_at: RECORDED,
      event_time: null,
      valid_from: null,
      valid_to: null
    });
  });

  it("keeps source-grounded event and valid time separate from recorded_at", () => {
    expect(groundDualTime({
      recorded_at: RECORDED,
      event_time: EARLIER,
      valid_from: EARLIER,
      valid_to: LATER,
      event_time_source: "source",
      valid_time_source: "source"
    })).toEqual({
      recorded_at: RECORDED,
      event_time: EARLIER,
      valid_from: EARLIER,
      valid_to: LATER
    });
  });

  it("treats unknown valid time as soft-recallable, never hard-active", () => {
    expect(classifyGovernedValidity({ valid_from: null, valid_to: null }, RECORDED))
      .toBe("soft_recallable");
    expect(isHardActive({ valid_from: null, valid_to: null }, RECORDED)).toBe(false);
    expect(isHardActive({ valid_from: EARLIER, valid_to: null }, RECORDED)).toBe(true);
    expect(isHardActive({ valid_from: LATER, valid_to: null }, RECORDED)).toBe(false);
  });

  it("orders competing state by grounded valid_from, then event_time, then recorded_at", () => {
    const ordered = orderCompetingStates([
      {
        id: "fallback",
        recorded_at: EARLIER,
        event_time: null,
        valid_from: null,
        valid_to: null
      },
      {
        id: "later-valid",
        recorded_at: EARLIER,
        event_time: EARLIER,
        valid_from: LATER,
        valid_to: null
      },
      {
        id: "earlier-valid",
        recorded_at: RECORDED,
        event_time: LATER,
        valid_from: EARLIER,
        valid_to: null
      }
    ]);
    expect(ordered.map((state) => state.id)).toEqual([
      "earlier-valid",
      "later-valid",
      "fallback"
    ]);
    expect(ordered[2]?.fallback_recorded_at).toBe(true);
    expect(ordered[0]?.fallback_recorded_at).toBe(false);
  });
});
