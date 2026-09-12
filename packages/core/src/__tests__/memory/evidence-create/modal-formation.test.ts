import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { evidenceFactFrameFormationCapturePreimage, formatVerifiedUserAssertionSourceHash } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { materializeEvidenceFactFrameFormation, replayEvidenceFactFrameFormationCapture } from "../../../memory/evidence-fact-frame-formation.js";
import { certifyEvidenceSemanticCompleteness } from "../../../memory/evidence-create/evidence-semantic-completeness.js";
import { materializeOpenSemanticFactorFormation } from "../../../semantic/open-semantic-factor-formation.js";
import { RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER as normalizer } from
  "../../../memory/fact-frame-formation/declarative-normalizer.js";
import { createRecallRealStorage } from "../../shared/real-sqlite.test-support.js";
import { createEvidenceInput } from "../evidence-service-fixture.js";

const sourceHash = formatVerifiedUserAssertionSourceHash("b".repeat(64));
function graph(source: string) {
  return { schema_version: 1 as const, producer_operator_id: "garden_source_bound_open_semantic_factor_v3",
    source_text: source, graph: { schema_version: 2 as const, source_kind: "evidence" as const,
      factors: [
        { factor_id: "finish", surface: "finish", semantic_identity: "finish", source_occurrence: 0 },
        { factor_id: "report", surface: "the report", semantic_identity: "report", source_occurrence: 0 }
      ], variables: [], result_variable_ids: [], propositions: [{ proposition_id: "p",
        predicate_factor_id: "finish", arguments: [{ position: 0, binding_identity: "object",
          reference_kind: "factor" as const, reference_id: "report" }] }]
    } };
}

it.each(["can", "cannot", "might", "must"])("stores %s as a distinct obligation and canonicalizes missing Garden modality", async (modal) => {
  const { database, evidenceCapsuleRepo } = await createRecallRealStorage(() => undefined);
  try {
    const source = `I ${modal} finish the report.`;
    const service = new EvidenceService({ evidenceCapsuleRepo, eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: vi.fn() }, factFrameProposalNormalizer: normalizer });
    const created = await service.create(createEvidenceInput({ excerpt: source, source_hash: sourceHash }), [], undefined, graph(source));
    const fact = database.connection.prepare("SELECT fact_frame_json FROM evidence_fact_frame_formations WHERE evidence_object_id = ?")
      .get(created.object_id) as { fact_frame_json: string };
    expect(JSON.parse(fact.fact_frame_json).slots).toEqual([
      { role: "subject", text: "I" }, { role: "qualifier", text: modal },
      { role: "relation", text: "finish" }, { role: "value", text: "the report" }
    ]);
    const semantic = database.connection.prepare("SELECT graph_json, semantic_completeness_json FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?")
      .get(created.object_id) as { graph_json: string; semantic_completeness_json: string };
    expect(JSON.parse(semantic.graph_json).factors).toContainEqual(expect.objectContaining({
      surface: modal, semantic_identity: modal, source_span: [2, 2 + modal.length]
    }));
    expect(JSON.parse(semantic.semantic_completeness_json)).toMatchObject({ status: "certified",
      arguments: expect.arrayContaining([expect.objectContaining({ role: "qualifier", surface: modal })]) });
  } finally { database.close(); }
});

it("keeps the capsule but rejects an explicit frame that drops modal negation", async () => {
  const { database, evidenceCapsuleRepo } = await createRecallRealStorage(() => undefined);
  try {
    const source = "I can not finish the report.";
    const proposal = normalizer.propose(source)!;
    const service = new EvidenceService({ evidenceCapsuleRepo, eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: vi.fn() }, factFrameProposalNormalizer: normalizer });
    const created = await service.create(createEvidenceInput({ excerpt: source, source_hash: sourceHash }), [], {
      ...proposal, fact_frame: { ...proposal.fact_frame, slots: proposal.fact_frame.slots.filter((slot) => slot.text !== "not") }
    }, graph(source));
    expect(await evidenceCapsuleRepo.findById(created.object_id)).toMatchObject({ excerpt: source });
    expect(database.connection.prepare("SELECT status FROM evidence_fact_frame_formations WHERE evidence_object_id = ?")
      .get(created.object_id)).toMatchObject({ status: "rejected" });
    const semantic = database.connection.prepare("SELECT semantic_completeness_json FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?")
      .get(created.object_id) as { semantic_completeness_json: string };
    expect(JSON.parse(semantic.semantic_completeness_json).status).not.toBe("certified");
  } finally { database.close(); }
});

it("rejects a resealed modal-free retained capture in both replay and certification", () => {
  const source = "I might finish the report.";
  const capture = materializeEvidenceFactFrameFormation({ sourceAssertion: source, sourceHash, normalizer }).capture;
  const { capture_digest: _digest, ...body } = capture;
  const omitted = { ...body, fact_frame: { ...capture.fact_frame!,
    slots: capture.fact_frame!.slots.filter((slot) => slot.role !== "qualifier") } };
  const tampered = { ...omitted, capture_digest: `sha256:${createHash("sha256")
    .update(evidenceFactFrameFormationCapturePreimage(omitted)).digest("hex")}` };
  expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash, capture: tampered })).toThrow();
  const semanticFormation = materializeOpenSemanticFactorFormation({ source_kind: "evidence", source_text: source, proposal: graph(source) });
  expect(certifyEvidenceSemanticCompleteness({ sourceText: source, factFrame: tampered, semanticFormation }).receipt)
    .toMatchObject({ status: "rejected", reason_code: "invalid_fact_frame_obligation" });
});

it.each(["I'd finish the report.", "I’d finish the report.", "I can not currently finish the report.", "Acme can finish the report."])(
  "does not let caller slots certify an unsupported modal construction: %s", (source) => {
    const formed = materializeEvidenceFactFrameFormation({ sourceAssertion: source, sourceHash, proposal: {
      schema_version: 1, producer_operator_id: "caller", source_assertion: source,
      fact_frame: { schema_version: 1, slots: [
        { role: "subject", text: source.startsWith("Acme") ? "Acme" : "I" },
        { role: "relation", text: "finish" }, { role: "value", text: "the report" }
      ] }
    } });
    expect(formed.capture.status).toBe("rejected");
  }
);
