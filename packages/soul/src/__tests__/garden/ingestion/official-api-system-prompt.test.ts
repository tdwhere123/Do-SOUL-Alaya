import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IDENTITY_OBSERVATION_PRODUCER } from "@do-soul/alaya-protocol";
import { buildOfficialApiExtractionRequests, parseOfficialApiExtractionRequest } from
  "../../../garden/ingestion/official-api/extraction-request.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";
import { classifyOfficialApiRequestResult } from "../../../garden/ingestion/official-api/request-result.js";
import { groundOfficialApiDraft } from "../../../garden/ingestion/official-api/source-grounding.js";
import { auditOfficialApiSignalFormation } from "../../../garden/ingestion/official-api/formation-audit.js";
import { officialApiExtractionResponseSchema } from "../../../garden/ingestion/official-api/response-schema.js";
import {
  OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT,
  OFFICIAL_API_SIGNAL_CONTRACT_VERSION,
  OFFICIAL_API_SYSTEM_PROMPT,
  resolveOfficialApiSystemPrompt
} from "../../../garden/ingestion/compute-provider.js";

describe("official API system prompt", () => {
  const examples = [...OFFICIAL_API_SYSTEM_PROMPT.matchAll(/<example>(.*?)<\/example>/gu)]
    .map((match) => JSON.parse(match[1]!) as { input: unknown; output: unknown });

  it("embeds complete fictional examples accepted by the shared request parser and source grounding", () => {
    expect(examples).toHaveLength(3);
    const sources = ["In 2020, I opened a workshop and promised to lend tools.",
      "I can borrow tools in the workshop only on Saturdays.",
      "The exhibit opened in 2019 with the aim of helping visitors learn ceramics."];
    examples.forEach((example, index) => {
      const source = sources[index]!;
      const request = parseOfficialApiExtractionRequest(example.input);
      expect(request).toEqual(buildOfficialApiExtractionRequests(source, [])[0]);
      const schema = officialApiExtractionResponseSchema(JSON.stringify(request));
      expect(z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
        .safeParse(example.output).success).toBe(true);
      const corpus = buildOfficialApiSourceCorpus(source, []);
      const classified = classifyOfficialApiRequestResult(JSON.stringify(example.output), request, corpus);
      expect(classified.status).toBe("completed_signals");
      expect(classified.drafts).toHaveLength(1);
      const grounded = groundOfficialApiDraft(classified.drafts[0]!, corpus);
      expect(grounded.status).toBe("grounded");
      expect(grounded.draft.semantic_factor_graph).toBeUndefined();
      expect(grounded.draft.matched_text).toBe(source);
      expect(grounded.draft.identity_observation?.producer).toBe(IDENTITY_OBSERVATION_PRODUCER);
      const mentionSurfaces = grounded.draft.identity_observation?.mentions.map((mention) => mention.surface) ?? [];
      if (index === 0) {
        expect(grounded.draft.object_kind).toBe("episode");
        expect(mentionSurfaces).toEqual(["I", "opened", "a workshop", "2020", "promised", "to lend tools"]);
        expect(mentionSurfaces).not.toContain("tools");
        expect(grounded.draft.temporal_projection).toMatchObject({ time_source: "explicit", time_precision: "year",
          event_time_start: "2020-01-01T00:00:00.000Z", event_time_end: "2020-12-31T23:59:59.999Z" });
      } else if (index === 1) {
        expect(mentionSurfaces).toEqual(["I", "can", "borrow", "tools", "in the workshop"]);
        expect(grounded.draft.identity_observation?.unresolved_spans?.map((span) => span.surface))
          .toEqual(["only on Saturdays"]);
        expect(grounded.draft.temporal_projection).toBeUndefined();
      }
    });
  });

  it("retains an accompanying aim without inventing an intention actor or accomplished learning", () => {
    const source = "The exhibit opened in 2019 with the aim of helping visitors learn ceramics.";
    const example = examples[2]!;
    const request = parseOfficialApiExtractionRequest(example.input);
    const classified = classifyOfficialApiRequestResult(JSON.stringify(example.output), request,
      buildOfficialApiSourceCorpus(source, []));
    const draft = classified.drafts[0]!;
    expect(draft.object_kind).toBe("episode");
    expect(draft.matched_text).toBe(source);
    expect(draft.source_locator).toEqual({ contract_version: 4, kind: "assertion_catalog", assertion_id: 1 });
    expect(draft.semantic_factor_graph).toBeUndefined();
    expect(draft.identity_observation?.mentions.map((mention) => mention.surface)).toEqual([
      "The exhibit", "opened", "2019", "with the aim of helping visitors learn ceramics"
    ]);
    expect(draft.identity_observation?.mentions.map((mention) => mention.surface))
      .not.toEqual(expect.arrayContaining(["visitors", "learn"]));
    const year = { projection_schema_version: 1, time_precision: "year", time_source: "explicit",
      event_time_start: "2019-01-01T00:00:00.000Z", event_time_end: "2019-12-31T23:59:59.999Z" };
    expect(draft.temporal_projection).toEqual(year);
    const formed = auditOfficialApiSignalFormation({ raw_json: JSON.stringify(example.output),
      turn_content: source, turn_messages: [{ message_id: "exhibit-source", role: "user", content: source }],
      workspace_id: "example-workspace", run_id: "example-run", surface_id: null,
      created_at: "2024-06-01T10:00:00.000Z", source_observed_at: "2024-05-01T10:00:00.000Z",
      signal_id_for: () => "exhibit-opening" });
    expect(formed.mode).toBe("strict");
    expect(formed.entries).toHaveLength(1);
    expect(formed.entries[0]).toMatchObject({ disposition: "admitted", reason: "formed",
      temporal_projection_audit: { status: "formed", reason: "event_time_source_verified" } });
    expect(formed.entries[0]!.signal?.raw_payload.temporal_projection).toEqual(year);
    expect(formed.entries[0]!.signal?.raw_payload.identity_observation).toEqual(draft.identity_observation);
  });

  it("archives the previous identities-and-topology prompt under its content hash", () => {
    const primary = resolveOfficialApiSystemPrompt(
      "6b262e173dfc580d8751046e2d48cd773c91a26f203394dcff05906d6abed5dc");
    const repair = resolveOfficialApiSystemPrompt(
      "23e54c4f6ce1a86d93d3aa07d683cd0e838f0b57d5c3b07f39f2b48a7ca75aa5");
    expect(primary).toBeDefined();
    expect(repair).toBeDefined();
    expect(primary).not.toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(repair).not.toBe(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT);
    expect(primary).toContain('"semantic_factor_graph"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain(
      "an unreferenced factor or variable makes the entire graph invalid"
    );
    expect(sha256(primary!)).toBe("6b262e173dfc580d8751046e2d48cd773c91a26f203394dcff05906d6abed5dc");
    expect(sha256(repair!)).toBe("23e54c4f6ce1a86d93d3aa07d683cd0e838f0b57d5c3b07f39f2b48a7ca75aa5");
  });

  it("requires quote-first evidence before distillation", () => {
    const quoteFirst = "For each signal, work quote-first, then distill.";
    const distill = "Then record independently grounded mentions from that quote in identity_observation.";

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
      'Use "source_locator":{"contract_version":4,"kind":"assertion_catalog","assertion_id":N} for every signal.'
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
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain(
      "an unreferenced factor or variable makes the entire graph invalid"
    );
  });

  it("asks for identities-only mentions while freezing bounded durable projections", () => {
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"identity_observation"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('"producer":"official-api-identity-observation-v1"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not emit factor_id, proposition_id, binding_identity, hashes, or a canonical graph");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("do not invent an agent, speaker, promiser, or intention actor");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not assign a product, object, or theme as promiser or speaker.");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("keep not, only, if, unless, and promise markers");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not invent time or negation.");
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"binding_identity":OPEN_NAME');
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain(
      '"schema_version":2,"source_kind":"evidence"'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain("Example structure only");
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
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"kind_projection"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Do not force facts into subject/relation/value/qualifier/time slots."
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
      "Do not repeat source text outside matched_text or identity_observation surfaces."
    );
  });

  it("resolves current and sealed historical prompt identities without a fallback", () => {
    const currentSha256 = sha256(OFFICIAL_API_SYSTEM_PROMPT);
    const historicalSha256 =
      "5ec2740bd63923305b376b240d5a219383f3cbfe8a7d9198d504f7f8de542326";
    const g8Sha256 =
      "c3d8327375c4942e4fbe66c4c3173780dc329cd3afc513e7e7c18af7651646f8";
    const currentSha256Expected =
      "8789e33fec393cd3729a2f66ebfa224418060de4075dab4e493e68be36a06533";
    const previousCatalogPrompt = resolveOfficialApiSystemPrompt(
      "1775799d80bebde5797ded3a5fdddf209c96839489cde4a947518822110a76fd"
    );
    const previousSha256 =
      "bf255feebdf99106871e33241f7bba3260e3f02874f0eefe36db803cc95d7705";
    const previous = resolveOfficialApiSystemPrompt(previousSha256);
    const previousRepairSha256 =
      "b212a6fdc0abb6a440035cefe7c3da856ae04908290faa8524194549e1091aaa";
    const previousRepair = resolveOfficialApiSystemPrompt(previousRepairSha256);
    const historical = resolveOfficialApiSystemPrompt(historicalSha256);
    const g8 = resolveOfficialApiSystemPrompt(g8Sha256);

    expect(currentSha256).toBe(currentSha256Expected);
    const priorTemporalPrompt = resolveOfficialApiSystemPrompt("cdb968269d0585f9144509c9ae6a237ec7caeedb3d176fcea0abbcc29be56da8");
    expect(priorTemporalPrompt).toContain('"event_time_end":"2021-01-01T00:00:00.000Z"');
    expect(priorTemporalPrompt).not.toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(previousCatalogPrompt).toBeDefined();
    expect(sha256(previousCatalogPrompt!)).toBe("1775799d80bebde5797ded3a5fdddf209c96839489cde4a947518822110a76fd");
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
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain("kind_projection");
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
