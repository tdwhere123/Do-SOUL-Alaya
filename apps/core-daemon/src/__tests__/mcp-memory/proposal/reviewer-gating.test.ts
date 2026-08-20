import { describe, expect, it } from "vitest";
import { matchesReviewerToken } from "../../../mcp-memory/proposal/reviewer-gating.js";

describe("matchesReviewerToken", () => {
  it("rejects missing or empty tokens", () => {
    expect(matchesReviewerToken(undefined, "secret-token")).toBe(false);
    expect(matchesReviewerToken("", "secret-token")).toBe(false);
  });

  it("accepts an exact match and rejects length-mismatched tokens", () => {
    expect(matchesReviewerToken("secret-token", "secret-token")).toBe(true);
    expect(matchesReviewerToken("secret", "secret-token")).toBe(false);
    expect(matchesReviewerToken("secret-token-extra", "secret-token")).toBe(false);
  });
});
