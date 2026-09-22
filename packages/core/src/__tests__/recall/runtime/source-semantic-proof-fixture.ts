import { expect } from "vitest";
import { oracleSourceSemanticJoin, decodeEngineBindings, oracleBindingsMatchEngine, oracleProofsMatchEngine } from "./source-semantic-relational-oracle.js";
import { SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, sourceSemanticInterpretationIdentity,
  sourceSemanticQueryIdentity, type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticCorrespondence } from "@do-soul/alaya-protocol";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";
import { SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID as QP } from "../../../recall/conditional-field/query/source-semantic-query-producer-registry.js";
import { SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID as AP } from "../../../recall/conditional-field/query/source-semantic-correspondence-producer-registry.js";
import { reasonSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";

export const ORIGINAL = "which tools does Alice use?";
export const CLOCK = "2026-09-18T00:00:00.000Z";
export const BUDGET = { schema_version: 1 as const, work_units: 1000000, memory_bytes: 60000000,
  page_budget: 10000, finalization_reserve: 50000, min_envelope: 10 };
export function source(): SourceSemanticInterpretation {
  const names = ["Alice", "Bob", "X", "Y", "uses"];
  return { contract: "source-interpretation-v4", k_version: SOURCE_SEMANTIC_K_VERSION, normalizer_version: SOURCE_SEMANTIC_NORMALIZER_VERSION,
    source: { source_id: "two-users", source_version: "1", content_digest: `sha256:${sha("Alice uses X. Bob uses Y.")}` },
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
    source: { source_id: "offer-catalog", source_version: "1", content_digest: `sha256:${sha(names.join(" "))}` },
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
  return { contract: "source-semantic-query-v2", original_query_digest: `sha256:${sha(original)}`,
    producer_id: QP, producer_version: "1", contract_version: "source-semantic-query-v2",
    variables: [{ id: "actor", sort: "entity", ...(fixed ? { reference: { kind: "query_text" as const, excerpt: "Alice" } } : {}) },
      { id: "tools", sort: "entity" }, { id: "use", sort: "proposition" }],
    alternatives: [{ frames: [{ id: "qUse", variable: "use", predicate_reading: "use",
      role_requirements: [{ id: "agent", role_reading: "agent", target_variable: "actor", support: { kind: "query_text", excerpt: fixed ? "Alice" : "who" } },
        { id: "theme", role_reading: "theme", target_variable: "tools", support: { kind: "query_text", excerpt: "tools" } }] }],
      context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }] }], return_variables: ["tools"], gaps: [] };
}
export function align(h: SourceSemanticInterpretation, q: SourceSemanticQuery, fixed = true): SourceSemanticCorrespondence {
  const correspondences: SourceSemanticCorrespondence["correspondences"][number][] = [];
  for (const frame of h.frames) {
    correspondences.push({ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "qUse" },
      source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: "use" }, source_semantic_support: [{ kind: "lexical", mentions: ["muses"] }] });
    for (const slot of ["agent", "theme"]) correspondences.push({ relation: "contextual_equivalence",
      query_endpoint: { kind: "slot", alternative: 0, frame: "qUse", slot }, source_endpoint: { kind: "slot", frame: frame.id, slot },
      query_support: { kind: "query_text", excerpt: slot === "agent" ? fixed ? "Alice" : "who" : "tools" }, source_semantic_support: [] });
  }
  if (fixed) correspondences.push({ relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: "actor" },
    source_endpoint: { kind: "referent", referent: "rAlice" }, query_support: { kind: "query_text", excerpt: "Alice" },
    source_semantic_support: [{ kind: "lexical", mentions: ["mAlice"] }] });
  return { contract: "source-semantic-correspondence-v3", source_interpretation_id: sourceSemanticInterpretationIdentity(h, sha), query_semantics_id: sourceSemanticQueryIdentity(q, sha),
    producer_id: AP, producer_version: "1", contract_version: "source-semantic-correspondence-v3", correspondences };
}
export function run(h: SourceSemanticInterpretation, q: SourceSemanticQuery, a: SourceSemanticCorrespondence, original = ORIGINAL,
  budget = BUDGET, output = 1000000) {
  const result = reasonSourceSemanticInterpretation({
    source_interpretation: h, query_semantics: q, semantic_correspondence: a,
    workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
    request: { contract: "source-interpretation-reasoning-v4", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: a.source_interpretation_id, query_semantics_id: a.query_semantics_id, semantic_correspondence_id: alignmentId(a), original_query: original, budget, output_byte_limit: output } });
  if (result.outcome.status === "interpreted") {
    const oracle = oracleSourceSemanticJoin(h, q, a);
    expect(oracleBindingsMatchEngine(oracle, decodeEngineBindings(result), q.variables.map((row) => row.id))).toBe(true);
    expect(oracleProofsMatchEngine(oracle, result)).toBe(true);
  }
  return result;
}
import { sourceSemanticCorrespondenceIdentity } from "@do-soul/alaya-protocol";
function alignmentId(a: SourceSemanticCorrespondence) { return sourceSemanticCorrespondenceIdentity(a, sha); }
