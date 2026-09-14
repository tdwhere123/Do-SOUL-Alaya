import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FormationKind, MemoryDimension, ScopeClass, SourceKind,
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID, EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID, buildAssociativeFactKeyProjections,
  evidenceFactFrameFormationCapturePreimage, evidenceOsfSemanticCompletenessPreimage,
  groundOpenSemanticFactorGraph, openSemanticFactorFormationCapturePreimage,
  verifyEvidenceOsfSemanticCompleteness, type AssociativeFactFrame
} from "@do-soul/alaya-protocol";
import { factFramePreservesSourceObligations } from "@do-soul/alaya-protocol/node/source-frame";
import { initDatabase, readObjectKeyEvidenceSources, scanObjectKeyRetrofitSources,
  SqliteEventLogRepo, SqliteMemoryObjectKeyRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { EvidenceService } from "../../memory/evidence-service.js";
import { MemoryService } from "../../memory/memory-service.js";
import { createMemoryObjectKeyWriter } from "../../memory/object-keys/write-service.js";
import { retrofitMemoryObjectKeys } from "../../memory/object-keys/retrofit/retrofit.js";
import { createRecallRealStorage } from "../shared/real-sqlite.test-support.js";
import { createEvidenceInput } from "./evidence-service-fixture.js";

it.each([
  { source: "I can enter the lab.", relation: "enter", value: "the lab", supported: true },
  { source: "I can enter the lab without a badge.", relation: "enter", value: "the lab", supported: false },
  { source: "I can enter the lab or use the equipment.", relation: "use", value: "the equipment", supported: false }
])("qualifies reopened historical derivatives before both object-key writing and retrofit: $source", async (entry) => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-object-key-source-"));
  const filename = join(directory, "source.sqlite");
  const { database, evidenceCapsuleRepo, memoryEntryRepo } = await createRecallRealStorage(() => undefined, filename);
  try {
    const evidence = new EvidenceService({ evidenceCapsuleRepo, eventLogRepo: new SqliteEventLogRepo(database),
      runtimeNotifier: { notifyEntry: async () => undefined } });
    const capsule = await evidence.create(createEvidenceInput({ excerpt: entry.source, gist: "Golden Retriever",
      source_hash: "sha256:historical-source" }));
    const service = new MemoryService({ evidenceService: { findById: (id) => evidenceCapsuleRepo.findById(id),
      findByIds: (workspace, ids) => evidenceCapsuleRepo.findByIds(workspace, ids) },
      eventLogRepo: new SqliteEventLogRepo(database), memoryEntryRepo,
      runtimeNotifier: { notifyEntry: async () => undefined } });
    const memory = await service.create({ created_by: "user_action", dimension: MemoryDimension.FACT,
      source_kind: SourceKind.USER, formation_kind: FormationKind.EXPLICIT, scope_class: ScopeClass.PROJECT,
      content: "A visit is planned.", domain_tags: [], evidence_refs: [capsule.object_id],
      workspace_id: "workspace-1", run_id: "run-1", surface_id: null });
    const frame: AssociativeFactFrame = { schema_version: 1, slots: [
      { role: "subject", text: "I" }, { role: "qualifier", text: "can" },
      { role: "relation", text: entry.relation }, { role: "value", text: entry.value }
    ] };
    const captures = historicalCaptures(entry.source, frame);
    expect(verifyEvidenceOsfSemanticCompleteness({ receipt: captures.receipt, source_text: entry.source,
      fact_frame: captures.factFrame, semantic_formation: captures.semantic, sha256 }).status).toBe("certified");
    expect(factFramePreservesSourceObligations(entry.source, frame)).toBe(entry.supported);
    database.connection.prepare(`UPDATE evidence_fact_frame_formations SET status = 'formed', producer_operator_id = ?,
      source_hash = ?, fact_frame_json = ?, capture_digest = ? WHERE evidence_object_id = ?`)
      .run(captures.factFrame.producer_operator_id, captures.factFrame.source_hash, JSON.stringify(frame),
        captures.factFrame.capture_digest, capsule.object_id);
    database.connection.prepare(`UPDATE evidence_semantic_factor_formations SET status = 'formed', producer_operator_id = ?,
      source_sha256 = ?, graph_json = ?, capture_digest = ?, semantic_completeness_json = ? WHERE evidence_object_id = ?`)
      .run(captures.semantic.producer_operator_id, captures.semantic.source_sha256, JSON.stringify(captures.semantic.graph),
        captures.semantic.capture_digest, JSON.stringify(captures.receipt), capsule.object_id);
    for (const projection of buildAssociativeFactKeyProjections(frame)) database.connection.prepare(`INSERT INTO evidence_search_projections
      (evidence_object_id, workspace_id, source_hash, projection_id, projection_kind, content) VALUES (?, ?, ?, ?, 'fact_key', ?)`)
      .run(capsule.object_id, capsule.workspace_id, capsule.source_hash, projection.projection_id, projection.content);
    database.close();
    const reopened = initDatabase({ filename });
    try {
      const keys = new SqliteMemoryObjectKeyRepo(reopened);
      const writer = createMemoryObjectKeyWriter({ readEvidenceSources: (workspace, ids) =>
        readObjectKeyEvidenceSources(reopened, workspace, ids), replaceOwnerKeys: (workspace, owner, minted) =>
        keys.replaceOwnerKeys(workspace, owner, minted) });
      writer.materializeForMemory(memory);
      const minted = keys.listByOwner(memory.workspace_id, memory.object_id);
      expect(minted.filter(({ key_type }) => key_type === "osf_identity").map(({ surface }) => surface).sort())
        .toEqual(entry.supported ? ["access", "laboratory"] : []);
      expect(minted.some(({ key_type }) => key_type === "gist_remainder")).toBe(true);
      const scan = scanObjectKeyRetrofitSources(reopened);
      expect(scan.owners.map(({ object_id }) => object_id)).toContain(memory.object_id);
      retrofitMemoryObjectKeys({ ...scan, replaceOwnerKeys: (workspace, owner, values) => keys.replaceOwnerKeys(workspace, owner, values) });
      expect(keys.listByOwner(memory.workspace_id, memory.object_id)).toEqual(minted);
      expect((await new SqliteEvidenceCapsuleRepo(reopened).findById(capsule.object_id))?.excerpt).toBe(entry.source);
      expect(reopened.connection.prepare("SELECT semantic_completeness_json FROM evidence_semantic_factor_formations WHERE evidence_object_id = ?")
        .get(capsule.object_id)).toEqual({ semantic_completeness_json: JSON.stringify(captures.receipt) });
      if (entry.supported) {
        reopened.connection.prepare("UPDATE evidence_search_projections SET content = 'invented fact' WHERE evidence_object_id = ? AND projection_id = 1")
          .run(capsule.object_id);
        const [changed] = readObjectKeyEvidenceSources(reopened, memory.workspace_id, [capsule.object_id]);
        expect(changed?.fact_key_contents).not.toContain("invented fact");
        expect(changed?.fact_key_contents).toHaveLength(buildAssociativeFactKeyProjections(frame).length - 1);
        expect(changed?.osf_graph).toEqual(captures.semantic.graph);
        reopened.connection.prepare("UPDATE evidence_fact_frame_formations SET fact_frame_json = '{}' WHERE evidence_object_id = ?")
          .run(capsule.object_id);
        expect(() => readObjectKeyEvidenceSources(reopened, memory.workspace_id, [capsule.object_id]))
          .toThrow("Evidence projection integrity failed");
      }
    } finally { reopened.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

/** Seal historical frame-to-graph binding without invoking today's source grammar. */
function historicalCaptures(source: string, frame: AssociativeFactFrame) {
  const frameBody = { schema_version: 1 as const, operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status: "formed" as const, producer_operator_id: "rule_based_evidence_fact_frame_normalizer_v2",
    source_hash: "sha256:historical-source", fact_frame: frame };
  const factFrame = { ...frameBody, capture_digest: `sha256:${sha256(evidenceFactFrameFormationCapturePreimage(frameBody))}` };
  const slots = frame.slots.map(({ role, text }) => ({ role, surface: text,
    source_span: [source.indexOf(text), source.indexOf(text) + text.length] as const }));
  const predicate = { ...slots[2]!, position: null };
  const args = [slots[0]!, slots[1]!, slots[3]!].map((slot, position) => ({ ...slot, position }));
  const graph = groundOpenSemanticFactorGraph({ schema_version: 2, source_kind: "evidence", variables: [], result_variable_ids: [],
    factors: [predicate, ...args].map((slot, index) => ({ factor_id: `f${index}`, surface: slot.surface, source_occurrence: 0,
      semantic_identity: index === 0 ? "access" : index === 3 ? "laboratory" : slot.surface.toLowerCase() })),
    propositions: [{ proposition_id: "p", predicate_factor_id: "f0", arguments: args.map((_, index) => ({
      position: index, binding_identity: `slot${index}`, reference_kind: "factor", reference_id: `f${index + 1}`
    })) }] }, source)!;
  const semanticBody = { schema_version: 1 as const, operator_id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
    status: "formed" as const, producer_operator_id: "core_fact_frame_canonical_open_semantic_factor_v1",
    source_sha256: `sha256:${sha256(source)}`, graph };
  const semantic = { ...semanticBody, capture_digest: `sha256:${sha256(openSemanticFactorFormationCapturePreimage(semanticBody))}` };
  const receiptBody = { schema_version: 1 as const, operator_id: EVIDENCE_OSF_SEMANTIC_COMPLETENESS_OPERATOR_ID,
    status: "certified" as const, reason_code: "complete" as const, fact_frame_capture_digest: factFrame.capture_digest,
    semantic_formation_capture_digest: semantic.capture_digest, predicate, arguments: args, arity: args.length };
  return { factFrame, semantic, receipt: { ...receiptBody,
    receipt_digest: `sha256:${sha256(evidenceOsfSemanticCompletenessPreimage(receiptBody))}` } };
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
