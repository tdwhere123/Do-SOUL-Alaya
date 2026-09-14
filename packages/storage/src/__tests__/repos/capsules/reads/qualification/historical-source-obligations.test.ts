import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  buildAssociativeFactKeyProjections,
  evidenceFactFrameFormationCapturePreimage,
  evidenceOsfSemanticCompletenessPreimage,
  groundOpenSemanticFactorGraph,
  openSemanticFactorFormationCapturePreimage,
  verifyEvidenceOsfSemanticCompleteness,
  type AssociativeFactFrame,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCaptureBody,
  type OpenSemanticFactorFormationCaptureBody
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../../../sqlite/db.js";
import { SqliteEvidenceCapsuleRepo } from "../../../../../repos/capsules/evidence-capsule-repo.js";
import { readObjectKeyEvidenceSources } from "../../../../../repos/capsules/reads/object-key-source-reader.js";
import { createEvidenceCapsuleRepo, evidenceCapsuleDatabases } from "../../evidence-capsule-repo-fixture.js";
import { removeTempDirectorySync } from "../../../../temp-directory.js";
import { assertionCapsule, insertMaterializationEvent, persistAssertionSignal, verifiedAssertionSourceHash } from
  "./verified-assertion-qualification-fixture.js";

const directories = new Set<string>();
afterEach(() => {
  for (const db of evidenceCapsuleDatabases) db.close();
  evidenceCapsuleDatabases.clear();
  for (const directory of directories) removeTempDirectorySync(directory);
  directories.clear();
});

const frame: AssociativeFactFrame = { schema_version: 1, slots: [
  { role: "subject", text: "I" }, { role: "qualifier", text: "can" },
  { role: "relation", text: "enter" }, { role: "value", text: "the lab" }
] };

it.each([
  "I can enter the lab only if I have a badge.",
  "I can enter the lab without a badge.",
  "I can enter the lab with a badge.",
  "I can enter the lab except on Sundays.",
  "I can enter the lab after the surgery.",
  "I can enter the lab or use the equipment.",
  "Without the badge I can enter the lab."
])("keeps historical source receipts while refusing incomplete derived views after reopen: %s", async (source) => {
  await assertHistoricalRead(source, frame, false);
});

it("refuses a historical frame that loses modality while its v1 source proof still qualifies", async () => {
  await assertHistoricalRead("I can enter the lab.", { ...frame,
    slots: frame.slots.filter(({ role }) => role !== "qualifier") }, false);
});

it.each([
  { source: "I can enter the lab or use the equipment.", subject: "I", qualifier: "can", relation: "use" },
  { source: "Alice enters the lab or uses the equipment.", subject: "Alice enters the lab or", relation: "uses" }
])("refuses historical frames whose proposed anchors skip the primary source predicate: $subject", async (entry) => {
  await assertHistoricalRead(entry.source, { schema_version: 1, slots: [
    { role: "subject", text: entry.subject },
    ...(entry.qualifier === undefined ? [] : [{ role: "qualifier" as const, text: entry.qualifier }]),
    { role: "relation", text: entry.relation }, { role: "value", text: "the equipment" }
  ] }, false);
});

it.each(["I can enter the lab.", "I have entered the lab."])(
  "keeps supported historical source frames and normalized auxiliaries readable: %s", async (source) => {
    await assertHistoricalRead(source, source.includes("entered") ? { schema_version: 1, slots: [
      { role: "subject", text: "I" }, { role: "relation", text: "entered" }, { role: "value", text: "the lab" }
    ] } : frame, true);
  });

async function assertHistoricalRead(source: string, factFrame: AssociativeFactFrame, supported: boolean): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "alaya-historical-source-"));
  directories.add(directory);
  const filename = join(directory, "source.sqlite");
  const { database, repo } = await createEvidenceCapsuleRepo(filename);
  const corpus = `User: ${source}`;
  const capsule = assertionCapsule("cccccccc-1111-4111-8111-cccccccccccc", {
    excerpt: source, gist: corpus,
    source_hash: verifiedAssertionSourceHash(source, corpus, { workspace_id: "workspace-1", run_id: "run-1", surface_id: null })
  });
  await repo.create(capsule);
  const signal = await persistAssertionSignal(database);
  database.connection.prepare("UPDATE signals SET raw_payload_json = ? WHERE signal_id = ?").run(JSON.stringify({
    ...signal.raw_payload, source_assertion: source, full_turn_content: corpus,
    verified_user_assertion_source_hash: capsule.source_hash, distilled_fact: source, fact_frame: factFrame,
    source_grounding: { version: 1, status: "grounded", content_basis: "source_assertion", source_assertion: source,
      proposed_matched_text: source, reasons: [] }
  }), signal.signal_id);
  insertMaterializationEvent(database, signal, capsule);
  const captures = historicalCaptures(source, capsule.source_hash!, factFrame);
  insertHistoricalDerivedRows(database, capsule, captures);
  database.close();
  evidenceCapsuleDatabases.delete(database);
  const reopened = initDatabase({ filename });
  evidenceCapsuleDatabases.add(reopened);
  const reader = new SqliteEvidenceCapsuleRepo(reopened);
  const [qualified] = await reader.findRecallQualifiedByIds("workspace-1", [{ object_id: capsule.object_id }]);
  expect(qualified?.capsule.excerpt).toBe(source);
  expect(qualified?.fact_frame_formation).toEqual(supported ? captures.factFrame : undefined);
  expect(qualified?.semantic_factor_formation).toEqual(supported ? captures.semantic : undefined);
  expect(readObjectKeyEvidenceSources(reopened, "workspace-1", [capsule.object_id])).toEqual([{
    object_id: capsule.object_id, gist: corpus,
    fact_key_contents: supported ? buildAssociativeFactKeyProjections(factFrame).map(({ content }) => content) : [],
    osf_graph: supported ? captures.semantic.graph : null
  }]);
  const verify = () => verifyEvidenceOsfSemanticCompleteness({ receipt: captures.certificate,
    source_text: source, fact_frame: captures.factFrame, semantic_formation: captures.semantic, sha256 });
  if (supported) {
    expect(verify().status).toBe("certified");
    expect((await reader.findRecallQualifiedFactKeysByIds("workspace-1", [capsule.object_id])).length).toBeGreaterThan(0);
  } else {
    // The historical receipt still proves its frame-to-graph claim, not current source completeness.
    expect(verify().status).toBe("certified");
    await expect(reader.findRecallQualifiedFactKeysByIds("workspace-1", [capsule.object_id]))
      .rejects.toThrow("requested fact key does not match its canonical formation");
    // Missing capture must not open the pre-capture Signal fallback to the same incomplete frame.
    reopened.connection.prepare("DELETE FROM evidence_fact_frame_formations WHERE evidence_object_id = ?").run(capsule.object_id);
    await expect(reader.findRecallQualifiedFactKeysByIds("workspace-1", [capsule.object_id]))
      .rejects.toThrow("requested fact key does not match its canonical formation");
  }
  expect(reader.boundedSourceReader().read("workspace-1", capsule.object_id, 65_536, 0)?.prefix?.toString("utf8")).toBe(source);
  expect(reopened.connection.prepare("SELECT semantic_completeness_json FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?")
    .get(capsule.object_id)).toEqual({ semantic_completeness_json: JSON.stringify(captures.certificate) });
}

/** Historical fixtures seal only frame-to-graph equality, independently of the current source obligation owner. */
function historicalCaptures(source: string, sourceHash: string, frame: AssociativeFactFrame) {
  const body: EvidenceFactFrameFormationCaptureBody = { schema_version: 1, operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status: "formed", producer_operator_id: "rule_based_evidence_fact_frame_normalizer_v2", source_hash: sourceHash, fact_frame: frame };
  const factFrame = { ...body, capture_digest: `sha256:${sha256(evidenceFactFrameFormationCapturePreimage(body))}` };
  const grounded = frame.slots.map(({ role, text }) => ({ role, surface: text,
    source_span: [source.indexOf(text), source.indexOf(text) + text.length] as const }));
  const predicate = { ...grounded.find(({ role }) => role === "relation")!, position: null };
  const argumentsInOrder = [...grounded.filter(({ role }) => role === "subject"),
    ...grounded.filter(({ role }) => role === "qualifier" || role === "time"), ...grounded.filter(({ role }) => role === "value")];
  const args = argumentsInOrder.map((slot, position) => ({ ...slot, position }));
  const graph = groundOpenSemanticFactorGraph({ schema_version: 2, source_kind: "evidence", variables: [], result_variable_ids: [],
    factors: [predicate, ...args].map((slot, index) => ({ factor_id: `f${index}`, surface: slot.surface,
      source_occurrence: 0, semantic_identity: slot.surface.toLowerCase() })),
    propositions: [{ proposition_id: "p", predicate_factor_id: "f0", arguments: args.map((_, index) => ({
      position: index, binding_identity: `slot${index}`, reference_kind: "factor", reference_id: `f${index + 1}`
    })) }] }, source)!;
  const semanticBody: OpenSemanticFactorFormationCaptureBody = { schema_version: 1, operator_id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
    status: "formed", producer_operator_id: "core_fact_frame_canonical_open_semantic_factor_v1", source_sha256: `sha256:${sha256(source)}`, graph };
  const semantic = { ...semanticBody, capture_digest: `sha256:${sha256(openSemanticFactorFormationCapturePreimage(semanticBody))}` };
  const certificateBody = { schema_version: 1 as const, operator_id: EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
    status: "certified" as const, reason_code: "complete" as const, fact_frame_capture_digest: factFrame.capture_digest,
    semantic_formation_capture_digest: semantic.capture_digest, predicate, arguments: args, arity: args.length };
  return { factFrame, semantic, certificate: { ...certificateBody,
    receipt_digest: `sha256:${sha256(evidenceOsfSemanticCompletenessPreimage(certificateBody))}` } };
}

function insertHistoricalDerivedRows(db: StorageDatabase, capsule: EvidenceCapsule, captures: ReturnType<typeof historicalCaptures>): void {
  const { factFrame, semantic, certificate } = captures;
  db.connection.prepare(`INSERT INTO evidence_fact_frame_formations (evidence_object_id, workspace_id, schema_version,
    operator_id, status, producer_operator_id, source_hash, fact_frame_json, capture_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(capsule.object_id, capsule.workspace_id, factFrame.schema_version, factFrame.operator_id, factFrame.status,
      factFrame.producer_operator_id, factFrame.source_hash, JSON.stringify(factFrame.fact_frame), factFrame.capture_digest);
  db.connection.prepare(`INSERT INTO evidence_semantic_factor_formations (evidence_object_id, workspace_id, schema_version,
    operator_id, status, producer_operator_id, source_sha256, graph_json, capture_digest, semantic_completeness_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(capsule.object_id, capsule.workspace_id, semantic.schema_version, semantic.operator_id, semantic.status,
      semantic.producer_operator_id, semantic.source_sha256, JSON.stringify(semantic.graph), semantic.capture_digest, JSON.stringify(certificate));
  for (const projection of buildAssociativeFactKeyProjections(factFrame.fact_frame!)) {
    db.connection.prepare(`INSERT INTO evidence_search_projections
      (evidence_object_id, workspace_id, source_hash, projection_id, projection_kind, content) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(capsule.object_id, capsule.workspace_id, capsule.source_hash, projection.projection_id, projection.projection_kind, projection.content);
  }
}

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
