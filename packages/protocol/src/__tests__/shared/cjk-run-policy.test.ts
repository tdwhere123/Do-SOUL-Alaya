import { describe, expect, it } from "vitest";
import { fallbackCjkRunPieces } from "../../shared/cjk-run-policy.js";

describe("CJK run policy fallback", () => {
  it("splits interrogative atoms without a native segmenter", () => {
    expect(fallbackCjkRunPieces("多久部署")).toEqual(["多久", "部署"]);
    expect(fallbackCjkRunPieces("我爱北京")).toEqual(["我爱北京"]);
  });
});
