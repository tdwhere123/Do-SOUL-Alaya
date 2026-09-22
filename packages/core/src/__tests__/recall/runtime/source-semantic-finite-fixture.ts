import { sourceSemanticCorrespondenceIdentity, sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity,
  type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticCorrespondence } from "@do-soul/alaya-protocol";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";
import { reasonSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { source, event, query, correspondenceFor, CLOCK } from "./source-semantic-proof-fixture.js";

export const FINITE_QUERY = "Alice Bob who use tools speed ms lab New registered users";
export function finiteSource(): SourceSemanticInterpretation {
  const interpretation = source(), template = event("fAlice", "rAlice", "rX");
  return { ...interpretation,
    frames: [{ ...template, context_owner: { kind: "operator", operator_handle: "allUsers" },
      bindings: template.bindings.map((row) => row.slot_id === "agent"
        ? { ...row, target: { kind: "bound_variable", quantifier: "allUsers", binder: "person" } } : row) },
    event("fMemberAlice", "rAlice", "rX"), event("fMemberBob", "rBob", "rX")],
    operators: [{ id: "allUsers", operator: "forall", binder: "person", domain: "users", restriction: null,
      content: "fAlice", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [{ kind: "lexical", mentions: ["muses"] }] }],
    domains: [{ id: "users", context: null, support: [{ kind: "lexical", mentions: ["mAlice"] }],
      members: [{ referent: "rAlice", evidence: "fMemberAlice", restrictions: [] },
        { referent: "rBob", evidence: "fMemberBob", restrictions: [] }], exclusions: [],
      closure: { kind: "closed", evidence: "fMemberAlice" } }],
    measurements: ["Alice", "Bob"].map((person) => ({ id: `value${person}`, subject: `r${person}`,
      owner: `fMember${person}`, population: "users", metric: "speed", unit: "ms", context: "lab", value: "2.1",
      support: [{ kind: "lexical" as const, mentions: ["muses"] }] })),
    entry_roots: ["allUsers", "fMemberAlice", "fMemberBob"], asserted_at_scope: ["allUsers", "fMemberAlice", "fMemberBob"] };
}

export function finiteQuery(exhaustive = false): SourceSemanticQuery {
  const semantics = query(FINITE_QUERY, false);
  return { ...semantics, alternatives: semantics.alternatives.map((row) => ({ ...row,
    context_obligations: [{ frame: "qUse", kind: "entailed_at_source" }] })),
    return_variables: exhaustive ? [] : ["actor"],
    ...(exhaustive ? { domains: [{ id: "people", support: { kind: "query_text" as const, excerpt: "users" } }],
      evaluation: { kind: "forall" as const, domain: "people", binder: "actor", local_variables: ["actor", "tools", "use"] } } : {}) };
}

export function finiteCorrespondence(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery): SourceSemanticCorrespondence {
  const correspondence = correspondenceFor(interpretation, semantics, false);
  return { ...correspondence, correspondences: correspondence.correspondences.filter((row) => row.source_endpoint.kind !== "frame"
    && row.source_endpoint.kind !== "slot" || row.source_endpoint.frame === "fAlice"),
    ...(semantics.evaluation === undefined ? {} : { domains: [{ query_domain: "people", source_domain: "users",
      query_support: { kind: "query_text" as const, excerpt: "users" },
      source_semantic_support: [{ kind: "lexical" as const, mentions: ["mAlice"] }] }] }) };
}

export function reasonFinite(interpretation: SourceSemanticInterpretation, semantics = finiteQuery(), correspondence = finiteCorrespondence(interpretation, semantics)) {
  const boundCorrespondence = { ...correspondence, source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, sha), query_semantics_id: sourceSemanticQueryIdentity(semantics, sha) };
  return reasonSourceSemanticInterpretation({ source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: boundCorrespondence, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
    request: { contract: "source-interpretation-reasoning-v4", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: boundCorrespondence.source_interpretation_id, query_semantics_id: boundCorrespondence.query_semantics_id, semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(boundCorrespondence, sha), original_query: FINITE_QUERY,
      budget: { schema_version: 1, work_units: 10000000, memory_bytes: 60000000,
        page_budget: 10000, finalization_reserve: 50000, min_envelope: 10 }, output_byte_limit: 1000000 } });
}
