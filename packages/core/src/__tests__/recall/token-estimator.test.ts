import { describe, expect, it } from "vitest";
import { makeTokenEstimator } from "../../recall/runtime/recall-service-types.js";

describe("recall token estimator", () => {
  it("uses the configured transport token estimate", () => {
    const text = "x".repeat(101);
    expect(makeTokenEstimator().estimate(text)).toBe(Math.ceil(text.length / 4));
    expect(makeTokenEstimator({ hint: "approx_chars_per_token" }).estimate(text)).toBe(Math.ceil(text.length / 4));
    expect(makeTokenEstimator({ hint: "cl100k" }).estimate(text)).toBe(Math.ceil(text.length / 3.6));
    expect(makeTokenEstimator({ hint: "o200k" }).estimate(text)).toBe(Math.ceil(text.length / 3.2));
  });
});
