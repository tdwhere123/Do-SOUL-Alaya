import { describe, expect, it } from "vitest";
import { captureData } from "../../../recall/decision/capture-data.js";
import { ShadowContractError } from "../../../recall/decision/contract-primitives.js";

describe("captureData", () => {
  it("rejects getters, setters, and proxies instead of reading the live trap", () => {
    const withGetter = Object.defineProperty({ keep: 1 }, "secret", {
      enumerable: true,
      get: () => 2
    });
    expect(() => captureData(withGetter)).toThrow(ShadowContractError);
    expect(() => captureData(new Proxy({ keep: 1 }, {}))).toThrow(ShadowContractError);
  });

  it("copies own data values and ignores later mutation", () => {
    const source = { keep: 1, nested: { n: 2 } };
    const captured = captureData(source);
    source.keep = 9;
    source.nested.n = 9;
    expect(captured).toEqual({ keep: 1, nested: { n: 2 } });
  });
});
