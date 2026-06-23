import { describe, expect, it } from "vitest";
import { constantTimeTokenEqual } from "../../shared/constant-time-token.js";

describe("constantTimeTokenEqual", () => {
  it("returns true for identical tokens", () => {
    expect(constantTimeTokenEqual("secret-token", "secret-token")).toBe(true);
  });

  it("returns false for a same-length mismatch", () => {
    expect(constantTimeTokenEqual("secret-tokeX", "secret-token")).toBe(false);
  });

  it("returns false for a shorter token without leaking via an early length return", () => {
    expect(constantTimeTokenEqual("secret", "secret-token")).toBe(false);
  });

  it("returns false for a longer token", () => {
    expect(constantTimeTokenEqual("secret-token-extra", "secret-token")).toBe(false);
  });

  it("returns false when both tokens are empty-padded but differ in length", () => {
    expect(constantTimeTokenEqual("", "x")).toBe(false);
  });
});
