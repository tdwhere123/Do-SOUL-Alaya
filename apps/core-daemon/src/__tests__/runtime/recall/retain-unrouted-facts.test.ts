import { afterEach, describe, expect, it } from "vitest";
import { isRetainUnroutedFactsEnabled } from "../../../runtime/recall-materialization/recall-materialization-router.js";

const ORIGINAL = process.env.ALAYA_RETAIN_UNROUTED_FACTS;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.ALAYA_RETAIN_UNROUTED_FACTS;
  } else {
    process.env.ALAYA_RETAIN_UNROUTED_FACTS = ORIGINAL;
  }
});

describe("ALAYA_RETAIN_UNROUTED_FACTS", () => {
  it("defaults off unless the env is 1 or true", () => {
    delete process.env.ALAYA_RETAIN_UNROUTED_FACTS;
    expect(isRetainUnroutedFactsEnabled()).toBe(false);

    process.env.ALAYA_RETAIN_UNROUTED_FACTS = "0";
    expect(isRetainUnroutedFactsEnabled()).toBe(false);

    process.env.ALAYA_RETAIN_UNROUTED_FACTS = "false";
    expect(isRetainUnroutedFactsEnabled()).toBe(false);

    process.env.ALAYA_RETAIN_UNROUTED_FACTS = "1";
    expect(isRetainUnroutedFactsEnabled()).toBe(true);

    process.env.ALAYA_RETAIN_UNROUTED_FACTS = "true";
    expect(isRetainUnroutedFactsEnabled()).toBe(true);
  });
});
