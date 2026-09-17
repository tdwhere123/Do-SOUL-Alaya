import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SOURCE_INTERPRETATION_CONTRACT } from "@do-soul/alaya-protocol";
import { buildOfficialApiExtractionRequests, parseOfficialApiExtractionRequest } from
  "../../../garden/ingestion/official-api/extraction-request.js";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";
import {
  OfficialApiInterpretationAdmissionError,
  classifyOfficialApiInterpretationResult
} from "../../../garden/ingestion/official-api/source-interpretation-receive.js";
import { officialApiExtractionResponseSchema } from "../../../garden/ingestion/official-api/response-schema.js";
import {
  OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT,
  OFFICIAL_API_SYSTEM_PROMPT,
  resolveOfficialApiSystemPrompt
} from "../../../garden/ingestion/compute-provider.js";

describe("official API system prompt", () => {
  const examples = [...OFFICIAL_API_SYSTEM_PROMPT.matchAll(/<example>(.*?)<\/example>/gu)]
    .map((match) => JSON.parse(match[1]!) as { input: unknown; output: unknown });

  it("embeds complete fictional examples accepted by the live interpretation contract", () => {
    expect(examples).toHaveLength(4);
    const sources = ["In 2020, I opened a workshop and promised to lend tools.",
      "I can borrow tools in the workshop only on Saturdays.",
      "The exhibit opened in 2019 with the aim of helping visitors learn ceramics.",
      "Nia told Nia to wait."];
    examples.forEach((example, index) => {
      const source = sources[index]!;
      const request = parseOfficialApiExtractionRequest(example.input);
      expect(request).toEqual(buildOfficialApiExtractionRequests(source, [])[0]);
      const schema = officialApiExtractionResponseSchema(JSON.stringify(request));
      expect(z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
        .safeParse(example.output).success).toBe(true);
      const corpus = buildOfficialApiSourceCorpus(source, []);
      const classified = classifyOfficialApiInterpretationResult(
        JSON.stringify(example.output), request, corpus
      );
      expect(classified.status).toBe("completed_signals");
      expect(classified.located[0]?.outcome).toBe("candidates");
      expect(classified.located[0]?.candidates.length).toBeGreaterThan(0);
      const phrases = classified.located[0]!.candidates.flatMap((candidate) => [
        candidate.predicate.text,
        ...candidate.arguments.map((item) => item.phrase.text),
        ...candidate.qualifiers.map((item) => item.phrase.text)
      ]);
      expect(phrases.every((phrase) => corpus.includes(phrase))).toBe(true);
      if (index === 0) {
        expect(phrases).toEqual(expect.arrayContaining(["I", "opened", "a workshop", "2020", "promised to lend tools"]));
        expect(phrases).not.toContain("tools");
      } else if (index === 1) {
        expect(phrases).toEqual(expect.arrayContaining(["I", "borrow", "tools", "in the workshop", "only on Saturdays"]));
      } else if (index === 3) {
        expect(phrases).toEqual(["told", "Nia", "Nia", "to wait"]);
        expect(classified.located[0]!.candidates[0]!.arguments.map((item) => item.phrase.source_span))
          .toEqual([[6, 9], [15, 18], [19, 26]]);
      }
    });
  });

  it("retains an accompanying aim without inventing an intention actor or accomplished learning", () => {
    const source = "The exhibit opened in 2019 with the aim of helping visitors learn ceramics.";
    const example = examples[2]!;
    const request = parseOfficialApiExtractionRequest(example.input);
    const classified = classifyOfficialApiInterpretationResult(
      JSON.stringify(example.output), request, buildOfficialApiSourceCorpus(source, [])
    );
    const candidate = classified.located[0]!.candidates[0]!;
    expect(candidate.predicate.text).toBe("opened");
    expect(candidate.arguments.map((item) => item.phrase.text)).toEqual(["The exhibit"]);
    expect(candidate.qualifiers.map((item) => item.phrase.text)).toEqual([
      "2019",
      "with the aim of helping visitors learn ceramics"
    ]);
    expect(candidate.arguments.map((item) => item.role)).not.toContain("promiser");
  });

  it("admits a repeated phrase with occurrence 0 then 1 and refuses omitting occurrence 0", () => {
    const source = "Nia told Nia to wait.";
    const example = examples[3]!;
    const request = parseOfficialApiExtractionRequest(example.input);
    const corpus = buildOfficialApiSourceCorpus(source, []);
    const classified = classifyOfficialApiInterpretationResult(
      JSON.stringify(example.output), request, corpus
    );
    expect(classified.status).toBe("completed_signals");
    const candidate = classified.located[0]!.candidates[0]!;
    expect(candidate.predicate.text).toBe("told");
    expect(candidate.predicate.source_span).toEqual([10, 14]);
    expect(candidate.arguments.map((item) => [item.role, item.phrase.text, item.phrase.source_span])).toEqual([
      ["agent", "Nia", [6, 9]],
      ["recipient", "Nia", [15, 18]],
      ["theme", "to wait", [19, 26]]
    ]);

    const omitted = {
      interpretations: [{
        assertion_id: 1,
        relations: [{
          predicate: { text: "told" },
          arguments: [
            { role: "agent", phrase: { text: "Nia" } },
            { role: "recipient", phrase: { text: "Nia", occurrence: 1 } },
            { role: "theme", phrase: { text: "to wait" } }
          ],
          qualifiers: []
        }]
      }]
    };
    try {
      classifyOfficialApiInterpretationResult(JSON.stringify(omitted), request, corpus);
      throw new Error("expected classification refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(OfficialApiInterpretationAdmissionError);
      const refusal = error as OfficialApiInterpretationAdmissionError;
      expect(refusal.receive.status).toBe("partial");
      expect(refusal.receive.rejections[0]).toMatchObject({
        assertion_id: 1, candidate_index: 0, diagnostic_reason: "ambiguous"
      });
      expect(refusal.receive.located[0]?.outcome).toBe("failed");
      expect(refusal.receive.located[0]?.candidates).toEqual([]);
    }
  });

  it("adds only the repeated-phrase occurrence example to the archived primary and repair prompts", () => {
    const primary = resolveOfficialApiSystemPrompt(
      "729288791ea8b5ad3c021b908855f245dc52f85fe22a7e5c118e02cd81744b6a");
    const repair = resolveOfficialApiSystemPrompt(
      "fabdd4339f8071bd36c96ab464311220e7284fb9f0e824ba13995fb7c44d0b61");
    const added = ` <example>${JSON.stringify(examples[3])}</example>`;
    expect(primary).toBeDefined();
    expect(repair).toBeDefined();
    expect(OFFICIAL_API_SYSTEM_PROMPT.split(added)).toHaveLength(2);
    expect(OFFICIAL_API_SYSTEM_PROMPT.replace(added, "")).toBe(primary);
    expect(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT.replace(added, "")).toBe(repair);
    expect(sha256(primary!)).toBe("729288791ea8b5ad3c021b908855f245dc52f85fe22a7e5c118e02cd81744b6a");
    expect(sha256(repair!)).toBe("fabdd4339f8071bd36c96ab464311220e7284fb9f0e824ba13995fb7c44d0b61");
    expect(primary).not.toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(repair).not.toBe(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT);
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

  it("asks for source-supported relations without kind or confidence", () => {
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(SOURCE_INTERPRETATION_CONTRACT);
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain('{"interpretations":[...]}');
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not emit confidence, object_kind");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("do not invent an agent, speaker, promiser, or intention actor");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Do not assign a product, object, or theme as promiser or speaker.");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Keep not, only, if, unless, and promise markers");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Preserve relative-date meaning");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain("Return only assertion_id");
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "source_assertions catalog contains only User assertions the runtime can ground"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "one bounded source assertion batch"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      'Return {"interpretations":[]} when the catalog does not contain durable memory candidates.'
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"identity_observation"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"source_locator"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain('"matched_text"');
    expect(OFFICIAL_API_SYSTEM_PROMPT).not.toContain(
      "an unreferenced factor or variable makes the entire graph invalid"
    );
  });

  it("requires direct compact output without analysis", () => {
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Do not output analysis or reasoning. Emit the JSON object immediately"
    );
    expect(OFFICIAL_API_SYSTEM_PROMPT).toContain(
      "Do not repeat source text outside predicate, argument, and qualifier phrases."
    );
  });

  it("resolves current and sealed historical prompt identities without a fallback", () => {
    const currentSha256 = sha256(OFFICIAL_API_SYSTEM_PROMPT);
    const previousOccurrenceSha256 =
      "729288791ea8b5ad3c021b908855f245dc52f85fe22a7e5c118e02cd81744b6a";
    const previousLiveSha256 =
      "8789e33fec393cd3729a2f66ebfa224418060de4075dab4e493e68be36a06533";
    const historicalSha256 =
      "5ec2740bd63923305b376b240d5a219383f3cbfe8a7d9198d504f7f8de542326";
    const g8Sha256 =
      "c3d8327375c4942e4fbe66c4c3173780dc329cd3afc513e7e7c18af7651646f8";
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
    const previousLive = resolveOfficialApiSystemPrompt(previousLiveSha256);
    const previousOccurrence = resolveOfficialApiSystemPrompt(previousOccurrenceSha256);

    expect(currentSha256).not.toBe(previousOccurrenceSha256);
    expect(previousOccurrence).toBeDefined();
    expect(previousOccurrence).not.toBe(OFFICIAL_API_SYSTEM_PROMPT);
    expect(currentSha256).not.toBe(previousLiveSha256);
    expect(previousLive).toBeDefined();
    expect(previousLive).toContain('"identity_observation"');
    expect(previousLive).not.toBe(OFFICIAL_API_SYSTEM_PROMPT);
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
    expect(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT).toContain(
      "return an empty interpretations array"
    );
    expect(repairSha256).not.toBe(sha256(OFFICIAL_API_SYSTEM_PROMPT));
    expect(resolveOfficialApiSystemPrompt(repairSha256))
      .toBe(OFFICIAL_API_SOURCE_ASSERTION_REPAIR_SYSTEM_PROMPT);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
