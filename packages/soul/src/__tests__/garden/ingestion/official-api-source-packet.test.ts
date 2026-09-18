import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sourceReferenceResolver, SourceInterpretationPacketSchema, type SourceInterpretationProfile } from "@do-soul/alaya-protocol";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/official-api-garden-provider.js";
import { buildOfficialApiSourceCorpus, indexOfficialApiSourceAssertions } from "../../../garden/triage/grounding/source-locator.js";
import { buildOfficialApiSourcePacketRequest, parseOfficialApiSourcePacketRequest,
  OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT } from "../../../garden/ingestion/official-api/source-packet-request.js";
import { receiveOfficialApiSourcePacket, completeEmptyOfficialApiSourcePacket, MAX_OFFICIAL_API_SOURCE_PACKET_RESPONSE_BYTES } from "../../../garden/ingestion/official-api/source-packet-receive.js";
import { officialApiExtractionResponseSchema, officialApiExtractionResponseSchemaPreimage,
  OFFICIAL_API_EXTRACTION_RESPONSE_SCHEMA_PREIMAGE } from "../../../garden/ingestion/official-api/response-schema.js";

const PROFILE: SourceInterpretationProfile = { contract: "source-interpretation-profile-v1", description: "Observed acts of seeing",
  predicates: [{ symbol: "see", governing_roles: [], meaning: "A perceiver sees a theme." }],
  roles: [{ symbol: "perceiver", meaning: "Participant perceiving." }, { symbol: "theme", meaning: "What is perceived." }] };

function fixture() {
  const text = "Alice sees Alice.";
  const sourceCorpus = buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
  const assertion = indexOfficialApiSourceAssertions(sourceCorpus).find((row) => row.text.includes(text))!;
  const request = buildOfficialApiSourcePacketRequest(sourceCorpus, [assertion.assertion_id], PROFILE);
  const references = sourceReferenceResolver(request.source_catalog, (text) => createHash("sha256").update(text).digest("hex"));
  const ref = (start: number, length: number) => references.referenceForSpan(assertion.assertion_id, [start, start + length]);
  const packet = SourceInterpretationPacketSchema.parse({ contract: "source-interpretation-v2", profile_id: request.profile_id, source_catalog_id: request.source_catalog.catalog_id,
    mentions: [{ id: "m0", assertion_id: assertion.assertion_id, source_ref: ref(assertion.text.indexOf("Alice"), 5) },
      { id: "m1", assertion_id: assertion.assertion_id, source_ref: ref(assertion.text.lastIndexOf("Alice"), 5) },
      { id: "m2", assertion_id: assertion.assertion_id, source_ref: ref(assertion.text.indexOf("sees"), 4) }],
    referents: [{ id: "r0", mentions: ["m0"] }, { id: "r1", mentions: ["m1"] }],
    propositions: [{ id: "p0", predicate: "see", implicit: false, predicate_mentions: ["m2"], assertion_ids: [assertion.assertion_id],
      arguments: [{ role: "perceiver", target: "r0" }, { role: "theme", target: "r1" }] }], operators: [], roots: ["p0"] });
  const rawJson = JSON.stringify({ contract: "source-interpretation-response-v2", packet });
  const input = { sourceCorpus, artifactKey: "packet-source", producerId: "authored-provider" };
  return { request, packet, rawJson, input };
}

describe("request-bound interpretation packet producer", () => {
  it("uses the explicit packet capability and preserves distinct referents despite equal mention text", async () => {
    const f = fixture();
    const provider = new OfficialApiGardenProvider({ injectedExtractorCapability: "cache_only", diagnosticDir: null,
      extractor: { extract: async (input) => {
        expect(input.systemPrompt).toBe(OFFICIAL_API_SOURCE_PACKET_SYSTEM_PROMPT);
        expect(JSON.parse(input.userPrompt)).toEqual(f.request);
        input.validateRawJson?.(f.rawJson);
        return { rawJson: f.rawJson };
      } } });
    const received = await provider.extractSourcePacket(f.request, f.input);
    expect(received.status).toBe("received");
    if (received.status !== "received") throw new Error("expected packet");
    expect(received.draft.packet.referents).toEqual([{ id: "r0", mentions: ["m0"] }, { id: "r1", mentions: ["m1"] }]);
    expect(received.draft.profile).toEqual(PROFILE);
    expect(received.draft.provenance.request_key).toMatch(/^sha256:/u);
    expect(received.draft.packet.mentions[0]!.source_ref).not.toEqual(received.draft.packet.mentions[1]!.source_ref);
    expect(JSON.stringify(JSON.parse(f.rawJson).packet.mentions)).not.toMatch(/occurrence|selection|"text"/u);
  });

  it("uses profile symbols in generation and rejects unknown symbols or changed profile content", () => {
    const f = fixture();
    const schema = JSON.stringify(officialApiExtractionResponseSchema(JSON.stringify(f.request)));
    expect(schema).toContain('"enum":["see"]');
    expect(schema).toContain('"enum":["perceiver","theme"]');
    expect(() => parseOfficialApiSourcePacketRequest({ ...f.request, profile: { ...PROFILE, description: "changed meaning" } })).toThrow(/profile/u);
    const invalid = { ...f.packet, propositions: f.packet.propositions.map((row) => ({ ...row, predicate: "watch" })) };
    expect(() => receiveOfficialApiSourcePacket(JSON.stringify({ contract: "source-interpretation-response-v2", packet: invalid }), f.request, f.input))
      .toThrow(/unknown interpretation predicate/u);
  });

  it("keeps historical request-v2 schema and raw-v1 interpretation isolated from packet-v2", () => {
    const f = fixture();
    expect(officialApiExtractionResponseSchemaPreimage(JSON.stringify(f.request.source_request))).toBe(OFFICIAL_API_EXTRACTION_RESPONSE_SCHEMA_PREIMAGE);
    expect(officialApiExtractionResponseSchemaPreimage(JSON.stringify(f.request))).not.toBe(OFFICIAL_API_EXTRACTION_RESPONSE_SCHEMA_PREIMAGE);
    expect(() => receiveOfficialApiSourcePacket('{"interpretations":[]}', f.request, f.input)).toThrow();
    expect(() => receiveOfficialApiSourcePacket(f.rawJson, f.request, { ...f.input, sourceCorpus: "changed" })).toThrow(/generation/u);
    expect(() => parseOfficialApiSourcePacketRequest({ ...f.request, source_catalog: { ...f.request.source_catalog,
      catalog_id: `sha256:${"f".repeat(64)}` } })).toThrow(/catalog/u);
    expect(() => receiveOfficialApiSourcePacket(JSON.stringify({ contract: "source-interpretation-response-v2",
      packet: { ...f.packet, source_catalog_id: `sha256:${"f".repeat(64)}` } }), f.request, f.input)).toThrow(/catalog/u);
  });

  it("rejects the whole packet for missing reference endpoints and permits an implicit semantic predicate without a fabricated quote", () => {
    const f = fixture();
    const missing = { ...f.packet, mentions: f.packet.mentions.map((row) => row.id === "m0"
      ? { ...row, source_ref: { first: "a1s999", last: "a1s999" } } : row) };
    expect(() => receiveOfficialApiSourcePacket(JSON.stringify({ contract: "source-interpretation-response-v2", packet: missing }), f.request, f.input)).toThrow(/missing/u);
    const implicit = { ...f.packet, propositions: f.packet.propositions.map((row) => ({ ...row, implicit: true, predicate_mentions: [] })) };
    expect(receiveOfficialApiSourcePacket(JSON.stringify({ contract: "source-interpretation-response-v2", packet: implicit }), f.request, f.input).status).toBe("received");
  });
});

it("completes a genuinely empty source without credentials or invoking the extractor", async () => {
  const request = buildOfficialApiSourcePacketRequest("", [], PROFILE);
  const input = { sourceCorpus: "", artifactKey: "empty-source", producerId: "empty-control" };
  let calls = 0;
  const provider = new OfficialApiGardenProvider({ diagnosticDir: null,
    extractor: { extract: async () => { calls++; throw new Error("must not dispatch"); } } });
  expect((await provider.extractSourcePacket(request, input)).status).toBe("empty");
  expect(calls).toBe(0);
  expect(completeEmptyOfficialApiSourcePacket(request, input).received.status).toBe("empty");
  expect(() => completeEmptyOfficialApiSourcePacket(request, { ...input, sourceCorpus: "Alice sees Alice." })).toThrow();
  const f = fixture();
  expect(() => completeEmptyOfficialApiSourcePacket(f.request, f.input)).toThrow(/complete empty/u);
});

it("rejects oversized UTF-8 packet output before JSON parsing rather than completing empty", () => {
  const f = fixture();
  expect(() => receiveOfficialApiSourcePacket("中".repeat(Math.ceil(MAX_OFFICIAL_API_SOURCE_PACKET_RESPONSE_BYTES / 3)),
    f.request, f.input)).toThrow(/byte bound/u);
});
