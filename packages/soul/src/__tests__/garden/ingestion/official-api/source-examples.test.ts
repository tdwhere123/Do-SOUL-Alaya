import { describe, expect, it } from "vitest";
import {
  buildOfficialApiExtractionRequests,
  computeOfficialApiSourceCorpusIdentity
} from "../../../../garden/ingestion/official-api/extraction-request.js";
import { OFFICIAL_API_GROUNDED_EXAMPLES } from
  "../../../../garden/ingestion/official-api/source-examples.js";
import { buildOfficialApiSourceCorpus } from
  "../../../../garden/triage/grounding/source-locator.js";

const EXAMPLE_SOURCES = [
  "In 2020, I opened a workshop and promised to lend tools.",
  "I can borrow tools in the workshop only on Saturdays.",
  "The exhibit opened in 2019 with the aim of helping visitors learn ceramics.",
  "Nia told Nia to wait."
] as const;

describe("official API grounded examples", () => {
  it("derives each example corpus identity from the extraction source corpus", () => {
    expect(OFFICIAL_API_GROUNDED_EXAMPLES).toHaveLength(EXAMPLE_SOURCES.length);
    OFFICIAL_API_GROUNDED_EXAMPLES.forEach((example, index) => {
      const source = EXAMPLE_SOURCES[index]!;
      expect(example.input.source_corpus_identity).toBe(
        computeOfficialApiSourceCorpusIdentity(buildOfficialApiSourceCorpus(source, []))
      );
      expect(example.input).toEqual(buildOfficialApiExtractionRequests(source, [])[0]);
    });
  });

  it("selects a repeated phrase with occurrence 0 then 1 and omits occurrence on unique phrases", () => {
    const example = OFFICIAL_API_GROUNDED_EXAMPLES[3]!;
    const relation = example.output.interpretations[0]!.relations[0]!;
    expect(relation.predicate).toEqual({ text: "told" });
    expect(relation.arguments.map((item) => item.phrase)).toEqual([
      { text: "Nia", occurrence: 0 },
      { text: "Nia", occurrence: 1 },
      { text: "to wait" }
    ]);
  });
});
