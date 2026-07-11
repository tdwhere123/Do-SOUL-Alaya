import { describe, expect, it } from "vitest";
import { parseOfficialApiSignals } from "../../garden/compute-provider.js";

describe("parseOfficialApiSignals invalid envelope rejection", () => {
  it("throws when signals is not an array", () => {
    expect(() => parseOfficialApiSignals(JSON.stringify({ signals: "not-an-array" }))).toThrow(
      /signals array missing/u
    );
  });

  it("throws when the envelope omits signals", () => {
    expect(() => parseOfficialApiSignals(JSON.stringify({ oops: [] }))).toThrow(
      /signals array missing/u
    );
  });

  it("throws when the parsed top-level value is not an object", () => {
    expect(() => parseOfficialApiSignals(JSON.stringify(["not", "an", "envelope"]))).toThrow(
      /signals array missing/u
    );
  });
});
