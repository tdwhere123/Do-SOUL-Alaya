import { expect, it } from "vitest";
import {
  canonicalIndexEntryIdentity,
  indexEntryCacheKey
} from "../../recall/conditional-field/index-view.js";
import {
  ORDINARY_NATIVE_FIELD_RESULT_VERSION,
  RecallNavigationWitnessSchema
} from "../../recall/conditional-field/navigation.js";
import { memoryIndexEntry, sourceIndexEntry } from "../../recall/conditional-field/index-view.js";
import { MemorySearchResultSchema } from "../../surfaces/mcp-memory-search-types.js";
import {
  SoulInterpretationFieldRecallDeliverySchema,
  SoulInterpretationRequestSchema,
  SoulInterpretationResponseSchema
} from "../../surfaces/mcp-interpretation-types.js";
import { encodeSourceDisclosure } from "../../recall/source-disclosure.js";
import { sourceSemanticExecution } from "../../garden/source-semantic-access.js";
import { admitSourceSemanticWorkerResultFamily,
  SourceSemanticReadableWorkerResultSchema } from "../../garden/source-semantic-comparison-worker.js";
import {
  SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION,
  SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
  SourceSemanticFieldLibraryDeliverySchema,
  SourceSemanticFieldLibraryWorkerResultSchema,
  SourceSemanticLibraryDeliverySchema,
  SourceSemanticWorkerRequestSchema,
  SourceSemanticWorkerResultSchema,
  SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
  verifySourceSemanticLibraryDelivery
} from "../../garden/source-semantic-worker.js";

const digest = `sha256:${"a".repeat(64)}`;
const queryDigest = `sha256:${"d".repeat(64)}`;
const coverage = {
  discovery: "complete" as const, source_interpretation: "unexercised" as const,
  query_semantics: "unexercised" as const, semantic_correspondence: "unexercised" as const,
  conditional_computation: "unexercised" as const, payload: "complete" as const
};
const work = { native_work: 1, native_bytes: 2, logical_memory_bytes: 3, rss_bytes: 4 };
const execution = sourceSemanticExecution();
const sourceRowDisclosure = encodeSourceDisclosure({ material_kind: "original_body",
  source_binding: "checked_record", evaluated_as_of: "2026-09-25T00:00:00Z",
  validity: { kind: "unknown", reason: "not_recorded" }, temporal_state: "unknown",
  proof_use: { kind: "source_only", qualification: "not_current_proof" } });

function discovery() {
  return { eligible_source_count: 1, visited_source_pages: 1, visited_source_interpretation_pages: 1,
    visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
    unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0,
    examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, open_residuals: false, truncated: false };
}

function order() {
  return { enumeration_policy: "native_query" as const, tie_policy: "canonical_identity" as const,
    occupancy: "tagged_target_identity" as const, occupancy_prefix: 2, page_budget: 2 };
}

function resultFor(entry: ReturnType<typeof memoryIndexEntry>, preview: string) {
  const base = { target: entry.target, relevance_score: 0.5, content_preview: preview,
    evidence_pointers: [], selection_reason: "native query order", source_channels: ["conditional_field"],
    score_factors: { activation: 0.5, relevance: 0.5 }, budget_state: { token_estimate: 1,
      max_entries: 2, max_total_tokens: 10, remaining_entries: 1, remaining_tokens: 9, within_budget: true } };
  if (entry.target.kind !== "source_evidence") {
    return MemorySearchResultSchema.parse({ ...base, object_id: entry.target.object_id,
      object_kind: "memory_entry" });
  }
  return MemorySearchResultSchema.parse({ ...base, object_kind: "source_evidence",
    source_disclosure: sourceRowDisclosure });
}

const memoryEntry = memoryIndexEntry({ workspace_id: "workspace", object_id: "memory-1",
  source_revision: "v1", association_milligrades: 400 });
const sourceEntry = sourceIndexEntry({ workspace_id: "workspace", root_kind: "source_record",
  root_id: "record-1", source_version: "v1", content_digest: digest, evidence_object_id: null,
  association_milligrades: 300 });

function fieldDelivery() {
  const entries = [memoryEntry, sourceEntry];
  const memoryRow = resultFor(memoryEntry, "memory preview");
  const sourceRow = resultFor(sourceEntry, "source preview");
  return {
    delivery_id: "delivery-1", request_identity: digest,
    query_semantics_status: { status: "unavailable", reason: "absent" },
    protocol_version: SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, total_count: 2,
    index: { schema_version: 1, query_id: "field-query", snapshot_id: digest,
      result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION, entries, completeness: { schema_version: 1,
        logical_index: "complete", observed_coverage: "complete", transport: "complete",
        payload: "complete", representation: "complete" },
      continuation: null, representation: { schema_version: 1,
        policy: "construct_index_then_page_then_payload", page_budget: 2, identity_tie_break: "serialization" },
      page_purpose: "membership" },
    results: [memoryRow, sourceRow], page_purpose: "membership", discovery: discovery(), order: order(),
    // Memory targets carry no Q/H/C premise; the source slot carries the source qualifier.
    slot_qualifiers: [{ index: 1, evidence_kind: "source_evidence" as const }],
    source_disclosures: { [indexEntryCacheKey(sourceEntry)]: sourceRowDisclosure }
  };
}

function fieldWorkerResult() {
  return { kind: "recall" as const, ...fieldDelivery(), coverage, work, execution };
}

function fieldPublicResponse() {
  const { kind: _kind, ...delivery } = fieldWorkerResult();
  return { operation: "recall" as const, ...delivery };
}

function legacyDelivery() {
  return { delivery_id: "delivery-v6", request_identity: digest,
    query_semantics_status: { status: "unavailable" as const, reason: "absent" as const },
    protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, total_count: 0,
    index: { schema_version: 1, query_id: "library-query", snapshot_id: digest,
      result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, entries: [],
      completeness: { schema_version: 1, logical_index: "complete" as const, observed_coverage: "complete" as const,
        transport: "complete" as const, payload: "complete" as const, representation: "complete" as const },
      continuation: null, representation: { schema_version: 1,
        policy: "construct_index_then_page_then_payload" as const, page_budget: 5, identity_tie_break: "serialization" as const },
      page_purpose: "membership" as const },
    page_purpose: "membership" as const, discovery: discovery(),
    order: { enumeration_policy: "evidence_support" as const, tie_policy: "canonical_identity" as const,
      occupancy: "source_gold_root_identity" as const, occupancy_prefix: 5, page_budget: 5 },
    slot_qualifiers: [], source_disclosures: {} };
}

it("delivers a current field page with mixed tagged targets and no invented proof support", () => {
  const delivery = fieldDelivery();
  const accepted = SourceSemanticFieldLibraryDeliverySchema.safeParse(delivery);
  expect(accepted.success, accepted.success ? "" : JSON.stringify(accepted.error.issues)).toBe(true);
  expect(SourceSemanticFieldLibraryWorkerResultSchema.safeParse(fieldWorkerResult()).success).toBe(true);
  expect(SoulInterpretationFieldRecallDeliverySchema.safeParse(fieldPublicResponse()).success).toBe(true);
  const decoded = SoulInterpretationResponseSchema.parse(fieldPublicResponse());
  expect(decoded.operation).toBe("recall");
  if (decoded.operation !== "recall") throw new Error("expected recall delivery");
  if (decoded.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) {
    throw new Error("expected the current field delivery, not a historical reader");
  }
  expect(decoded.results.map((row) => row.target.kind)).toEqual(["memory_entry", "source_evidence"]);

  // Row order and interval identity are the delivered order, not a re-derived ranking.
  expect(SourceSemanticFieldLibraryDeliverySchema.safeParse({ ...delivery,
    results: [...delivery.results].reverse() }).success).toBe(false);
  expect(SourceSemanticFieldLibraryDeliverySchema.safeParse({ ...delivery, total_count: 1 }).success).toBe(false);
  expect(SourceSemanticFieldLibraryDeliverySchema.safeParse({ ...delivery,
    results: [delivery.results[0]!, { ...delivery.results[1]!, target: {
      ...delivery.results[1]!.target, content_digest: `sha256:${"e".repeat(64)}` } }] }).success).toBe(false);
  // A memory slot cannot inherit a source Q/H/C premise.
  expect(SourceSemanticFieldLibraryDeliverySchema.safeParse({ ...delivery,
    slot_qualifiers: [{ index: 0, evidence_kind: "source_evidence" }] }).success).toBe(false);
  // A source row is indivisible from its disclosure.
  expect(SourceSemanticFieldLibraryDeliverySchema.safeParse({ ...delivery,
    source_disclosures: {} }).success).toBe(false);
});

it("keeps the archived v6 delivery readable while refusing a frozen v6 cursor in a current page", () => {
  const legacy = legacyDelivery();
  expect(SourceSemanticLibraryDeliverySchema.safeParse(legacy).success).toBe(true);
  expect(SourceSemanticWorkerResultSchema.safeParse({ kind: "recall", ...legacy,
    coverage, work }).success).toBe(true);
  // The v6 reader is not a current field page and cannot substitute its cursor family.
  expect(SourceSemanticFieldLibraryDeliverySchema.safeParse(legacy).success).toBe(false);
  const delivery = fieldDelivery();
  const legacyCursor = { schema_version: 1, continuation_id: "page-5", query_id: "field-query",
    snapshot_id: digest, result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
    expires_at: "2099-01-01T00:00:00.000Z", cursor: "offset-5" };
  expect(SourceSemanticFieldLibraryDeliverySchema.safeParse({ ...delivery,
    index: { ...delivery.index, continuation: legacyCursor } }).success).toBe(false);
  const fieldCursor = { ...legacyCursor, result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION,
    enumeration_policy: "native_query" as const };
  expect(SourceSemanticFieldLibraryDeliverySchema.safeParse({ ...delivery,
    index: { ...delivery.index, continuation: fieldCursor } }).success).toBe(true);
});

it("carries a returned field cursor through live public and worker recall ingress", () => {
  const budget = { schema_version: 1, work_units: 100, memory_bytes: 100_000,
    page_budget: 2, finalization_reserve: 10, min_envelope: 1 } as const;
  const returned = SoulInterpretationResponseSchema.parse({ ...fieldPublicResponse(),
    index: { ...fieldDelivery().index, continuation: { schema_version: 1, continuation_id: "page-2",
      query_id: "field-query", snapshot_id: digest, result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION,
      expires_at: "2099-01-01T00:00:00.000Z", cursor: "offset-2", enumeration_policy: "native_query" } } });
  if (returned.operation !== "recall" || returned.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) {
    throw new Error("expected the current field delivery");
  }
  expect(returned.index?.continuation).not.toBeNull();
  const cursor = returned.index!.continuation;
  // The cursor the producer actually returned is the one live ingress resumes.
  const recall = { accepts_unreviewed_conditional_results: true as const, query_handle: "query-handle",
    budget, output_byte_limit: 4096, continuation: cursor };
  expect(SoulInterpretationRequestSchema.parse({ operation: "recall", ...recall })).toMatchObject({ continuation: cursor });
  expect(SourceSemanticWorkerRequestSchema.parse({ kind: "recall", ...recall })).toMatchObject({ continuation: cursor });
  // An archived v6 cursor stays readable in its recorded delivery but cannot enter live
  // execution under a substituted enumeration policy.
  const archived = legacyDelivery();
  const archivedCursor = { schema_version: 1, continuation_id: "page-5", query_id: "library-query",
    snapshot_id: digest, result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION,
    expires_at: "2099-01-01T00:00:00.000Z", cursor: "offset-5" };
  expect(SourceSemanticLibraryDeliverySchema.safeParse({ ...archived,
    index: { ...archived.index, continuation: archivedCursor } }).success).toBe(true);
  expect(SoulInterpretationRequestSchema.safeParse({ operation: "recall", ...recall,
    continuation: archivedCursor }).success).toBe(false);
  expect(SourceSemanticWorkerRequestSchema.safeParse({ kind: "recall", ...recall,
    continuation: archivedCursor }).success).toBe(false);
});

it("round-trips the current field result through the worker wire reader", () => {
  const wire: unknown = JSON.parse(JSON.stringify(fieldWorkerResult()));
  const readable = SourceSemanticReadableWorkerResultSchema.parse(wire);
  expect(readable.kind).toBe("recall");
  if (readable.kind !== "recall") throw new Error("expected the current field recall result");
  expect(admitSourceSemanticWorkerResultFamily(readable, false)).toBe(readable);
  // A truncated delivery is a decode failure, not a smaller valid page.
  const truncated = { ...fieldWorkerResult(), results: [fieldDelivery().results[0]!] };
  expect(SourceSemanticReadableWorkerResultSchema.safeParse(
    JSON.parse(JSON.stringify(truncated))).success).toBe(false);
});

it("admits the current field result on the public family but not as the private comparison family", () => {
  const parsed = SourceSemanticWorkerResultSchema.parse(fieldWorkerResult());
  expect(admitSourceSemanticWorkerResultFamily(parsed, false)).toBe(parsed);
  expect(() => admitSourceSemanticWorkerResultFamily(
    parsed as Parameters<typeof admitSourceSemanticWorkerResultFamily>[0], true))
    .toThrow(/another contract family/u);
});

it("applies the delivered field binding through the shared library verifier", () => {
  const delivery = SourceSemanticFieldLibraryDeliverySchema.parse(fieldDelivery());
  const sha256 = () => digest;
  expect(verifySourceSemanticLibraryDelivery(delivery, sha256)).toBe(delivery);
  // The library identity entry must verify the current family, not only the
  // archived delivery checks a v6 caller expects.
  expect(() => verifySourceSemanticLibraryDelivery({ ...delivery, total_count: 1 }, sha256))
    .toThrow(/exact delivered tagged targets/u);
});

it("refuses a declared field page that omits its delivered binding", () => {
  const delivery = SourceSemanticFieldLibraryDeliverySchema.parse(fieldDelivery());
  const { total_count: _totalCount, results: _results, ...withoutBinding } = delivery;
  // The verifier owns family admission: naming the field family without its
  // delivered binding must not fall back to the archived checks.
  expect(() => verifySourceSemanticLibraryDelivery(withoutBinding, () => digest))
    .toThrow(/delivered total_count and results/u);
});

it("carries navigation as ordinal discovery evidence outside product identity and association grades", () => {
  const witness = { contract: "native-query-navigation.v1" as const, query_digest: queryDigest,
    view: "original" as const, operator: "source_lexical" as const, ordinal: 0, native_rank: 1,
    reference: "occurrence-1" };
  expect(RecallNavigationWitnessSchema.safeParse(witness).success).toBe(true);
  const located = { ...witness, location: { start_byte: 4, end_byte: 9 } };
  expect(RecallNavigationWitnessSchema.safeParse(located).success).toBe(true);
  for (const rejected of [
    { ...witness, contract: "native-query-navigation.v2" },
    { ...witness, operator: "associative_neighbour" },
    { ...witness, view: "hint", ordinal: -1 },
    { ...witness, native_rank: 0 },
    { ...witness, location: { start_byte: 9, end_byte: 9 } },
    { ...witness, association_milligrades: 900 }
  ]) expect(RecallNavigationWitnessSchema.safeParse(rejected).success).toBe(false);
  const catalog = { contract: "native-query-navigation.v1", query_digest: queryDigest,
    view: "original", operator: "bound_catalog", ordinal: 3, access_ordinal: 2,
    reference: "catalog:3" };
  expect(RecallNavigationWitnessSchema.safeParse(catalog).success).toBe(true);

  const ranked = { ...sourceEntry, navigation: located };
  expect(canonicalIndexEntryIdentity(ranked)).toBe(canonicalIndexEntryIdentity(sourceEntry));
  expect(RecallNavigationWitnessSchema.parse(ranked.navigation)).toMatchObject({ ordinal: 0, native_rank: 1 });
});
