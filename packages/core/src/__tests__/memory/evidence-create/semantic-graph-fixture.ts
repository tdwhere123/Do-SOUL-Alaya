export function binaryUseEvidenceSemanticGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [
      { factor_id: "actor", surface: "I", source_occurrence: 0, semantic_identity: "speaker" },
      { factor_id: "predicate", surface: "used", source_occurrence: 0, semantic_identity: "use" },
      { factor_id: "object", surface: "Atlas", source_occurrence: 0, semantic_identity: "atlas" }
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        { position: 0, binding_identity: "agent", reference_kind: "factor" as const, reference_id: "actor" },
        { position: 1, binding_identity: "object", reference_kind: "factor" as const, reference_id: "object" }
      ]
    }]
  };
}
