import { expect } from "vitest";
import { oracleSourceSemanticJoin, decodeEngineBindings, oracleBindingsMatchEngine, oracleProofsMatchEngine } from "./source-semantic-relational-oracle.js";
import { SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, sourceSemanticInterpretationIdentity,
  sourceSemanticQueryIdentity, type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticCorrespondence,
  fieldReceiptContractFields, hashSourceRecordId, SourceRecordIdentitySchema, SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, sourceRecallTarget, UNKNOWN_UTTERANCE_ATTRIBUTION,
  type SourceSemanticLibraryProof, type RequestBudget } from "@do-soul/alaya-protocol";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";
import { SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID as QUERY_PRODUCER } from "../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID as CORRESPONDENCE_PRODUCER } from "../../../recall/conditional-field/query/source-semantic-correspondence-producer-registry.js";
import { reasonSourceSemanticInterpretation, executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET } from "../../../recall/runtime/source-semantic-reasoning.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { scopeSourceSemanticLibraryBranch, sourceSemanticLibraryQueryIdentity, slotQualifiersFor } from "../../../recall/runtime/source-semantic-library-recall.js";

export const ORIGINAL = "which tools does Alice use?";
export const CLOCK = "2026-09-18T00:00:00.000Z";
export const BUDGET = { schema_version: 1 as const, work_units: 1000000, memory_bytes: 60000000,
  page_budget: 10000, finalization_reserve: 50000, min_envelope: 10 };
export function source(): SourceSemanticInterpretation {
  const names = ["Alice", "Bob", "X", "Y", "uses"];
  return { contract: "source-interpretation-v4", k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "two-users", source_version: "1", content_digest: `sha256:${sha("Alice uses X. Bob uses Y.")}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "fixture", producer_version: "1", contract_version: "source-interpretation-v4",
    mentions: names.map((name, index) => ({ id: `m${name}`, assertion_id: 1, text: name, utf8_span: [0, name.length], source_ref: { first: `a1s${index}`, last: `a1s${index}` } })),
    referents: names.slice(0,4).map((name) => ({ id: `r${name}`, referent_kind: "grouped", mentions: [`m${name}`] })),
    frames: [event("fAlice", "rAlice", "rX"), event("fBob", "rBob", "rY")],
    operators: [], gaps: [], entry_roots: ["fAlice", "fBob"], asserted_at_scope: ["fAlice", "fBob"] };
}
export function catalog(count: number): SourceSemanticInterpretation {
  const brands = ["Ann", "Bea", "Cam", "Dot", "Eve"];
  const items = ["X", "Y", "Z", "U", "V"];
  const names = [...brands.slice(0, count), ...items.slice(0, count), "uses"];
  const frames = Array.from({ length: count }, (_, index) => event(`f${index}`, `r${brands[index]}`, `r${items[index]}`));
  return { contract: "source-interpretation-v4", k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "offer-catalog", source_version: "1", content_digest: `sha256:${sha(names.join(" "))}`,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "fixture", producer_version: "1", contract_version: "source-interpretation-v4",
    mentions: names.map((name, index) => ({ id: `m${name}`, assertion_id: 1, text: name, utf8_span: [0, name.length], source_ref: { first: `a1s${index}`, last: `a1s${index}` } })),
    referents: names.slice(0, count * 2).map((name) => ({ id: `r${name}`, referent_kind: "grouped", mentions: [`m${name}`] })),
    frames, operators: [], gaps: [], entry_roots: frames.map((row) => row.id), asserted_at_scope: frames.map((row) => row.id) };
}
export function event(id: string, actor: string, object: string): SourceSemanticInterpretation["frames"][number] {
  return { id, assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [],
    predicate_support: { kind: "explicit", reading: "use", mentions: ["muses"] },
    slots: [{ id: "agent", role_reading: "agent", support: [] }, { id: "theme", role_reading: "theme", support: [] }],
    bindings: [{ slot_id: "agent", target: { kind: "node", id: actor }, support: [] }, { slot_id: "theme", target: { kind: "node", id: object }, support: [] }] };
}
export function query(original = ORIGINAL, fixed = true): SourceSemanticQuery {
  return { contract: "source-semantic-query-v4", original_query_digest: `sha256:${sha(original)}`,
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: QUERY_PRODUCER, producer_version: "1", contract_version: "source-semantic-query-v4",
    variables: [{ id: "actor", sort: "entity", ...(fixed ? { reference: { kind: "query_text" as const, excerpt: "Alice" } } : {}) },
      { id: "tools", sort: "entity" }, { id: "use", sort: "proposition" }],
    alternatives: [{ frames: [{ id: "qUse", variable: "use", predicate_reading: "use",
      role_requirements: [{ id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text", excerpt: fixed ? "Alice" : "who" } },
        { id: "theme", role_reading: "theme", target_variable: "tools", support: { kind: "query_text", excerpt: "tools" } }] }],
      context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }] }], return_variables: ["tools"], gaps: [] };
}
export function correspondenceFor(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, fixed = true): SourceSemanticCorrespondence {
  const correspondences: SourceSemanticCorrespondence["correspondences"][number][] = [];
  for (const frame of interpretation.frames) {
    correspondences.push({ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
      source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: "use" }, source_semantic_support: [{ kind: "lexical", mentions: ["muses"] }] });
    for (const slot of ["agent", "theme"]) correspondences.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot }, source_endpoint: { kind: "slot", frame: frame.id, slot },
      query_support: { kind: "query_text", excerpt: slot === "agent" ? fixed ? "Alice" : "who" : "tools" }, source_semantic_support: [] });
  }
  if (fixed) correspondences.push({ relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
    source_endpoint: { kind: "referent", referent: "rAlice" }, query_support: { kind: "query_text", excerpt: "Alice" },
    source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] });
  return { contract: "source-semantic-correspondence-v3", source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, sha), query_semantics_id: sourceSemanticQueryIdentity(semantics, sha),
    producer_id: CORRESPONDENCE_PRODUCER, producer_version: "1", contract_version: "source-semantic-correspondence-v3", correspondences };
}
export function run(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, correspondence: SourceSemanticCorrespondence, original = ORIGINAL,
  budget = BUDGET, output = 1000000) {
  const result = reasonSourceSemanticInterpretation({
    source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
    workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
    request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: correspondence.source_interpretation_id, query_semantics_id: correspondence.query_semantics_id, semantic_correspondence_id: correspondenceId(correspondence), original_query: original, budget, output_byte_limit: output } });
  if (result.outcome.status === "interpreted") {
    const oracle = oracleSourceSemanticJoin(interpretation, semantics, correspondence);
    expect(oracleBindingsMatchEngine(oracle, decodeEngineBindings(result), semantics.variables.map((row) => row.id))).toBe(true);
    expect(oracleProofsMatchEngine(oracle, result)).toBe(true);
  }
  return result;
}
import { sourceSemanticCorrespondenceIdentity } from "@do-soul/alaya-protocol";
function correspondenceId(correspondence: SourceSemanticCorrespondence) { return sourceSemanticCorrespondenceIdentity(correspondence, sha); }

export function deliveredProofFixture(input: { interpretation?: SourceSemanticInterpretation; semantics?: SourceSemanticQuery;
  correspondence?: SourceSemanticCorrespondence; original?: string; library?: boolean; budget?: RequestBudget; workspaceId?: string } = {}) {
  const interpretation = input.interpretation ?? source(), semantics = input.semantics ?? query();
  const correspondence = input.correspondence ?? correspondenceFor(interpretation, semantics), original = input.original ?? ORIGINAL;
  const { source_id, source_version, content_digest } = interpretation.source;
  const identity = hashSourceRecordId(interpretation.source, sha);
  const record = SourceRecordIdentitySchema.parse({ ...fieldReceiptContractFields({ identity,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID, consumer: "projection_generation" }), schema_version: 1,
    workspace_id: input.workspaceId ?? "ws", source_id, source_version, content_digest,
    attribution_context: interpretation.source.attribution_context,
    evidence_object_id: null, recorded_at: CLOCK,
    event_time: null, valid_from: null, valid_to: null, scope_class: "project", operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID });
  const target = sourceRecallTarget({ workspace_id: record.workspace_id, root_kind: "source_record", root_id: record.identity,
    source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id });
  const admitted = admitSourceSemanticCorrespondence({ source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: original });
  if (admitted.kind !== "admitted") throw new Error("fixture correspondence must be admitted");
  const executed = executeSourceSemanticInterpretation({ source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: original, workspaceId: input.workspaceId ?? "ws", scope: "project",
    authorizedScopes: ["project"], asOf: CLOCK, source_target: target, sourceValidity: record,
    request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: admitted.interpretation_id, query_semantics_id: admitted.query_id,
      semantic_correspondence_id: admitted.semantic_correspondence_id, original_query: original,
      budget: input.budget ?? SOURCE_SEMANTIC_REASONING_BUDGET, output_byte_limit: 1_000_000 } });
  if (executed.index === null) throw new Error("fixture must produce native proof");
  const delivered = input.library ? scopeSourceSemanticLibraryBranch(executed.index, executed.result) : { ...executed, index: executed.index };
  const proof: SourceSemanticLibraryProof = { ...delivered.result, original_query: original, interpretation,
    query: semantics, semantic_correspondence: correspondence, context: admitted.context, source_record: record };
  const index = { ...delivered.index, query_id: sourceSemanticLibraryQueryIdentity(original),
    ...(input.library ? { result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION } : {}) };
  const qualifiers = slotQualifiersFor(index, [proof]);
  const offset = qualifiers.findIndex((row) => row.evidence_kind === "semantic_proof");
  if (offset < 0) throw new Error(`fixture must deliver a proof slot: ${JSON.stringify({ outcome: proof.outcome,
    bindings: proof.binding_results, usage: proof.resource_usage, entries: index.entries.length, completeness: proof.completeness })}`);
  return { record, target, proof, index, entry: index.entries[offset]!, qualifier: qualifiers[offset]!,
    source_dependencies: executed.source_dependencies ?? [] };
}
