import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT,
  OFFICIAL_API_SIGNAL_CONTRACT_VERSION,
  OFFICIAL_API_SYSTEM_PROMPT,
  resolveOfficialApiSystemPrompt
} from "../../garden/compute-provider.js";

describe("official API system prompt", () => {
  it("requires quote-first evidence before distillation", () => {
    const quoteFirst = "For each signal, work quote-first, then distill.";
    const distill = "Then represent only what that quote entails in semantic_factor_graph.";

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
      "Return {\"signals\":[]} when the catalog does not contain durable memory candidates."
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not invent facts");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"source_locator"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      'Use "source_locator":{"contract_version":2,"kind":"assertion_catalog","assertion_id":N} for every signal.'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('Prefer "source_locator"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "source_assertions catalog contains only User assertions the runtime can ground"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"assertion_catalog"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Return only assertion_id");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "one bounded source assertion batch"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "an unreferenced factor has no graph meaning and is discarded"
    );
  });

  it("keeps open semantic factors while freezing bounded durable projections", () => {
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"semantic_factor_graph"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"binding_identity":OPEN_NAME');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not emit character spans");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("not a fixed role list");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "preserve the predicate's semantic argument order"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("or a cross-graph identity");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "same name for repeated parallel values"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "every explicit, source-grounded participant of a relation"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "preserving the relation's stated arity and semantic order"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "never collapse a multi-participant relation into a unary proposition"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"fact_frame"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      `response signal contract version is ${OFFICIAL_API_SIGNAL_CONTRACT_VERSION}`
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      '"object_kind" must be exactly one of: preference, decision, constraint'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      'Do not include "signal_kind"; the runtime derives it deterministically'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"canonical_entities"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"temporal_projection"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"valid_from"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Never copy event time into valid time");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"preference_profile"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"preference_subject"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"preference_polarity"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"evidence_polarity"');
  });

  it("defines confidence as a bounded JSON number rather than a label", () => {
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      '"confidence" must be a JSON number from 0 through 1'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      'never a string label such as "high", "medium", or "low"'
    );
  });

  it("requires direct compact output without analysis", () => {
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Do not output analysis or reasoning. Emit the JSON object immediately"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Do not repeat source text outside matched_text or semantic_factor_graph surfaces."
    );
  });

  it("resolves current and sealed historical prompt identities without a fallback", () => {
    const currentSha256 = sha256(OFFICIAL_API_SYSTEM_PROMPT);
    const historicalSha256 =
      "5ec2740bd63923305b376b240d5a219383f3cbfe8a7d9198d504f7f8de542326";
    const historical = resolveOfficialApiSystemPrompt(historicalSha256);

    expect(resolveOfficialApiSystemPrompt(currentSha256)).toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(historical).toBeDefined();
    expect(sha256(historical!)).toBe(historicalSha256);
    expect(historical).not.toContain('"fact_frame"');
    expect(resolveOfficialApiSystemPrompt("0".repeat(64))).toBeUndefined();
  });

  it("defines a separately identified single-assertion coverage repair prompt", () => {
    const repairSha256 = sha256(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT);

    expect(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT)
      .toContain(OFFICIAL_API_SYSTEM_PROMPT);
    expect(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT).toContain(
      "exactly one source_assertions entry"
    );
    expect(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT).toContain(
      "does not lower the durability threshold"
    );
    expect(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT).toContain(
      "bare topic, search phrase, title, or information request"
    );
    expect(repairSha256).not.toBe(sha256(OFFICIAL_API_SYSTEM_PROMPT));
    expect(resolveOfficialApiSystemPrompt(repairSha256))
      .toBe(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
