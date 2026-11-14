import { describe, expect, it } from "vitest";
import { normalizeCanonicalEntities } from "../../shared/schema-primitives.js";

describe("normalizeCanonicalEntities", () => {
  it("trims, lowercases, dedupes, and caps at three", () => {
    expect(normalizeCanonicalEntities(["Alice", " alice ", "Postgres", "Acme", "Redis"])).toEqual([
      "alice",
      "postgres",
      "acme"
    ]);
  });

  it("drops empty tokens", () => {
    expect(normalizeCanonicalEntities(["  ", "Bob"])).toEqual(["bob"]);
    expect(normalizeCanonicalEntities([])).toEqual([]);
  });
});
