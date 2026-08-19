import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";

export function evidenceProposal() {
  return {
    schema_version: 1 as const,
    source_kind: "evidence" as const,
    factors: [
      factor("actor", "I", 0, 1),
      factor("predicate", "used", 2, 6, "use"),
      factor("object", "Atlas", 7, 12),
      factor("purpose", "research", 17, 25)
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "factor", "actor"),
        argument(1, "factor", "object", "object"),
        argument(2, "factor", "purpose", "purpose")
      ]
    }]
  };
}

export function queryProposal() {
  return {
    schema_version: 1 as const,
    source_kind: "query" as const,
    factors: [
      factor("query-actor", "I", 8, 9),
      factor("query-predicate", "use", 10, 13),
      factor("query-purpose", "research", 18, 26)
    ],
    variables: [{ variable_id: "answer", surface: "What" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "use-query",
      predicate_factor_id: "query-predicate",
      arguments: [
        argument(0, "factor", "query-actor"),
        argument(1, "variable", "answer", "object"),
        argument(2, "factor", "query-purpose", "purpose")
      ]
    }]
  };
}

export function personEvidence(
  sourceText: string,
  predicateSurface: string,
  valueSurface: string,
  predicateIdentity: string
) {
  const predicateStart = sourceText.indexOf(predicateSurface);
  const valueStart = sourceText.indexOf(valueSurface);
  return materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: sourceText,
    proposal: proposal(sourceText, {
      schema_version: 1,
      source_kind: "evidence",
      factors: [
        factor("person", "Alice", 0, 5, "alice"),
        factor("predicate", predicateSurface, predicateStart,
          predicateStart + predicateSurface.length, predicateIdentity),
        factor("value", valueSurface, valueStart, valueStart + valueSurface.length)
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [semanticProposition("statement", "predicate", ["person", "value"])]
    })
  });
}

export function proposal(sourceText: string, graph: unknown) {
  return {
    schema_version: 1 as const,
    producer_operator_id: "open-factor-test-producer-v1",
    source_text: sourceText,
    graph
  };
}

export function semanticProposition(
  propositionId: string,
  predicateFactorId: string,
  argumentIds: readonly string[]
) {
  return {
    proposition_id: propositionId,
    predicate_factor_id: predicateFactorId,
    arguments: argumentIds.map((referenceId, position) =>
      argument(position, "factor", referenceId))
  };
}

export function semanticQueryProposition(
  propositionId: string,
  predicateFactorId: string,
  valueFactorId: string
) {
  return {
    proposition_id: propositionId,
    predicate_factor_id: predicateFactorId,
    arguments: [
      argument(0, "variable", "person"),
      argument(1, "factor", valueFactorId)
    ]
  };
}

export function factor(
  factorId: string,
  surface: string,
  _start: number,
  _end: number,
  semanticIdentity = surface.toLocaleLowerCase()
) {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
}

export function argument(
  position: number,
  referenceKind: "factor" | "variable",
  referenceId: string,
  bindingIdentity = position === 0 ? "agent" : `argument-${position}`
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
