import { describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "../../garden/compute-provider.js";

describe("official API system prompt", () => {
  it("requires quote-first evidence before distillation", () => {
    const quoteFirst = "For each signal, work quote-first, then distill.";
    const distill = "Then write distilled_fact using only what that quote entails.";

    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(quoteFirst);
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "copy the shortest contiguous exact substring that contains the complete atomic assertion " +
      "and every explicit local antecedent needed to resolve its references"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "preserve capitalization, punctuation, spacing, and wording."
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Do not use surrounding text to add facts or guess unresolved references."
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Do not return an empty signals array merely because a durable assertion uses narrative, list, template, or conversational wording."
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Before returning an empty signals array for a non-empty source_assertions catalog, inspect every catalog entry once more"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Do not lower the durability threshold: transient tasks, procedures, and formatting instructions are not durable assertions unless they explicitly state a lasting preference or policy."
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT.indexOf(quoteFirst))
      .toBeLessThan(OFFICIAL_API_SYSTEM_PROMPT.indexOf(distill));
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Return {\"signals\":[]} when the turn does not contain durable memory candidates."
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not invent facts");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"source_locator"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      'Use "source_locator":{"contract_version":2,"kind":"assertion_catalog","assertion_id":N} for every signal.'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('Prefer "source_locator"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Only User source spans");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Assistant spans are context only");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "source_assertions contain only assertions the runtime can ground"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"assertion_catalog"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Return only assertion_id");
  });
});
