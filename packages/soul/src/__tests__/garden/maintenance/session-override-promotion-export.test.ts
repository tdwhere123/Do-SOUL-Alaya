import { describe, expect, it } from "vitest";
import * as soul from "../../../index.js";

describe("Garden package surface", () => {
  it("does not export the unused session-override promotion implementation", () => {
    expect(Object.prototype.hasOwnProperty.call(soul, "SessionOverrideRemediation")).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(soul, "SessionOverrideRemediationDependencies")
    ).toBe(false);
  });
});
