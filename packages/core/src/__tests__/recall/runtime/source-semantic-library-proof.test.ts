import { expect, it } from "vitest";
import { fieldReceiptContractFields, hashSourceRecordId, SourceRecordIdentitySchema,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID, sourceRecallTarget, type SourceSemanticLibraryProof } from "@do-soul/alaya-protocol";
import { executeSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { deliveredSourceSemanticLibraryProof } from "../../../recall/runtime/source-semantic-library-proof.js";
import { sourceSemanticLibraryQueryIdentity, slotQualifiersFor } from "../../../recall/runtime/source-semantic-library-recall.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { source, query, align, CLOCK, ORIGINAL } from "./source-semantic-proof-fixture.js";

function deliveredFixture() {
  const interpretation = source(), semantics = query(), correspondence = align(interpretation, semantics);
  const identity = hashSourceRecordId(interpretation.source, fieldContractSha256);
  const record = SourceRecordIdentitySchema.parse({ ...fieldReceiptContractFields({ identity,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID, consumer: "projection_generation" }), schema_version: 1,
    workspace_id: "ws", ...interpretation.source, evidence_object_id: null, recorded_at: CLOCK,
    event_time: null, valid_from: null, valid_to: null, scope_class: "project", operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID });
  const target = sourceRecallTarget({ workspace_id: record.workspace_id, root_kind: "source_record", root_id: record.identity,
    source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id });
  const admitted = admitSourceSemanticCorrespondence({ source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: ORIGINAL });
  if (admitted.kind !== "admitted") throw new Error("fixture correspondence must be admitted");
  const executed = executeSourceSemanticInterpretation({ source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: ORIGINAL, workspaceId: "ws", scope: "project",
    authorizedScopes: ["project"], asOf: CLOCK, source_target: target, sourceValidity: record });
  if (executed.index === null) throw new Error("fixture must produce native proof");
  const proof: SourceSemanticLibraryProof = { ...executed.result, original_query: ORIGINAL, interpretation,
    query: semantics, semantic_correspondence: correspondence, context: admitted.context, source_record: record };
  const index = { ...executed.index, query_id: sourceSemanticLibraryQueryIdentity(ORIGINAL) };
  const qualifiers = slotQualifiersFor(index, [proof]);
  const offset = qualifiers.findIndex((row) => row.evidence_kind === "semantic_proof");
  if (offset < 0) throw new Error("fixture must deliver a proof slot");
  return { record, target, proof, index, entry: index.entries[offset]!, qualifier: qualifiers[offset]! };
}

it("requires independently supplied publication provenance for a native conditional proof", () => {
  const { record, proof, index, entry, qualifier } = deliveredFixture();
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record)).toBe(proof);
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof])).toBeUndefined();
});

it.each(["root", "workspace", "version", "digest", "record"] as const)("rejects a proof rebound to another %s", (kind) => {
  const { record, proof, index, entry, qualifier, target } = deliveredFixture();
  const changedRecord = { ...record, source_id: "forged-source", workspace_id: "other-workspace" };
  changedRecord.identity = hashSourceRecordId(changedRecord, fieldContractSha256);
  const changed = { ...target,
    ...(kind === "root" ? { root_id: "forged-root" } : kind === "workspace" ? { workspace_id: "other-workspace" }
      : kind === "version" ? { source_version: "another-version" } : kind === "digest" ? { content_digest: `sha256:${"00".repeat(32)}` }
        : { root_id: changedRecord.identity, workspace_id: changedRecord.workspace_id }) };
  const forged = { ...proof, source_target: changed, ...(kind === "record" ? { source_record: changedRecord } : {}) };
  expect(deliveredSourceSemanticLibraryProof(index, { ...entry, target: changed }, qualifier, [forged], record)).toBeUndefined();
});

it.each([null, undefined])("does not promote unknown source scope to project (%s)", (scope_class) => {
  const { record, proof, index, entry, qualifier } = deliveredFixture();
  const unbound = { ...record, scope_class };
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [{ ...proof, source_record: unbound }], unbound)).toBeUndefined();
});
