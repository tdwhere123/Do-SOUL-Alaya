import { expect, it } from "vitest";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import {
  EVIDENCE_SELECTION_SOURCE_REFERENCE_LITERAL_POLICY as LITERAL,
  EVIDENCE_SELECTION_SOURCE_REFERENCE_WITNESS_POLICY as WITNESS,
  EVIDENCE_SELECTION_SOURCE_REFERENCE_PAIR_POLICY as PAIR,
  interpretEvidenceSelectionDecoded, materializeEvidenceSelectionLines, parseEvidenceSelectionWorkset,
  type EvidenceSelectionLine
} from "../../../runs/evidence-selection/input.js";

const PREVIEW = " \t😀 Café **blue**.\r\n\r\nUser: Keep *quiet* rooms?  \n  Assistant: This one.\t ";
const SHARED = "Same original words.";
const PROFILE = "step-3.5-2603-low-json-schema-v1";
const firstIdentity = { root_id: "root-unicode", version: "partial-v3", digest: `sha256:${"a".repeat(64)}`,
  span: { start: 900, end: 993 } };
const item = {
  original_question: "Which room preferences and necessary context are reported?",
  metadata: { query_as_of: null, custom: ["unknown", { note: "😀" }] },
  sources: [
    { ...firstIdentity, preview: PREVIEW,
      metadata: { speaker: null, completeness: "partial", original_bytes: 5000, observation_time: null } },
    { root_id: "root-repeated-a", version: "v1", digest: `sha256:${"b".repeat(64)}`,
      span: { start: 24, end: 44 }, preview: SHARED, metadata: null },
    { root_id: "root-repeated-b", version: "v2", digest: `sha256:${"c".repeat(64)}`,
      span: { start: 100, end: 120 }, preview: SHARED },
    { root_id: "root-whitespace", version: "v1", digest: `sha256:${"d".repeat(64)}`,
      span: { start: 0, end: 5 }, preview: " \r\n\t " }
  ]
};

function workset(policy: string | undefined = PAIR) {
  return parseEvidenceSelectionWorkset({ contract: "source-evidence-selection-workset-v1",
    model: STEP_PLAN_QUOTE_BASIS.selected_model, provider_url: STEP_PLAN_QUOTE_BASIS.selected_provider_url, request_profile: PROFILE,
    ...(policy === undefined ? {} : { request_policy: policy }), items: [item] });
}

function lines(policy: string | undefined = PAIR) {
  return materializeEvidenceSelectionLines(workset(policy), 1024);
}

function decoded(line: EvidenceSelectionLine, selected: unknown[], unresolved: string[] = ["Query time is unknown."]) {
  return interpretEvidenceSelectionDecoded(line,
    { rawJson: JSON.stringify({ status: "proposal", selected, unresolved }), finishReason: "stop" }, PROFILE);
}

it("renders each original preview once with all interstitial bytes, metadata and unknown speaker state", () => {
  const [witness, literal] = lines();
  expect(witness!.userPrompt).toBe(literal!.userPrompt);
  const represented = JSON.parse(witness!.userPrompt);
  expect(represented).toMatchObject({ contract: "source-reference-input-v1",
    original_question: item.original_question, metadata: item.metadata });
  expect(represented.sources[0]).toStrictEqual({ sourceRef: "s1", ...firstIdentity,
    metadata: item.sources[0]!.metadata, preview_segments: [
      { text: " \t" }, { witnessRef: "w1", text: "😀 Café **blue**." }, { text: "\r\n\r\n" },
      { witnessRef: "w2", text: "User: Keep *quiet* rooms?" }, { text: "  \n  " },
      { witnessRef: "w3", text: "Assistant: This one." }, { text: "\t " }
    ] });
  expect(represented.sources[1].preview_segments).toEqual([{ witnessRef: "w4", text: SHARED }]);
  expect(represented.sources[2].preview_segments).toEqual([{ witnessRef: "w5", text: SHARED }]);
  expect(represented.sources[3].preview_segments).toEqual([{ text: " \r\n\t " }]);
  const restored = represented.sources.map(({ sourceRef: _ref, preview_segments, ...source }: {
    sourceRef: string; preview_segments: { text: string }[]
  }) => ({ ...source, preview: preview_segments.map((part) => part.text).join("") }));
  expect(restored).toStrictEqual(item.sources);
  expect(witness!.userPrompt).not.toContain('"source_role"');
  expect(witness!.userPrompt).not.toContain('"complete-source"');
  expect(witness!.sources).toStrictEqual(item.sources);
  expect(witness!.sources).toBe(literal!.sources);
});

it("keeps UTF-16 locator offsets separate from original byte spans and freezes independent global ownership", () => {
  const [line] = lines();
  const references = line!.referenceOutput!.references;
  expect(references.witnesses[0]).toEqual({ witnessRef: "w1", sourceRef: "s1",
    startUtf16: 2, endUtf16: 19, quote: "😀 Café **blue**." });
  expect(Buffer.byteLength(PREVIEW.slice(0, 19), "utf8")).toBe(22);
  expect(references.sources[0]).toEqual({ sourceRef: "s1", ...firstIdentity });
  expect(references.witnesses.slice(3)).toEqual([
    { witnessRef: "w4", sourceRef: "s2", startUtf16: 0, endUtf16: 20, quote: SHARED },
    { witnessRef: "w5", sourceRef: "s3", startUtf16: 0, endUtf16: 20, quote: SHARED }
  ]);
  expect(Object.isFrozen(references)).toBe(true);
  expect(Object.isFrozen(references.witnesses[0])).toBe(true);
  expect(Object.isFrozen(references.sources[0]!.span)).toBe(true);
});

it("binds both formats to exact original identities and omits generated explanations from consumption", () => {
  const [witness, literal] = lines();
  const expected = { classified: "interpreted", admitted: true, outcome: {
    status: "interpreted", unresolved: ["Query time is unknown."], selected: [
      { root_id: "root-unicode", quotes: ["User: Keep *quiet* rooms?"], identity: firstIdentity }
    ]
  } };
  expect(decoded(witness!, [{ sourceRef: "s1", witnessRefs: ["w2"], contribution: "Unauthenticated preference report." }]))
    .toEqual(expected);
  expect(decoded(literal!, [{ sourceRef: "s1", quotes: ["User: Keep *quiet* rooms?"], contribution: "Anything generated." }]))
    .toEqual(expected);
  expect(decoded(literal!, [{ sourceRef: "s1", quotes: ["\r\n\r\nUser: Keep *quiet* rooms?  \n  "], contribution: "Context." }]))
    .toMatchObject({ admitted: true, outcome: { selected: [{ quotes: ["\r\n\r\nUser: Keep *quiet* rooms?  \n  "] }] } });
  expect(decoded(witness!, [
    { sourceRef: "s2", witnessRefs: ["w4"], contribution: "First occurrence." },
    { sourceRef: "s3", witnessRefs: ["w5"], contribution: "Distinct source occurrence." }
  ])).toMatchObject({ admitted: true, outcome: { selected: [
    { root_id: "root-repeated-a", quotes: [SHARED], identity: { version: "v1", span: { start: 24, end: 44 } } },
    { root_id: "root-repeated-b", quotes: [SHARED], identity: { version: "v2", span: { start: 100, end: 120 } } }
  ] } });
});

it.each([
  { label: "unknown source", selected: [{ sourceRef: "s99", witnessRefs: ["w1"] }], reason: "unknown_source_ref" },
  { label: "unknown witness", selected: [{ sourceRef: "s1", witnessRefs: ["w99"] }], reason: "unknown_witness_ref" },
  { label: "cross-owner witness", selected: [{ sourceRef: "s2", witnessRefs: ["w1"] }], reason: "witness_owner_mismatch" },
  { label: "cross-owner identical text", selected: [{ sourceRef: "s3", witnessRefs: ["w4"] }], reason: "witness_owner_mismatch" },
  { label: "repeated witness", selected: [{ sourceRef: "s1", witnessRefs: ["w1", "w1"] }], reason: "duplicate_witness_ref" },
  { label: "repeated source", selected: [
    { sourceRef: "s1", witnessRefs: ["w1"] }, { sourceRef: "s1", witnessRefs: ["w2"] }
  ], reason: "duplicate_root" }
])("rejects $label without salvaging any selection", ({ selected, reason }) => {
  expect(decoded(lines()[0]!, selected.map((entry) => ({ ...entry, contribution: "Proposed." })))).toEqual({
    admitted: false, classified: "terminal", outcome: { status: "invalid", reason }
  });
});

it.each([
  { selected: [{ sourceRef: "s0", quotes: [SHARED] }], reason: "unknown_source_ref" },
  { selected: [{ sourceRef: "s2", quotes: ["User: Keep *quiet* rooms?"] }], reason: "quote_mismatch" },
  { selected: [{ sourceRef: "s1", quotes: ["User: Keep quiet rooms?"] }], reason: "quote_mismatch" },
  { selected: [{ sourceRef: "s2", quotes: [SHARED] }, { sourceRef: "s2", quotes: [SHARED] }], reason: "duplicate_root" }
])("keeps literal source binding strict: $reason", ({ selected, reason }) => {
  expect(decoded(lines(LITERAL)[0]!, selected.map((entry) => ({ ...entry, contribution: "Proposed." })))).toEqual({
    admitted: false, classified: "terminal", outcome: { status: "invalid", reason }
  });
});

it.each([WITNESS, LITERAL])("preserves explicit empty, abstain and incomplete meanings for %s", (policy) => {
  const line = lines(policy)[0]!;
  expect(decoded(line, [], [])).toMatchObject({ admitted: false,
    outcome: { status: "invalid", reason: "proposal_missing_unresolved" } });
  expect(decoded(line, [], [" \t "])).toMatchObject({ admitted: false, outcome: { status: "invalid", reason: "invalid_shape" } });
  expect(decoded(line, [], ["No useful evidence identified within this supplied preview pool."]))
    .toMatchObject({ admitted: true, outcome: { status: "interpreted", selected: [] } });
  for (const [unresolved, expected] of [
    [[], { status: "invalid", reason: "abstain_missing_unresolved" }],
    [["The input is unusable."], { status: "abstained", unresolved: ["The input is unusable."] }]
  ] as const) {
    expect(interpretEvidenceSelectionDecoded(line, { rawJson: JSON.stringify({ status: "cannot_propose", selected: [], unresolved }),
      finishReason: "stop" }, PROFILE)).toMatchObject({ admitted: false, outcome: expected });
  }
  expect(interpretEvidenceSelectionDecoded(line, { rawJson: "{", finishReason: "length" }, PROFILE))
    .toEqual({ classified: "incomplete", admitted: false, outcome: { status: "incomplete", reason: "noncomplete" } });
  expect(interpretEvidenceSelectionDecoded(line, { rawJson: "{", finishReason: "stop" }, PROFILE))
    .toMatchObject({ admitted: false, outcome: { status: "invalid", reason: "malformed_json" } });
});

it.each([undefined, "partial-evidence-v1", "source-input-representation-pair-v1",
  "source-proposal-assembly-pair-v1", "source-proposal-assembly-v1"])("retains historical empty admission for %s", (policy) => {
  // Passing undefined directly avoids the new-policy helper's default parameter.
  const prepared = { ...workset(), request_policy: policy };
  for (const line of materializeEvidenceSelectionLines(prepared, 1024)) {
    expect(line.referenceOutput).toBeUndefined();
    expect(decoded(line, [], [])).toEqual({ admitted: true, classified: "interpreted",
      outcome: { status: "interpreted", selected: [], unresolved: [] } });
  }
});

it("pairs each unchanged item witness then literal, with shared meaning and distinct schema/request/cache identities", () => {
  const prepared = workset();
  const second = { ...item, original_question: "What qualification remains unknown?" };
  const paired = materializeEvidenceSelectionLines({ ...prepared, items: [item, second] }, 1024);
  expect(paired.map((line) => [line.original_question, line.referenceOutput!.format])).toEqual([
    [item.original_question, "witness"], [item.original_question, "literal"],
    [second.original_question, "witness"], [second.original_question, "literal"]
  ]);
  expect(paired[0]).toEqual(lines(WITNESS)[0]);
  expect(paired[1]).toEqual(lines(LITERAL)[0]);
  for (const [index, sourceItem] of [item, second].entries()) {
    for (const [offset, policy] of [WITNESS, LITERAL].entries()) {
      expect(paired[index * 2 + offset]).toEqual(materializeEvidenceSelectionLines({
        ...prepared, request_policy: policy, items: [sourceItem]
      }, 1024)[0]);
    }
  }
  const reordered = materializeEvidenceSelectionLines({ ...prepared, items: [second, item] }, 1024);
  expect(reordered).toEqual([paired[2], paired[3], paired[0], paired[1]]);
  const [witness, literal] = paired;
  const sharedMeaning = (line: EvidenceSelectionLine) => line.systemPrompt.split("\n\n").slice(0, -1).join("\n\n");
  expect(sharedMeaning(witness!)).toBe(sharedMeaning(literal!));
  expect(sharedMeaning(witness!)).toContain("preferences, operands, and referent or temporal qualifications");
  expect(sharedMeaning(witness!)).toContain("qualifications supplied only by omitted material");
  expect(witness!.sourcesDigest).toBe(literal!.sourcesDigest);
  expect(witness!.userPrompt).toBe(literal!.userPrompt);
  expect(witness!.responseJsonSchema).toMatchObject({ properties: { selected: { items: {
    required: ["sourceRef", "witnessRefs", "contribution"] } } } });
  expect(literal!.responseJsonSchema).toMatchObject({ properties: { selected: { items: {
    required: ["sourceRef", "quotes", "contribution"] } } } });
  expect(new Set(paired.map((line) => line.key)).size).toBe(4);
  expect(new Set(paired.map((line) => line.requestDigest)).size).toBe(4);
  const mutated = materializeEvidenceSelectionLines({ ...prepared, items: [{ ...item,
    sources: item.sources.map((source, index) => index === 0 ? { ...source, version: "changed" } : source) }] }, 1024);
  expect(mutated[0]!.key).not.toBe(witness!.key);
  expect(mutated[0]!.sourcesDigest).not.toBe(witness!.sourcesDigest);
  expect(decoded(witness!, [{ sourceRef: "s1", quotes: ["User: Keep *quiet* rooms?"], contribution: "Wrong format." }]))
    .toMatchObject({ admitted: false, outcome: { reason: "invalid_shape" } });
});
