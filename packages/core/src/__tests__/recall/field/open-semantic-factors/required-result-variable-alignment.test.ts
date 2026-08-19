import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";
import { materializeOpenSemanticFactorActivation } from
  "../../../../recall/field/open-semantic-factors/activation.js";

describe("open semantic required result-variable alignment", () => {
  it("binds a what-answer only from its position-preserving relation slot", () => {
    const result = evaluate(
      evidence("I graduated with a BA degree.", [
        factor("predicate", "graduated", "graduate"),
        factor("person", "I", "i"),
        factor("degree", "BA degree", "ba degree")
      ], [
        argument(0, "person", "factor", "person"),
        argument(1, "credential", "factor", "degree")
      ]),
      query("What degree did I graduate with?", [
        factor("predicate", "graduate", "graduate"),
        factor("person", "I", "i")
      ], [
        argument(0, "agent", "factor", "person"),
        argument(1, "obtained", "variable", "answer")
      ], "What degree")
    );

    expect(result.trace.entries[0]?.receipt).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
    expect(result.composition).toMatchObject({
      status: "composed",
      solution_count: 1,
      solutions: [{ result_bindings: [{
        variable_id: "answer",
        semantic_identity: "ba degree"
      }] }]
    });
    expect(result.activation).toMatchObject({
      status: "composed",
      entries: [{ evidence_id: "gold" }]
    });
  });
});

describe("open semantic result-variable role authority", () => {
  it("rejects a who graph whose variable occupies the what slot", () => {
    const result = evaluate(
      evidence("I graduated with a BA degree.", [
        factor("predicate", "graduated", "graduate"),
        factor("person", "I", "i"),
        factor("degree", "BA degree", "ba degree")
      ], [
        argument(0, "person", "factor", "person"),
        argument(1, "credential", "factor", "degree")
      ]),
      query("Who graduated with my BA degree?", [
        factor("predicate", "graduated", "graduate"),
        factor("person", "my", "i")
      ], [
        argument(0, "credential", "variable", "answer"),
        argument(1, "agent", "factor", "person")
      ], "Who")
    );

    expectNoMatch(result);
  });
});

describe("open semantic result-variable arity", () => {
  it("rejects unary evidence for a binary query result slot", () => {
    const result = evaluate(
      evidence("I graduated.", [
        factor("predicate", "graduated", "graduate"),
        factor("person", "I", "i")
      ], [argument(0, "person", "factor", "person")]),
      query("What degree did I graduate with?", [
        factor("predicate", "graduate", "graduate"),
        factor("person", "I", "i")
      ], [
        argument(0, "agent", "factor", "person"),
        argument(1, "credential", "variable", "answer")
      ], "What degree")
    );

    expectNoMatch(result);
  });
});

describe("open semantic observed unary evidence", () => {
  it("keeps the observed unary degree graph incompatible with a who query", () => {
    const result = evaluate(
      evidence("Graduated with a BA degree.", [
        factor("predicate", "Graduated", "graduate"),
        factor("degree", "BA degree", "ba degree")
      ], [argument(0, "credential", "factor", "degree")]),
      query("Who graduated with a BA degree?", [
        factor("predicate", "graduated", "graduate"),
        factor("degree", "BA degree", "ba degree")
      ], [
        argument(0, "agent", "variable", "answer"),
        argument(1, "credential", "factor", "degree")
      ], "Who")
    );

    expectNoMatch(result);
  });
});

function expectNoMatch(result: ReturnType<typeof evaluate>): void {
  expect(result.trace.entries[0]?.receipt).toMatchObject({
    status: "incompatible",
    matched_query_proposition_count: 0
  });
  expect(result.composition).toMatchObject({ status: "no_match", solution_count: 0 });
  expect(result.activation).toMatchObject({ status: "no_match", entries: [] });
}

function evaluate(evidenceCapture: ReturnType<typeof evidence>, queryCapture: ReturnType<typeof query>) {
  const trace = materializeOpenSemanticFactorCompatibilityTrace({
    query_capture: queryCapture,
    evidence_formations: { gold: evidenceCapture }
  });
  const composition = materializeOpenSemanticFactorComposition({
    trace,
    query_capture: queryCapture
  });
  return {
    trace,
    composition,
    activation: materializeOpenSemanticFactorActivation({
      composition,
      trace,
      query_capture: queryCapture
    })
  };
}

function evidence(sourceText: string, factors: unknown[], argumentsValue: unknown[]) {
  return formation("evidence", sourceText, factors, [], [], argumentsValue);
}

function query(
  sourceText: string,
  factors: unknown[],
  argumentsValue: unknown[],
  variableSurface: string
) {
  return formation(
    "query",
    sourceText,
    factors,
    [{ variable_id: "answer", surface: variableSurface }],
    ["answer"],
    argumentsValue
  );
}

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  factors: unknown[],
  variables: unknown[],
  resultVariableIds: string[],
  argumentsValue: unknown[]
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-result-slot-test-v1",
      source_text: sourceText,
      graph: {
        schema_version: 1,
        source_kind: sourceKind,
        factors,
        variables,
        result_variable_ids: resultVariableIds,
        propositions: [{
          proposition_id: "graduation",
          predicate_factor_id: "predicate",
          arguments: argumentsValue
        }]
      }
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
