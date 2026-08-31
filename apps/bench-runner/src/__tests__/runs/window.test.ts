import { describe, expect, it } from "vitest";
import { selectOffsetLimitWindow } from "../../runs/window.js";

describe("selectOffsetLimitWindow", () => {
  const items = ["a", "b", "c", "d"];

  it("returns the full collection when offset and limit are omitted", () => {
    expect(selectOffsetLimitWindow(items, {})).toEqual(items);
  });

  it("pins a slice from offset through offset+limit", () => {
    expect(selectOffsetLimitWindow(items, { offset: 1, limit: 2 })).toEqual(["b", "c"]);
  });

  it("treats a negative offset as zero", () => {
    expect(selectOffsetLimitWindow(items, { offset: -3, limit: 2 })).toEqual(["a", "b"]);
  });
});
