import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
afterEach(() => vi.unstubAllEnvs());

describe("retired passive supplement entry", () => {
  it("refuses explicit supplemental compilation before reading a receipt or constructing a transport", () => {
    const extractorFactory = vi.fn();
    expect(() => createCompileSeedRunner({ extractorFactory, sourceAssertionSupplement: {
      receiptPath: "/must-not-read/receipt.json", sourceCacheRoot: "/must-not-read/source"
    } })).toThrow("supplemental passive extraction is retired");
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it.each(["ALAYA_BENCH_SOURCE_ASSERTION_SUPPLEMENT_RECEIPT", "ALAYA_BENCH_SOURCE_ASSERTION_SUPPLEMENT_CACHE_ROOT"])(
    "does not reactivate the retired producer through %s", name => {
      vi.stubEnv(name, "/must-not-read");
      expect(() => createCompileSeedRunner()).toThrow("supplemental passive extraction is retired");
    });
});
