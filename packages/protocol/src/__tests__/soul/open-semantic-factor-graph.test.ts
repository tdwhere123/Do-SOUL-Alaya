import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  OpenSemanticFactorGraphProposalSchema,
  openSemanticFactorFormationCapturePreimage,
  groundOpenSemanticFactorGraph,
  verifyOpenSemanticFactorFormationCapture
} from "../../soul/open-semantic-factor-graph.js";

describe("open semantic factor graph", () => {
  it("grounds open factors and preserves open proposition bindings", () => {
    const source = "I bought three used books in July.";
    const graph = groundOpenSemanticFactorGraph({
      schema_version: 1,
      source_kind: "evidence",
      factors: [
        factor("actor", "I", 0, 1),
        factor("predicate", "bought", 2, 8, "buy"),
        factor("purchase", "three used books", 9, 25),
        factor("period", "July", 29, 33)
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "purchase-event",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "factor", "actor"),
          argument(1, "factor", "purchase"),
          argument(2, "factor", "period")
        ]
      }]
    }, source);

    expect(graph).not.toBeNull();
    expect(graph?.propositions[0]?.arguments).toEqual([
      argument(0, "factor", "actor"),
      argument(1, "factor", "purchase"),
      argument(2, "factor", "period")
    ]);
    expect("role" in graph!.factors[0]!).toBe(false);
    expect(graph?.factors.find(({ factor_id }) => factor_id === "predicate"))
      .toMatchObject({ surface: "bought", semantic_identity: "buy" });
  });

  it("represents a query unknown as a structural variable without an answer ontology", () => {
    const source = "What did I buy?";
    const graph = groundOpenSemanticFactorGraph({
      schema_version: 1,
      source_kind: "query",
      factors: [
        factor("actor", "I", 9, 10),
        factor("predicate", "buy", 11, 14)
      ],
      variables: [{
        variable_id: "answer",
        surface: "What"
      }],
      result_variable_ids: ["answer"],
      propositions: [{
        proposition_id: "purchase-query",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "factor", "actor"),
          argument(1, "variable", "answer")
        ]
      }]
    }, source);

    expect(graph?.variables).toEqual([{
      variable_id: "answer",
      surface: "What",
      source_span: [0, 4]
    }]);
  });

  it("rejects ungrounded, dangling, and evidence-variable graphs", () => {
    const evidence = {
      schema_version: 1 as const,
      source_kind: "evidence" as const,
      factors: [factor("actor", "I", 0, 1), factor("predicate", "use", 2, 5)],
      variables: [{ variable_id: "missing", surface: "Atlas" }],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "use-event",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "factor", "actor"),
          argument(1, "variable", "missing")
        ]
      }]
    };
    expect(groundOpenSemanticFactorGraph(evidence, "I use Atlas.")).toBeNull();
    expect(groundOpenSemanticFactorGraph({
      ...evidence,
      variables: [],
      result_variable_ids: [],
      propositions: [{
        ...evidence.propositions[0],
        arguments: [argument(0, "factor", "unknown")]
      }]
    }, "I use Atlas.")).toBeNull();
    expect(groundOpenSemanticFactorGraph({
      ...evidence,
      variables: [],
      factors: [factor("actor", "You", 0, 1), factor("predicate", "use", 2, 5)],
      propositions: [{
        ...evidence.propositions[0],
        arguments: [argument(0, "factor", "actor")]
      }]
    }, "I use Atlas.")).toBeNull();
    expect(groundOpenSemanticFactorGraph({
      ...evidence,
      source_kind: "query",
      result_variable_ids: ["unknown"]
    }, "I use Atlas.")).toBeNull();
  });

  it("rejects every emitted factor or variable that propositions do not use", () => {
    const query = {
      schema_version: 1 as const,
      source_kind: "query" as const,
      factors: [factor("predicate", "give", 4, 8), factor("participant", "A", 9, 10)],
      variables: [{ variable_id: "answer", surface: "Who" }],
      result_variable_ids: ["answer"],
      propositions: [{
        proposition_id: "give-query",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "factor", "participant"),
          argument(1, "variable", "answer")
        ]
      }]
    };

    expect(OpenSemanticFactorGraphProposalSchema.safeParse({
      ...query,
      factors: [...query.factors, factor("unused", "extra", 11, 16)]
    }).success).toBe(false);
    expect(OpenSemanticFactorGraphProposalSchema.safeParse({
      ...query,
      variables: [...query.variables, { variable_id: "unused", surface: "other" }]
    }).success).toBe(false);
  });

  it("uses position to distinguish parallel arguments with one open binding identity", () => {
    const graph = groundOpenSemanticFactorGraph({
      schema_version: 1,
      source_kind: "evidence",
      variables: [],
      result_variable_ids: [],
      factors: [
        factor("actor", "I", 0, 1),
        factor("predicate", "use", 2, 5),
        factor("first-object", "Atlas", 6, 11),
        factor("second-object", "Gaia", 16, 20)
      ],
      propositions: [{
        proposition_id: "use-event",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "factor", "actor", "agent"),
          argument(1, "factor", "first-object", "object"),
          argument(2, "factor", "second-object", "object")
        ]
      }]
    }, "I use Atlas and Gaia.");

    expect(graph?.propositions[0]?.arguments.map((item) => [
      item.position,
      item.binding_identity,
      item.reference_id
    ])).toEqual([
      [0, "agent", "actor"],
      [1, "object", "first-object"],
      [2, "object", "second-object"]
    ]);
  });

  it("requires graph nodes to own distinct exact source occurrences", () => {
    expect(groundOpenSemanticFactorGraph({
      schema_version: 1,
      source_kind: "evidence",
      factors: [
        factor("actor", "I", 0, 1),
        factor("actor-copy", "I", 0, 1),
        factor("predicate", "use", 2, 5)
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "use-event",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "factor", "actor", "agent"),
          argument(1, "factor", "actor-copy", "co-agent")
        ]
      }]
    }, "I use Atlas.")).toBeNull();
  });

  it("binds formation capture identity to producer, source, and graph", () => {
    const graph = groundOpenSemanticFactorGraph({
      schema_version: 1,
      source_kind: "evidence",
      factors: [factor("actor", "I", 0, 1), factor("predicate", "work", 2, 6)],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "work-event",
        predicate_factor_id: "predicate",
        arguments: [argument(0, "factor", "actor")]
      }]
    }, "I work.")!;
    const body = {
      schema_version: 1 as const,
      operator_id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
      status: "formed" as const,
      producer_operator_id: "open-factor-test-producer-v1",
      source_sha256: `sha256:${sha256("I work.")}`,
      graph
    };
    const capture = {
      ...body,
      capture_digest: `sha256:${sha256(
        openSemanticFactorFormationCapturePreimage(body)
      )}`
    };

    expect(verifyOpenSemanticFactorFormationCapture(capture, sha256)).toEqual(capture);
    expect(() => verifyOpenSemanticFactorFormationCapture({
      ...capture,
      producer_operator_id: "other-producer"
    }, sha256)).toThrow(/digest mismatch/u);
  });
});

function factor(
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

function argument(
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
