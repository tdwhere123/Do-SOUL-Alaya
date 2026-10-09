import { IndexEntrySchema, indexEntryCacheKey, SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  SourceSemanticWorkerResultSchema, type IndexEntry, type InformationIndex } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_LIBRARY_ORDER, assembleSourceSemanticLibraryIndex, projectSourceDisclosure,
  sourceSemanticLibrarySourceEntry, sourceGoldRootIdentity, encodeSourceSemanticLibraryResponse, slotQualifiersFor } from "@do-soul/alaya-core";
import { deliveredProofFixture, source, query, correspondenceFor } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { sourceGoldUnitFromPublishedRoot } from "../../../runs/measurement/source-gold-join.js";

export const DIGEST = `sha256:${"ab".repeat(32)}`;
export const CLOCK = "2026-09-18T00:00:00.000Z";
const SNAPSHOT = `sha256:${"cd".repeat(32)}`;
export const REQUEST = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};
export const GOLD_TARGET = {
  kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
  root_id: "gold", source_version: "1", content_digest: DIGEST, evidence_object_id: null
};
export const GOLD = sourceGoldUnitFromPublishedRoot(GOLD_TARGET);

export function sourceOnly(root: string, workspaceId = "ws"): IndexEntry {
  return sourceSemanticLibrarySourceEntry({
    workspaceId, root_id: root, source_version: "1", content_digest: DIGEST,
    evidence_object_id: null, hypothesis_id: "h0"
  });
}

export function proofEntry(root: string): IndexEntry {
  const base = sourceOnly(root);
  return IndexEntrySchema.parse({
    ...base,
    explanation_ids: ["ex-1"],
    interpretation_node: { packet_id: "packet-1", hypothesis_id: base.hypothesis_id, node_id: "n1" }
  });
}

export function assemble(entries: readonly IndexEntry[], proofs: readonly IndexEntry[]) {
  return assembleSourceSemanticLibraryIndex({
    query_id: "library-query", snapshot_id: SNAPSHOT, interpretation_id: "library-interpretation",
    as_of: CLOCK, proof_groups: proofs.length === 0 ? [] : [{ entries: proofs }],
    source_entries: entries, truncated: false, open_residuals: false
  }).index;
}

export function workerRecall(index: InformationIndex) {
  const slot_qualifiers = index.entries.map((entry, offset) => ({
    index: offset,
    ...(entry.interpretation_node !== undefined && entry.explanation_ids.length > 0
      ? { evidence_kind: "semantic_proof" as const, source_interpretation_id: DIGEST, query_semantics_id: DIGEST,
        semantic_correspondence_id: DIGEST, conditional_computation_id: DIGEST,
        witnesses: [{ conditional_computation_id: DIGEST, binding_id: entry.output_binding }],
        support: { answer: "open", evidence_inputs: [], operation: "not_requested", compatibility: "unknown", distinctness: "unknown" } }
      : { evidence_kind: "source_evidence" as const })
  }));
  const source_disclosures = Object.fromEntries(index.entries.map((entry, offset) => [indexEntryCacheKey(entry),
    projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: index.as_of ?? CLOCK,
      proof_use: slot_qualifiers.find(qualifier => qualifier.index === offset)?.evidence_kind === "semantic_proof" ? "conditional_support" : "source_only" })]));
  const result = SourceSemanticWorkerResultSchema.parse({
    kind: "recall", request_budget: REQUEST, delivery_id: "delivery", request_identity: `sha256:${"c".repeat(64)}`,
    query_semantics_status: { status: "admitted", query_semantics_id: DIGEST },
    protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, total_count: index.entries.length,
    index, page_purpose: "membership",
    discovery: {
      eligible_source_count: index.entries.length, visited_source_pages: 1, visited_source_interpretation_pages: 1,
      visited_source_interpretation_descriptors: proofsPresent(index) ? 1 : 0, candidate_prefix: [],
      examined_source_interpretation_ids: [], unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0,
      examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, open_residuals: false, truncated: false
    },
    order: SOURCE_SEMANTIC_LIBRARY_ORDER, slot_qualifiers, source_disclosures,
    coverage: {
      discovery: "complete", source_interpretation: proofsPresent(index) ? "open" : "unexercised",
      query_semantics: "complete", semantic_correspondence: proofsPresent(index) ? "open" : "unexercised",
      conditional_computation: proofsPresent(index) ? "complete" : "open", payload: "complete"
    },
    work: { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 }
  });
  if (result.kind !== "recall") throw new Error("recall expected");
  return result;
}

function proofsPresent(index: InformationIndex): boolean {
  return index.entries.some((entry) => entry.interpretation_node !== undefined && entry.explanation_ids.length > 0);
}

/** Actual execution/delivery witnesses. An optional first proof lacks independent publication admission. */
export function nativeProofResponseFixture(unverifiedFirst = false, workspaceId = "ws") {
  const first = deliveredProofFixture({ library: true, workspaceId });
  const base = source();
  const fixtures = [first, ...(unverifiedFirst ? [deliveredProofFixture({ library: true, workspaceId,
    interpretation: { ...base, source: { ...base.source, source_id: "another-source" } } })] : [])];
  const proofs = fixtures.map((fixture) => fixture.proof);
  const index = assembleSourceSemanticLibraryIndex({ query_id: first.index.query_id, snapshot_id: first.index.snapshot_id,
    interpretation_id: "library-interpretation", as_of: CLOCK, source_entries: [], truncated: false, open_residuals: false,
    proof_groups: fixtures.map((fixture) => ({ entries: fixture.index.entries, explanations: fixture.index.explanations })) }).index;
  const response = encodeSourceSemanticLibraryResponse({ ...workerRecall(index), proofs, slot_qualifiers: slotQualifiersFor(index, proofs),
    query_semantics_status: { status: "admitted", query_semantics_id: first.proof.query_semantics_id! } });
  if (response.operation !== "recall") throw new Error("native proof response expected");
  const target = index.entries[unverifiedFirst ? 1 : 0]!.target;
  if (target.kind !== "source_evidence") throw new Error("native source root expected");
  const record = fixtures.find((fixture) => fixture.record.identity === target.root_id)!.record;
  return { response, record, gold: sourceGoldUnitFromPublishedRoot(target) };
}

/** Independent H/C proofs share a root; a raw slot separates it from another proof root. */
export function nativeMultiProofResponseFixture(partial?: "count" | "tense") {
  const original = partial === "count" ? "how many tools does Alice use?"
    : partial === "tense" ? "which tools did Alice use?" : "which tools does Alice use?";
  const base = source();
  const semantics = query(original);
  if (partial !== undefined) Object.assign(semantics, { gaps: [{
    kind: partial === "count" ? "aggregate" : "unsupported_meaning", affected_ids: [partial === "count" ? "tools" : "use"],
    support: [{ kind: "query_text", excerpt: partial === "count" ? "how many" : "did" }],
    description: partial === "count" ? "Count remains uncomputed." : "Past tense remains unresolved."
  }] });
  const first = deliveredProofFixture({ library: true, original, interpretation: base, semantics });
  const second = deliveredProofFixture({ library: true, original, interpretation: base, semantics,
    correspondence: { ...correspondenceFor(base, semantics), correspondences: correspondenceFor(base, semantics).correspondences
      .filter(row => !("frame" in row.source_endpoint) || row.source_endpoint.frame !== "fBob") } });
  const third = deliveredProofFixture({ library: true, original, semantics,
    interpretation: { ...base, producer_version: "2" } });
  const last = deliveredProofFixture({ library: true, original, semantics,
    interpretation: { ...base, source: { ...base.source, source_id: "later-source" } } });
  const fixtures = [first, second, third, last];
  const proofs = fixtures.map(fixture => fixture.proof);
  const raw = sourceOnly("raw");
  const index = assembleSourceSemanticLibraryIndex({ query_id: first.index.query_id, snapshot_id: first.index.snapshot_id,
    interpretation_id: "library-interpretation", as_of: CLOCK, source_entries: [raw], truncated: false, open_residuals: false,
    proof_groups: fixtures.map(fixture => ({ entries: fixture.index.entries, explanations: fixture.index.explanations })),
    selected_entries: [first.entry, raw, last.entry],
    root_order: [first.target, raw.target, last.target].map(target => {
      if (target.kind !== "source_evidence") throw new Error("source root expected");
      return sourceGoldRootIdentity(target);
    }) }).index;
  const worker = { ...workerRecall(index), proofs, slot_qualifiers: slotQualifiersFor(index, proofs),
    query_semantics_status: { status: "admitted" as const, query_semantics_id: first.proof.query_semantics_id! } };
  const response = encodeSourceSemanticLibraryResponse(worker);
  if (response.operation !== "recall") throw new Error("native proof response expected");
  return { worker, response, records: [first.record, last.record],
    gold: [first.target, raw.target, last.target].map(target => {
      if (target.kind !== "source_evidence") throw new Error("source root expected");
      return sourceGoldUnitFromPublishedRoot(target);
    }) };
}
