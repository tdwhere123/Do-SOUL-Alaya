import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { groundOpenSemanticFactorGraph } from "@do-soul/alaya-protocol";
import { buildOfficialApiExtractionRequests, parseOfficialApiExtractionRequest } from
  "../../../garden/ingestion/official-api/extraction-request.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";
import { classifyOfficialApiRequestResult } from "../../../garden/ingestion/official-api/request-result.js";
import { groundOfficialApiDraft } from "../../../garden/ingestion/official-api/source-grounding.js";
import {
  OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT,
  OFFICIAL_API_SIGNAL_CONTRACT_VERSION,
  OFFICIAL_API_SYSTEM_PROMPT,
  resolveOfficialApiSystemPrompt
} from "../../../garden/ingestion/compute-provider.js";

describe("official API system prompt", () => {
  it("embeds complete fictional examples accepted by the shared request parser and source grounding", () => {
    const examples = [...OFFICIAL_API_SYSTEM_PROMPT.matchAll(/<example>(.*?)<\/example>/gu)]
      .map((match) => JSON.parse(match[1]!) as { input: unknown; output: unknown });
    expect(examples).toHaveLength(2);
    const sources = ["In 2020, I opened a workshop and promised to lend tools.",
      "I can borrow tools in the workshop only on Saturdays."];
    examples.forEach((example, index) => {
      const source = sources[index]!;
      const request = parseOfficialApiExtractionRequest(example.input);
      expect(request).toEqual(buildOfficialApiExtractionRequests(source, [])[0]);
      const corpus = buildOfficialApiSourceCorpus(source, []);
      const classified = classifyOfficialApiRequestResult(JSON.stringify(example.output), request, corpus);
      expect(classified.status).toBe("completed_signals");
      expect(classified.drafts).toHaveLength(1);
      const grounded = groundOfficialApiDraft(classified.drafts[0]!, corpus);
      expect(grounded.status).toBe("grounded");
      expect(grounded.draft.semantic_factor_graph_projection).toBeUndefined();
      expect(grounded.draft.matched_text).toBe(source);
      const graph = groundOpenSemanticFactorGraph(grounded.draft.semantic_factor_graph, source);
      expect(graph).not.toBeNull();
      expect(graph!.propositions).toHaveLength(index === 0 ? 2 : 1);
      if (index === 0) {
        expect(grounded.draft.object_kind).toBe("episode");
        expect(graph!.factors.map((factor) => factor.surface).sort()).toEqual([
          "I", "opened", "a workshop", "2020", "promised", "to lend tools"
        ].sort());
        expect(grounded.draft.temporal_projection).toMatchObject({ time_source: "explicit", time_precision: "year",
          event_time_start: "2020-01-01T00:00:00.000Z", event_time_end: "2021-01-01T00:00:00.000Z" });
        expect(graph!.propositions.map((proposition) => proposition.arguments.at(-1)?.reference_id)).toEqual(["year", "year"]);
      } else {
        expect(graph!.factors.map((factor) => factor.surface).sort()).toEqual([
          "I", "can", "borrow", "tools", "in the workshop", "only on Saturdays"
        ].sort());
        expect(graph!.propositions[0]!.arguments.map((argument) => argument.binding_identity))
          .toEqual(["borrower", "modality", "resource", "location", "condition"]);
        expect(grounded.draft.temporal_projection).toBeUndefined();
      }
    });
  });

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
      "an unreferenced factor or variable makes the entire graph invalid"
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
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Each factor or variable surface must own a non-overlapping exact source span"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      '"schema_version":2,"source_kind":"evidence"'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain("Example structure only");
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain(
      '"arguments":[{"position":0,"binding_identity":"argument","reference_kind":"factor","reference_id":"f1"}]'
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
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      'When the argument is a duration measure, binding_identity must be "duration"'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "When it is a location or place participant, binding_identity must be \"location\""
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Other open role names remain allowed");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"kind_projection"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Never put kind into semantic_factor_graph");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "do not invent entity, event, attribute, or answer-family categories"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Names other than the structural tokens duration and location stay open text"
    );
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
    const g8Sha256 =
      "c3d8327375c4942e4fbe66c4c3173780dc329cd3afc513e7e7c18af7651646f8";
    const currentSha256Expected =
      "1775799d80bebde5797ded3a5fdddf209c96839489cde4a947518822110a76fd";
    const previousSha256 =
      "bf255feebdf99106871e33241f7bba3260e3f02874f0eefe36db803cc95d7705";
    const previous = resolveOfficialApiSystemPrompt(previousSha256);
    const previousRepairSha256 =
      "b212a6fdc0abb6a440035cefe7c3da856ae04908290faa8524194549e1091aaa";
    const previousRepair = resolveOfficialApiSystemPrompt(previousRepairSha256);
    const historical = resolveOfficialApiSystemPrompt(historicalSha256);
    const g8 = resolveOfficialApiSystemPrompt(g8Sha256);

    expect(currentSha256).toBe(currentSha256Expected);
    expect(resolveOfficialApiSystemPrompt(currentSha256)).toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(previous).toBeDefined();
    expect(sha256(previous!)).toBe(previousSha256);
    expect(previous).not.toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(previousRepair).toBeDefined();
    expect(sha256(previousRepair!)).toBe(previousRepairSha256);
    expect(previousRepair).not.toBe(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT);
    expect(historical).toBeDefined();
    expect(sha256(historical!)).toBe(historicalSha256);
    expect(historical).not.toContain('"fact_frame"');
    expect(g8).toBeDefined();
    expect(sha256(g8!)).toBe(g8Sha256);
    expect(g8).not.toContain("kind_projection");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("kind_projection");
    expect(resolveOfficialApiSystemPrompt("0".repeat(64))).toBeUndefined();
  });

  it("keys historical prompts by the hash of their read-only files", () => {
    const directory = fileURLToPath(new URL(
      "../../../garden/ingestion/official-api/historical-prompts/",
      import.meta.url
    ));
    const files = readdirSync(directory).filter((name) => name.endsWith(".txt"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = readFileSync(path.join(directory, name), "utf8");
      const digest = sha256(text);
      expect(digest).toBe(name.replace(/\.txt$/u, ""));
      expect(resolveOfficialApiSystemPrompt(digest)).toBe(text);
    }
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
