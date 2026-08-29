import { describe, expect, it } from "vitest";
import * as support from "../../../../recall/shadow/support/index.js";

describe("support hypergraph surface", () => {
  it("has no durable write or public protocol API", () => {
    const names = Object.keys(support);
    expect(names.some((name) => /persist|save|event|protocol|mcp/iu.test(name))).toBe(false);
    expect(names).toContain("createSupportHypergraph");
    expect(names).not.toContain("toPublicJson");
  });
});
