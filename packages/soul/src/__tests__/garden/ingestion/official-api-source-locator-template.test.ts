import { describe, expect, it } from "vitest";
import { buildOfficialApiSourceAssertions } from "../../../garden/triage/grounding/source-locator.js";

describe("official API source locator template boundaries", () => {
  it("does not publish a template pair with unresolved pronouns", () => {
    const source = 'Under "How We Met", I\'ll include the location where I met them. For Sophia, it was a coffee shop in the city.';

    const explicit = "I met Sophia at a coffee shop in the city.";
    expect(buildOfficialApiSourceAssertions(`${source} ${explicit}`).map((assertion) => assertion.text))
      .toEqual([explicit]);
  });
});
