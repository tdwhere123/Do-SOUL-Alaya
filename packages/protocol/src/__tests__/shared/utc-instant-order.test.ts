import { describe, expect, it } from "vitest";
import { compareUtcInstants, utcInstantOrderKey } from "../../index.js";

describe("exact UTC instant order", () => {
  it("orders every significant fractional digit with binary string comparison", () => {
    const ordered = [
      "2026-09-21T23:59:59.999999999999999999Z",
      "2026-09-22T00:00Z",
      "2026-09-22T00:00:00.00000000001Z",
      "2026-09-22T00:00:00.00000000002Z",
      "2026-09-22T00:00:00.1Z",
      "2026-09-22T00:00:00.10000000001Z",
      "2026-09-22T00:00:00.11Z",
      "2026-09-22T00:00:01Z"
    ];
    const keys = ordered.map((value) => utcInstantOrderKey(value));
    expect([...keys].reverse().sort()).toEqual(keys);
    for (let i = 1; i < ordered.length; i++) {
      expect(compareUtcInstants(ordered[i - 1]!, ordered[i]!)).toBe(-1);
    }
  });

  it("canonicalizes equivalent spellings and rejects invalid instants", () => {
    for (const suffix of ["Z", ":00Z", ":00.000000000000Z"]) {
      expect(utcInstantOrderKey(`2026-09-22T00:00${suffix}`)).toBe("2026-09-22T00:00:00.");
    }
    expect(utcInstantOrderKey("2026-09-22T00:00:00.123400Z"))
      .toBe(utcInstantOrderKey("2026-09-22T00:00:00.1234Z"));
    for (const invalid of ["invalid", "2026-02-30T00:00Z", "2026-09-22T00:00:00+00:00"]) {
      expect(utcInstantOrderKey(invalid)).toBeUndefined();
      expect(compareUtcInstants(invalid, "2026-09-22T00:00Z")).toBeUndefined();
    }
  });
});
