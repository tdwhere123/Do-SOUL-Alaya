import { describe, expect, it } from "vitest";
import { SURFACE_URI_PATTERN } from "../../surfaces/surface.js";

describe("SURFACE_URI_PATTERN", () => {
  it("accepts slash-separated surface segments", () => {
    expect(SURFACE_URI_PATTERN.test("surface://repo/path.main")).toBe(true);
  });

  it.each([
    "surface://",
    "surface://repo//main",
    "surface://repo:",
    "surface://repo/main:"
  ])("rejects degenerate surface URI %s", (value) => {
    expect(SURFACE_URI_PATTERN.test(value)).toBe(false);
  });
});
