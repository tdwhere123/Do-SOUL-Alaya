import { describe, expect, it } from "vitest";
import { computeOfficialApiSourceCorpusIdentity } from
  "../../../../garden/ingestion/official-api/extraction-request.js";
import { OFFICIAL_API_GROUNDED_EXAMPLES } from
  "../../../../garden/ingestion/official-api/source-examples.js";

describe("official API grounded examples", () => {
  it("derives each example corpus identity from its assertion texts", () => {
    expect(OFFICIAL_API_GROUNDED_EXAMPLES.length).toBeGreaterThan(0);
    for (const example of OFFICIAL_API_GROUNDED_EXAMPLES) {
      const sourceCorpus = example.input.source_assertions
        .map((assertion) => assertion.text)
        .join("\n");
      expect(example.input.source_corpus_identity).toBe(
        computeOfficialApiSourceCorpusIdentity(sourceCorpus)
      );
    }
  });
});
