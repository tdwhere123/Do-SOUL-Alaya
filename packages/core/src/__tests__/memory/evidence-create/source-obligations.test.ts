import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID, evidenceFactFrameFormationCapturePreimage, formatVerifiedUserAssertionSourceHash,
  type AssociativeFactFrame } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { materializeEvidenceFactFrameFormation, replayEvidenceFactFrameFormationCapture } from
  "../../../memory/evidence-fact-frame-formation.js";
import { certifyEvidenceSemanticCompleteness } from "../../../memory/evidence-create/evidence-semantic-completeness.js";
import { materializeOpenSemanticFactorFormation } from "../../../semantic/open-semantic-factor-formation.js";
import { RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER as normalizer } from
  "../../../memory/fact-frame-formation/declarative-normalizer.js";
import { createRecallRealStorage } from "../../shared/real-sqlite.test-support.js";
import { createEvidenceInput } from "../evidence-service-fixture.js";

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
  { source: "I am not a doctor.", subject: "I", relation: "am", qualifier: "not", value: "a doctor", copula: true },
  { source: 'Alice likes the song "Never Again".', subject: "Alice", relation: "likes", value: 'the song "Never Again"' },
  { source: 'Alice likes the song "Quiet Days".', subject: "Alice", relation: "likes", value: 'the song "Quiet Days"' },
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
    const semanticFormation = materializeOpenSemanticFactorFormation({ source_kind: "evidence", source_text: source,
      proposal: { schema_version: 1, producer_operator_id: "garden_source_bound_open_semantic_factor_v3",
        source_text: source, graph: { schema_version: 2, source_kind: "evidence", variables: [], result_variable_ids: [],
          factors: [{ factor_id: "like", surface: "like", semantic_identity: "like" },
            { factor_id: "tea", surface: "tea", semantic_identity: "tea" }],
          propositions: [{ proposition_id: "p", predicate_factor_id: "like", arguments: [
            { position: 0, binding_identity: "object", reference_kind: "factor", reference_id: "tea" }
          ] }] } } });
    expect(certifyEvidenceSemanticCompleteness({ sourceText: source, factFrame: capture, semanticFormation }).receipt)
      .toMatchObject({ status: "rejected", reason_code: "invalid_fact_frame_obligation" });
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

it.each(["With the badge", "Without the badge"])("persists and reads the %s obligation through EvidenceService and SQLite", async (prefix) => {
  const { database, evidenceCapsuleRepo } = await createRecallRealStorage(() => undefined);
  try {
    const source = `${prefix} I can enter the lab.`;
    const graph = { schema_version: 1 as const, producer_operator_id: "garden_source_bound_open_semantic_factor_v3",
      source_text: source, graph: { schema_version: 2 as const, source_kind: "evidence" as const,
        factors: [{ factor_id: "enter", surface: "enter", semantic_identity: "enter", source_occurrence: 0 },
          { factor_id: "lab", surface: "the lab", semantic_identity: "the lab", source_occurrence: 0 }], variables: [], result_variable_ids: [],
        propositions: [{ proposition_id: "p", predicate_factor_id: "enter", arguments: [
          { position: 0, binding_identity: "object", reference_kind: "factor" as const, reference_id: "lab" }
        ] }] } };
    const service = new EvidenceService({ evidenceCapsuleRepo, eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: vi.fn() }, factFrameProposalNormalizer: normalizer });
    const created = await service.create(createEvidenceInput({ excerpt: source, source_hash: sourceHash }), [], undefined, graph);
    const row = database.connection.prepare("SELECT status, fact_frame_json FROM evidence_fact_frame_formations WHERE evidence_object_id = ?")
      .get(created.object_id) as { status: string; fact_frame_json: string };
    expect(row.status).toBe("formed");
    expect(JSON.parse(row.fact_frame_json).slots).toEqual([{ role: "qualifier", text: prefix }, ...enterFrame.slots]);
    const certificate = database.connection.prepare("SELECT semantic_completeness_json FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?")
      .get(created.object_id) as { semantic_completeness_json: string };
    expect(JSON.parse(certificate.semantic_completeness_json)).toMatchObject({ status: "certified",
      arguments: expect.arrayContaining([expect.objectContaining({ role: "qualifier", surface: prefix })]) });
    const rejected = await service.create(createEvidenceInput({ excerpt: source, source_hash: sourceHash }), [], {
      schema_version: 1, producer_operator_id: "explicit_source_frame", source_assertion: source, fact_frame: enterFrame
    }, graph);
    expect(database.connection.prepare("SELECT status FROM evidence_fact_frame_formations WHERE evidence_object_id = ?")
      .get(rejected.object_id)).toEqual({ status: "rejected" });
    expect(await evidenceCapsuleRepo.findById(rejected.object_id)).toMatchObject({ excerpt: source });
  } finally { database.close(); }
});
