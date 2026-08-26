import { describe, expect, it } from "vitest";
import { POST_TURN_EXTRACT_EXCERPT_MAX_CHARS } from "../../index.js";

describe("garden extract constants", () => {
  it("exports the post-turn excerpt cap", () => {
    expect(POST_TURN_EXTRACT_EXCERPT_MAX_CHARS).toBe(800);
  });
});
