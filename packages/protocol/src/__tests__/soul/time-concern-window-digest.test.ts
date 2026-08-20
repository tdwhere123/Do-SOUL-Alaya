import { describe, expect, it } from "vitest";
import {
  createTimeConcernWindowDigest,
  timeConcernWindowDigestsMatch
} from "../../soul/time-concern-window-digest.js";

describe("time concern window digests", () => {
  it("matches canonical windows by interval overlap", () => {
    const march = createTimeConcernWindowDigest(
      "2026-03-01T00:00:00.000Z",
      "2026-03-31T23:59:59.999Z"
    );
    const day = createTimeConcernWindowDigest(
      "2026-03-19T00:00:00.000Z",
      "2026-03-19T23:59:59.999Z"
    );
    const april = createTimeConcernWindowDigest(
      "2026-04-01T00:00:00.000Z",
      "2026-04-30T23:59:59.999Z"
    );

    expect(timeConcernWindowDigestsMatch(march, day)).toBe(true);
    expect(timeConcernWindowDigestsMatch(march, april)).toBe(false);
  });

  it("keeps normalized lexical matching for historical paths", () => {
    expect(timeConcernWindowDigestsMatch("Last Week", "last_week")).toBe(true);
    expect(timeConcernWindowDigestsMatch("last_week", "next_week")).toBe(false);
  });

  it("rejects invalid or reversed canonical interval inputs", () => {
    expect(() => createTimeConcernWindowDigest("not-a-date", "2026-03-19")).toThrow();
    expect(() => createTimeConcernWindowDigest("2026-03-20", "2026-03-19")).toThrow();
  });

  it("round-trips valid intervals before the Unix epoch", () => {
    const day = createTimeConcernWindowDigest(
      "1969-12-31T00:00:00.000Z",
      "1969-12-31T23:59:59.999Z"
    );

    expect(timeConcernWindowDigestsMatch(day, day)).toBe(true);
  });
});
