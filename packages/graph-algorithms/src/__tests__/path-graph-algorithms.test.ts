import { describe, expect, it } from "vitest";
import { countStronglyConnectedComponents } from "../index.js";

describe("countStronglyConnectedComponents", () => {
  it("counts cyclic and isolated path graph components", () => {
    const adjacency = new Map<string, ReadonlySet<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
      ["c", new Set(["d"])],
      ["d", new Set()],
      ["e", new Set()]
    ]);

    expect(countStronglyConnectedComponents(["a", "b", "c", "d", "e"], adjacency)).toBe(4);
  });
});
