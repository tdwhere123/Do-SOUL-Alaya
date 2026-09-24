import { describe, expect, it } from "vitest";
import { buildOfficialApiSourceCorpus, indexOfficialApiSourceAssertions } from "../../../garden/triage/grounding/source-locator.js";
import { collectSourceSemanticUnitPacks, indexSourceSemanticUnits, sourceSemanticTransportUnits } from "../../../garden/ingestion/official-api/source-semantic-units.js";
import { buildSourceSemanticRequest } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { completeEmptySourceSemantics, receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const producer = { source_id: "source", source_version: "1", producer_id: "test", producer_version: "1" };

describe("source semantic unit coverage", () => {
  it("returns zero-attempt no-eligible-source for an empty current request", () => {
    const input = { ...producer, sourceCorpus: "", assertionIds: [] };
    const current = buildSourceSemanticRequest(input);
    expect(completeEmptySourceSemantics(current, input).outcome).toEqual({ status: "no_eligible_source", provider_attempts: 0 });
  });
  it("retains conditional, interrogative, anaphoric and Chinese source spans before interpretation", () => {
    const content = "If Talia calls, Niko will leave. Did Niko leave? Talia placed an atlas on the desk. She then opened it. 快来加入我们的活动！";
    const corpus = buildOfficialApiSourceCorpus(content, []);
    const units = indexSourceSemanticUnits(corpus);
    expect(units.map((row) => row.text)).toEqual([
      "User: If Talia calls, Niko will leave.", "Did Niko leave?", "Talia placed an atlas on the desk.", "She then opened it.", "快来加入我们的活动！"
    ]);
    expect(units.map((row) => row.text).join("").replace(/\s/gu, "")).toBe(corpus.replace(/\s/gu, ""));
    expect(indexOfficialApiSourceAssertions(buildOfficialApiSourceCorpus("Did Niko leave?", []))).toEqual([]);
  });

  it("preserves native message roles across sentences and exact UTF-8 locations", () => {
    const sourceCorpus = buildOfficialApiSourceCorpus("", [
      { role: "user", content: "图谱在哪里？ 我想找它。" },
      { role: "assistant", content: "图谱在这里。 You can open it." }
    ]);
    const input = { ...producer, sourceCorpus, assertionIds: [1, 2, 3, 4] };
    const request = buildSourceSemanticRequest(input);
    expect(request.source_request.source_assertions.map((row) => row.source_role)).toEqual(["user", "user", "assistant", "assistant"]);
    for (const [index, row] of request.source_request.assertion_locations!.entries()) {
      expect(Buffer.from(sourceCorpus).subarray(...row.source_utf8_span).toString("utf8"))
        .toBe(request.source_request.source_assertions[index]!.text);
    }
    const altered = structuredClone(request);
    (altered.source_request.source_assertions[2] as { source_role: string }).source_role = "user";
    expect(() => receiveSourceSemantics("{}", altered, input)).toThrow(/source owner/u);
  });

  it("packs every unit within eight and keeps occurrence identity distinct from semantic identity", () => {
    const corpus = buildOfficialApiSourceCorpus(Array.from({ length: 9 }, (_, i) => `Where is item ${i}?`).join(" "), []);
    const packs = collectSourceSemanticUnitPacks(corpus);
    expect(packs.map((pack) => pack.source_assertions.length)).toEqual([8, 1]);
    expect(packs.flatMap((pack) => pack.source_assertions.map((row) => row.assertion_id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(collectSourceSemanticUnitPacks(corpus, "singleton")).toHaveLength(9);
    const first = sourceSemanticTransportUnits(corpus, ["one"], "dataset-a");
    const second = sourceSemanticTransportUnits(corpus, ["two"], "dataset-a");
    expect(first[0]).not.toHaveProperty("semanticKey");
    expect(first[0]!.binding.occurrenceIdentity).not.toBe(second[0]!.binding.occurrenceIdentity);
    expect(first[0]!.binding.occurrenceIdentity).not.toBe(sourceSemanticTransportUnits(corpus, ["one"], "dataset-b")[0]!.binding.occurrenceIdentity);
    expect(() => buildSourceSemanticRequest({ ...producer, sourceCorpus: corpus, assertionIds: [1, 1] })).toThrow(/duplicate/u);
    expect(() => buildSourceSemanticRequest({ ...producer, sourceCorpus: corpus, assertionIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).toThrow();
  });

});
