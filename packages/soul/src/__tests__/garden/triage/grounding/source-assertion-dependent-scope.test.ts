import { expect, it } from "vitest";
import { resolveAtomicSourceAssertion, resolveSourceAssertion } from "../../../../garden/triage/grounding/source-assertion.js";
import { atomicAssertionSpans } from "../../../../garden/triage/grounding/source-assertion/atomic-spans.js";
import { sentenceSpans } from "../../../../garden/triage/grounding/source-assertion/clause-spans.js";
import { buildOfficialApiSourceAssertions, buildOfficialApiSourceCorpus, parseOfficialApiSourceLocator,
  resolveOfficialApiSourceLocatorQuote } from "../../../../garden/triage/grounding/source-locator.js";
import { verifyOfficialApiSourceLocatorBinding } from "../../../../garden/triage/grounding/source-locator/verified-binding.js";
import { buildOfficialApiExtractionRequest, parseOfficialApiExtractionRequest } from
  "../../../../garden/ingestion/official-api/extraction-request.js";

it.each([
  ["I can enter the lab, but only if I have a badge.", "I can enter the lab"],
  ["I can enter the lab and use the equipment only if I have a badge.", "I can enter the lab"],
  ["I can enter the lab and Mary leaves only if I have a badge.", "I can enter the lab"],
  ["I enjoy coffee and tea only on Sundays.", "I enjoy coffee"],
  ["I enjoy coffee and tea unless I feel ill.", "I enjoy coffee"],
  ["I enjoy coffee and tea provided that I have eaten.", "I enjoy coffee"],
  ["I enjoy coffee and tea as long as I have eaten.", "I enjoy coffee"]
])("retains the dependent scope before catalog, direct quote and locator admission: %s", (source, fragment) => {
  expect(resolveSourceAssertion(source, fragment)).toEqual({ status: "grounded", assertion: source });
  const corpus = buildOfficialApiSourceCorpus(source, []);
  expect(buildOfficialApiSourceAssertions(corpus)).toEqual([{ assertion_id: 1, text: `User: ${source}` }]);
  const request = buildOfficialApiExtractionRequest(source, []);
  expect(request.source_assertions).toEqual([{ assertion_id: 1, text: `User: ${source}` }]);
  expect(resolveOfficialApiSourceLocatorQuote(corpus,
    { contract_version: 4, kind: "assertion_catalog", assertion_id: 1 }, fragment))
    .toEqual({ status: "grounded", assertion: source });
});

it.each([
  ["I like tea or coffee.", "I like tea"],
  ["I can access a PC from anywhere and with any device.", "I can access a PC from anywhere"],
  ["Now a global cloud computing company chaired by Octave Klaba, OVHcloud founder, SHADOW looks forward notably through new cloud solutions for both personal and business use.",
    "Now a global cloud computing company chaired by Octave Klaba, OVHcloud founder, SHADOW looks forward notably through new cloud solutions for both personal"],
  ["In 2022, SHADOW’s revamped subscription service featured a brand new Power Upgrade, including better performance and infinite possibilities.",
    "In 2022, SHADOW’s revamped subscription service featured a brand new Power Upgrade, including better performance"]
])("does not detach nominal alternatives or adjuncts from their source: %s", (source, fragment) => {
  expect(resolveSourceAssertion(source, fragment)).toEqual({ status: "grounded", assertion: source });
  const corpus = buildOfficialApiSourceCorpus(source, []);
  expect(buildOfficialApiSourceAssertions(corpus)).toEqual([{ assertion_id: 1, text: `User: ${source}` }]);
  expect(resolveOfficialApiSourceLocatorQuote(corpus,
    { contract_version: 4, kind: "assertion_catalog", assertion_id: 1 }, fragment))
    .toEqual({ status: "grounded", assertion: source });
});

it("does not evade unresolved possessive reference by deleting the coordinated adjunct", () => {
  const source = "With Shadow, everyone can access a full Windows PC, in the cloud, from anywhere and with the device of their choice.";
  const fragment = "With Shadow, everyone can access a full Windows PC, in the cloud, from anywhere";
  expect(resolveSourceAssertion(source, fragment).status).toBe("rejected");
  const corpus = buildOfficialApiSourceCorpus(source, []);
  expect(buildOfficialApiSourceAssertions(corpus)).toEqual([]);
  expect(resolveOfficialApiSourceLocatorQuote(corpus,
    { contract_version: 4, kind: "assertion_catalog", assertion_id: 1 }, fragment).status).toBe("rejected");
});

it.each([" ", "\n"])("keeps a dependent continuation attached across punctuation and whitespace %j", (separator) => {
  const source = `I can enter the lab.${separator}But only if I have a badge.`;
  expect(resolveSourceAssertion(source, "I can enter the lab.").status).toBe("rejected");
  const result = resolveSourceAssertion(source, "But only if I have a badge.");
  expect(result.status !== "grounded" || result.assertion === source).toBe(true);
  expect(buildOfficialApiSourceAssertions(`User: ${source}`)).toEqual([]);
  expect(sentenceSpans(source).flatMap((sentence) => atomicAssertionSpans(source, sentence))).toEqual([]);
});

it.each(["Assistant", "User"])("respects a new %s role boundary after an independent assertion", (role) => {
  const source = `User: I can enter the lab.\n${role}: But only if I have a badge.`;
  expect(resolveSourceAssertion(source, "I can enter the lab.")).toEqual({ status: "grounded", assertion: "I can enter the lab." });
  expect(buildOfficialApiSourceAssertions(source)).toContainEqual({ assertion_id: 1, text: "User: I can enter the lab." });
  expect(buildOfficialApiSourceAssertions(source)).toHaveLength(1);
  expect(resolveAtomicSourceAssertion("But only if I have a badge.").status).toBe("rejected");
});

it("does not recover a partial conditional quote through the conversational fallback", () => {
  const source = "User: I can enter the lab and use the equipment only if they permit it.";
  const fragment = "I can enter the lab";
  expect(resolveOfficialApiSourceLocatorQuote(source,
    { contract_version: 4, kind: "assertion_catalog", assertion_id: 1 }, fragment).status).toBe("rejected");
});

it("keeps dependent scope through atomic wrapper removal and relative-clause admission", () => {
  const source = "User: By the way, I only redeemed a coupon, which was a nice surprise.";
  const spans = sentenceSpans(source).flatMap((sentence) => atomicAssertionSpans(source, sentence));
  expect(spans.map(({ start, end }) => source.slice(start, end))).not.toContain("I only redeemed a coupon");
});

it("preserves independent simple clauses and quoted conditional vocabulary", () => {
  const source = "I like coffee and I live in Paris.";
  expect(resolveSourceAssertion(source, "I like coffee")).toEqual({ status: "grounded", assertion: "I like coffee" });
  expect(buildOfficialApiSourceAssertions(buildOfficialApiSourceCorpus(source, [])))
    .toEqual(expect.arrayContaining([{ assertion_id: 2, text: "User: I like coffee" },
      { assertion_id: 3, text: "I live in Paris." }]));
  const quoted = 'I read "Only If" and I enjoy tea.';
  expect(resolveSourceAssertion(quoted, 'I read "Only If"')).toEqual({ status: "grounded", assertion: 'I read "Only If"' });
  expect(resolveSourceAssertion("I enjoy coffee and tea.", "I enjoy coffee and tea."))
    .toEqual({ status: "grounded", assertion: "I enjoy coffee and tea." });
});

it("rejects historical locator and request identities instead of reinterpreting their catalog ids", () => {
  const locator = { contract_version: 2 as const, kind: "assertion_catalog" as const, assertion_id: 1 };
  const historicalV3 = { contract_version: 3 as const, kind: "assertion_catalog" as const, assertion_id: 1 };
  expect(parseOfficialApiSourceLocator(locator)).toBeNull();
  expect(parseOfficialApiSourceLocator(historicalV3)).toBeNull();
  expect(resolveOfficialApiSourceLocatorQuote("User: I enjoy tea.", locator as never, "I enjoy tea.").status)
    .toBe("rejected");
  expect(verifyOfficialApiSourceLocatorBinding({ sourceCorpus: "User: I enjoy tea.",
    sourceAssertion: "I enjoy tea.", sourceLocator: locator })).toBe(false);
  const request = buildOfficialApiExtractionRequest("I enjoy tea.", []);
  expect(request.source_locator_contract_version).toBe(4);
  expect(() => parseOfficialApiExtractionRequest({ ...request, source_locator_contract_version: 2 })).toThrow();
  expect(() => parseOfficialApiExtractionRequest({ ...request, source_locator_contract_version: 3 })).toThrow();
});
