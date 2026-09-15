import { describe, expect, it } from "vitest";
import { buildOfficialApiExtractionRequests, buildOfficialApiSourceCorpus } from "@do-soul/alaya-soul";
import { bindSourceInterpretationAnchors } from "../../../runs/extraction/cache/semantic-supplement/source-interpretation-anchor-binding.js";

const text = "I use TypeScript. I avoid any.";
const request = buildOfficialApiExtractionRequests(text, [])[0]!;
const sourceCorpus = buildOfficialApiSourceCorpus(text, []);
const entry = { assertion_id: 2, relations: [{
  predicate: { text: "avoid" }, arguments: [{ role: "object", phrase: { text: "any" } }], qualifiers: []
}] };
const input = { request, sourceCorpus, assertionIds: [2],
  sourceRawJson: JSON.stringify({ interpretations: [entry] }), primaryRawJson: '{"interpretations":[]}' };

describe("current interpretation supplement source admission", () => {
  it("retains original interpretation ordinals and full entries under current anchors", () => {
    const first = { assertion_id: 1, relations: [{ predicate: { text: "use" }, arguments: [], qualifiers: [] }] };
    const result = bindSourceInterpretationAnchors({ ...input,
      sourceRawJson: JSON.stringify({ interpretations: [first, entry] }) });
    expect(result.selected).toEqual([entry]);
    expect(result.bindings).toEqual([{ interpretation_index: 1,
      interpretation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      source_assertion_id: 2, source_assertion_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }]);
  });
  it.each([
    ["historical raw", { sourceRawJson: '{"signals":[]}' }],
    ["unknown primary", { primaryRawJson: '' }],
    ["malformed primary", { primaryRawJson: '{"interpretations":[{}]}' }],
    ["changed corpus", { sourceCorpus: `${sourceCorpus} I moved.` }],
    ["changed request", { request: { ...request, source_assertions: request.source_assertions.map((row) => ({ ...row, text: 'invented' })) } }],
    ["foreign assertion", { sourceRawJson: JSON.stringify({ interpretations: [{ ...entry, assertion_id: 99 }] }) }],
    ["absent phrase", { sourceRawJson: JSON.stringify({ interpretations: [{ assertion_id: 2, relations: [{ predicate: { text: 'invented' }, arguments: [], qualifiers: [] }] }] }) }],
    ["empty source", { sourceRawJson: '{"interpretations":[]}' }],
    ["covered primary", { primaryRawJson: input.sourceRawJson }]
  ])("rejects %s without supplying a fabricated interpretation", (_label, change) => {
    expect(() => bindSourceInterpretationAnchors({ ...input, ...change })).toThrow();
  });
});
