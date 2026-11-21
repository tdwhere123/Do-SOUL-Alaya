import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID, evidenceFactFrameFormationCapturePreimage, formatVerifiedUserAssertionSourceHash,
  type AssociativeFactFrame } from "@do-soul/alaya-protocol";
import { materializeEvidenceFactFrameFormation, replayEvidenceFactFrameFormationCapture } from
  "../../../memory/evidence-fact-frame-formation.js";
import { RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER as normalizer } from "@do-soul/alaya-protocol/node/source-frame";

const sourceHash = formatVerifiedUserAssertionSourceHash("b".repeat(64));
const enterFrame: AssociativeFactFrame = { schema_version: 1, slots: [
  { role: "subject", text: "I" }, { role: "qualifier", text: "can" },
  { role: "relation", text: "enter" }, { role: "value", text: "the lab" }
] };

function materialize(source: string, fact_frame: AssociativeFactFrame) {
  return materializeEvidenceFactFrameFormation({ sourceAssertion: source, sourceHash,
    proposal: { schema_version: 1, producer_operator_id: "explicit_source_frame",
      source_assertion: source, fact_frame } });
}

function historicalCapture(frame: AssociativeFactFrame, producer = "rule_based_evidence_fact_frame_normalizer_v2") {
  const preimage = { schema_version: 1 as const, operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status: "formed" as const, source_hash: sourceHash, fact_frame: frame,
    producer_operator_id: producer };
  return { ...preimage, capture_digest: `sha256:${createHash("sha256")
    .update(evidenceFactFrameFormationCapturePreimage(preimage)).digest("hex")}` };
}

it.each([
  { source: "I can enter the lab or use the equipment.", subject: "I", qualifier: "can" },
  { source: "Alice enters the lab or uses the equipment.", subject: "Alice enters the lab or" },
  { source: "Alice enters the lab or uses the equipment.", subject: "Alice" },
  { source: "I enter the lab or use the equipment.", subject: "I enter the lab or" }
])("refuses a submitted subject or relation that skips the source predicate: $source / $subject", (entry) => {
  const relation = entry.source.includes("uses") ? "uses" : "use";
  const frame: AssociativeFactFrame = { schema_version: 1, slots: [
    { role: "subject", text: entry.subject },
    ...(entry.qualifier === undefined ? [] : [{ role: "qualifier" as const, text: entry.qualifier }]),
    { role: "relation", text: relation }, { role: "value", text: "the equipment" }
  ] };
  expect(materialize(entry.source, frame)).toMatchObject({ capture: { status: "rejected" }, searchProjections: [] });
  const capture = historicalCapture(frame);
  expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: entry.source, sourceHash, capture })).toThrow();
});

it.each([
  { source: "Alice Smith likes tea.", subject: "Alice Smith", relation: "likes", value: "tea" },
  { source: "张三喜欢咖啡。", subject: "张三", relation: "喜欢", value: "咖啡" }
])("leaves explicit subjects outside the independently anchored grammar unsupported: $subject", (entry) => {
  expect(materialize(entry.source, { schema_version: 1, slots: [
    { role: "subject", text: entry.subject }, { role: "relation", text: entry.relation }, { role: "value", text: entry.value }
  ] }).capture.status).toBe("rejected");
});

it.each([
  { source: "I am not a doctor.", subject: "I", relation: "am", qualifier: "not", value: "a doctor", copula: true },
  { source: 'Alice likes the song "Never Again".', subject: "Alice", relation: "likes", value: 'the song "Never Again"' },
  { source: 'Alice likes the song "Quiet Days".', subject: "Alice", relation: "likes", value: 'the song "Quiet Days"' },
  { source: "I bought my bookshelf from IKEA.", subject: "I", relation: "bought my bookshelf from", value: "IKEA" },
  { source: 'Alice never likes the song "Quiet Days".', subject: "Alice", relation: "likes", qualifier: "never", value: 'the song "Quiet Days"' }
])("validates explicit obligations independently of automatic frame generation: $source", (entry) => {
  const qualifier = entry.qualifier === undefined ? [] : [{ role: "qualifier" as const, text: entry.qualifier }];
  const frame: AssociativeFactFrame = { schema_version: 1, slots: [
    { role: "subject", text: entry.subject }, ...(entry.copula ? [] : qualifier),
    { role: "relation", text: entry.relation }, ...(entry.copula ? qualifier : []),
    { role: "value", text: entry.value }
  ] };
  expect(materialize(entry.source, frame).capture.status).toBe("formed");
  expect(replayEvidenceFactFrameFormationCapture({ sourceAssertion: entry.source, sourceHash,
    capture: historicalCapture(frame, "explicit_source_frame") }).capture.fact_frame).toEqual(frame);
  if (qualifier.length > 0) {
    const omitted = { ...frame, slots: frame.slots.filter((slot) => slot.role !== "qualifier") };
    expect(materialize(entry.source, omitted).capture.status).toBe("rejected");
    expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: entry.source, sourceHash,
      capture: historicalCapture(omitted) })).toThrow();
  }
});

it.each(["With the badge", "Without the badge", "Before the surgery", "After the surgery", "By the way, today"])(
  "retains the complete leading source obligation: %s", (prefix) => {
    const source = `${prefix} I can enter the lab.`;
    const frame = normalizer.propose(source)!.fact_frame;
    expect(frame.slots).toEqual([{ role: "qualifier", text: prefix }, ...enterFrame.slots]);
    expect(materialize(source, frame).capture.status).toBe("formed");
    expect(materialize(source, enterFrame).capture.status).toBe("rejected");
    expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash,
      capture: historicalCapture(enterFrame) })).toThrow();
  });

it.each([
  "only if I have a badge", "if I have a badge", "unless I lose my badge",
  "unless authorized", "provided that I have a badge", "as long as I have a badge",
  "and use the equipment only if I have a badge", ", but only if I have a badge",
  "and the user leaves only if I have a badge", "only on Sundays"
])("refuses trailing dependent scope through automatic, explicit and historical frames: %s", (tail) => {
  const source = `I can enter the lab ${tail}.`;
  expect(normalizer.propose(source)).toBeUndefined();
  const opaque: AssociativeFactFrame = { ...enterFrame, slots: [...enterFrame.slots.slice(0, -1),
    { role: "value", text: `the lab ${tail}` }] };
  const qualified: AssociativeFactFrame = { ...enterFrame, slots: [...enterFrame.slots,
    { role: "qualifier", text: tail }] };
  for (const frame of [enterFrame, opaque, qualified]) {
    expect(materialize(source, frame)).toMatchObject({ capture: { status: "rejected" }, searchProjections: [] });
    const capture = historicalCapture(frame, "rule_based_evidence_fact_frame_normalizer_v3");
    expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash, capture })).toThrow();
  }
});

it.each(['"Only If"', "'Only If'", "“Only If”", "‘Only If’"])(
  "preserves a quoted value containing scope vocabulary: %s", (title) => {
    const source = `I read ${title} and coffee recipes.`;
    const proposal = normalizer.propose(source)!;
    expect(proposal).toBeDefined();
    expect(materialize(source, proposal.fact_frame).capture.status).toBe("formed");
  });

it.each(["without a badge", "with a badge", "except on Sundays", "after the surgery", "or use the equipment"])(
  "rejects incomplete source coverage without enumerating the omitted adjunct: %s", (tail) => {
    const source = `I can enter the lab ${tail}.`;
    expect(materialize(source, enterFrame)).toMatchObject({ capture: { status: "rejected" }, searchProjections: [] });
    expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash,
      capture: historicalCapture(enterFrame) })).toThrow();
    const complete = normalizer.propose(source)!;
    expect(complete.fact_frame.slots.at(-1)?.text).toBe(`the lab ${tail}`);
    expect(materialize(source, complete.fact_frame).capture.status).toBe("formed");
  });

it.each(["do not", "don't", "don’t", "never", "currently", "usually"])(
  "rejects an explicit or historical frame omitting the recognized predicate qualifier %s", (qualifier) => {
    const source = `I ${qualifier} like tea.`;
    const frame: AssociativeFactFrame = { schema_version: 1, slots: [
      { role: "subject", text: "I" }, { role: "relation", text: "like" }, { role: "value", text: "tea" }
    ] };
    expect(normalizer.propose(source)?.fact_frame.slots.filter((slot) => slot.role === "qualifier"))
      .toEqual([{ role: "qualifier", text: qualifier === "do not" ? "not" : qualifier }]);
    expect(materialize(source, frame).capture.status).toBe("rejected");
    const capture = historicalCapture(frame);
    expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash, capture })).toThrow();
  });

it.each([
  'Without the claim "I can enter the lab" being true.',
  "Without the claim ‘I can enter the lab’ being true.",
  "Without the claim 'I can enter the lab' being true.",
  "Without the badge I can enter the lab and I cannot leave.",
  "Without the badge I can enter the lab but I cannot leave.",
  "I can enter the lab and the user cannot leave.",
  "I can enter the lab but the user has left.",
  "I can enter the lab and the user is a manager.",
  "I read the Farmers' guide and I cannot enter the lab.",
  "I read the Farmers’ guide and I cannot enter the lab.",
  "I can enter the lab; I cannot leave."
])("refuses quoted-subject and finite-clause boundaries across all frame entry paths: %s", (source) => {
  expect(normalizer.propose(source)).toBeUndefined();
  expect(materialize(source, enterFrame).capture.status).toBe("rejected");
  expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash,
    capture: historicalCapture(enterFrame) })).toThrow();
});

it("keeps local quoted values and nominal coordination, and respects qualifier/slot bounds", () => {
  expect(materialize("I am an engineer.", { schema_version: 1, slots: [
    { role: "subject", text: "I" }, { role: "relation", text: "am" }, { role: "value", text: "an engineer" }
  ] }).capture.status).toBe("formed");
  expect(normalizer.propose('With the badge I can enter "the lab".')?.fact_frame.slots)
    .toEqual([{ role: "qualifier", text: "With the badge" }, ...enterFrame.slots]);
  expect(normalizer.propose("I like tea and coffee.")?.fact_frame.slots.at(-1)?.text).toBe("tea and coffee");
  expect(normalizer.propose("I manage the team and the user account.")?.fact_frame.slots.at(-1)?.text)
    .toBe("the team and the user account");
  expect(normalizer.propose('I remember "tea and I like coffee".')?.fact_frame.slots.at(-1)?.text)
    .toBe("tea and I like coffee");
  expect(normalizer.propose("Without the badge I can not enter the lab.")?.fact_frame.slots).toHaveLength(6);
  expect(normalizer.propose("Without the badge I can still never enter the lab.")).toBeUndefined();
});

it.each(["'", "’"])("retains plural possessive %s in a leading qualifier without opening a quotation", (apostrophe) => {
  const prefix = `With my parents${apostrophe} approval`;
  const source = `${prefix} I can enter the lab.`;
  const frame = { ...enterFrame, slots: [{ role: "qualifier" as const, text: prefix }, ...enterFrame.slots] };
  expect(normalizer.propose(source)?.fact_frame).toEqual(frame);
  expect(materialize(source, frame).capture.status).toBe("formed");
  expect(replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash,
    capture: historicalCapture(frame, "explicit_source_frame") }).capture.fact_frame).toEqual(frame);
});

it.each([
  ["I like '80s music and I cannot enter the lab.", "80s music"],
  ['I like "jazz and I cannot enter the lab.', "jazz"],
  ["I like ‘jazz and I cannot enter the lab.", "jazz"],
  ["I like “jazz and I cannot enter the lab.", "jazz"]
])("does not let an unclosed quotation hide a finite clause: %s", (source, value) => {
  const frame: AssociativeFactFrame = { schema_version: 1, slots: [
    { role: "subject", text: "I" }, { role: "relation", text: "like" }, { role: "value", text: value }
  ] };
  expect(normalizer.propose(source)).toBeUndefined();
  expect(materialize(source, frame).capture.status).toBe("rejected");
  expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash,
    capture: historicalCapture(frame) })).toThrow();
});

it.each([['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"]])(
  "preserves balanced %s quotations with plural possessive source text", (open, close) => {
    const source = `With my parents' approval I remember ${open}tea and I like coffee${close}.`;
    const frame: AssociativeFactFrame = { schema_version: 1, slots: [
      { role: "qualifier", text: "With my parents' approval" },
      { role: "subject", text: "I" }, { role: "relation", text: "remember" },
      { role: "value", text: "tea and I like coffee" }
    ] };
    expect(normalizer.propose(source)?.fact_frame).toEqual(frame);
    expect(materialize(source, frame).capture.status).toBe("formed");
    expect(replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash,
      capture: historicalCapture(frame, "explicit_source_frame") }).capture.fact_frame).toEqual(frame);
  });
