import { describe, expect, it } from "vitest";
import { parseSurfaceUri } from "../../shared/surface-uri.js";

describe("parseSurfaceUri", () => {
  it("accepts non-empty slash-separated surface segments", () => {
    expect(parseSurfaceUri("surface://repo/path.main", "surface_id")).toBe("surface://repo/path.main");
  });

  it.each([
    "surface://",
    "surface://repo//main",
    "surface://repo:",
    "surface://repo/main:"
  ])("rejects degenerate surface URI %s", (value) => {
    expect(() => parseSurfaceUri(value, "surface_id")).toThrow("surface_id must be a surface:// URI");
  });
});
