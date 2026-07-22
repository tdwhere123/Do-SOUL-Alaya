import { describe, expect, it } from "vitest";
import { buildOfficialApiSourceAssertions } from "../../garden/grounding/source-locator.js";

describe("official API bounded template-slot source locator", () => {
  it("publishes the complete adjacent template field and subject binding", () => {
    const source = 'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a coffee shop in the city.';

    expect(buildOfficialApiSourceAssertions(source).map((assertion) => assertion.text))
      .toContain(source);
  });
});
