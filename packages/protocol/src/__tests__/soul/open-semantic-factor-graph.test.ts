import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  OpenSemanticFactorFormationCaptureSchema,
  OpenSemanticFactorGraphProposalSchema,
  type OpenSemanticFactorFormationCaptureBody,
  openSemanticFactorFormationCapturePreimage,
  groundOpenSemanticFactorGraph,
  verifyOpenSemanticFactorFormationCapture
} from "../../soul/open-semantic-factor-graph.js";

describe("open semantic factor graph", () => {
  it("grounds open factors and preserves open proposition bindings", () => {
    const source = "I bought three used books in July.";
    const graph = groundOpenSemanticFactorGraph({
      schema_version: 2,
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
      schema_version: 2,
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
      schema_version: 2 as const,
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
      schema_version: 2 as const,
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
      schema_version: 2,
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
      schema_version: 2,
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

  it("rejects factor, variable, and cross-kind source-span overlap", () => {
    expect(groundOpenSemanticFactorGraph(overlapGraph(
      [factor("whole", "New York", 0, 8), factor("part", "York", 4, 8)],
      []
    ), "New York")).toBeNull();
    expect(groundOpenSemanticFactorGraph(overlapGraph(
      [factor("predicate", "ask", 0, 3)],
      [variable("whole", "What degree"), variable("part", "degree")]
    ), "ask What degree")).toBeNull();
    expect(groundOpenSemanticFactorGraph(overlapGraph(
      [factor("predicate", "degree", 5, 11)],
      [variable("answer", "What degree")]
    ), "What degree")).toBeNull();
  });

  it("allows adjacent spans and separate occurrences of the same surface", () => {
    expect(groundOpenSemanticFactorGraph(overlapGraph(
      [factor("predicate", "A", 0, 1), factor("adjacent", "B", 1, 2)],
      []
    ), "AB")).not.toBeNull();
    expect(groundOpenSemanticFactorGraph({
      ...overlapGraph([
        factor("predicate", "gives", 2, 7),
        factor("first", "A", 0, 1),
        { ...factor("second", "A", 8, 9), source_occurrence: 1 }
      ], []),
      propositions: [{
        proposition_id: "separate-occurrences",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "factor", "first"),
          argument(1, "factor", "second")
        ]
      }]
    }, "A gives A")).not.toBeNull();
  });

  it("rejects legacy v1 graphs and formation captures", () => {
    expect(OpenSemanticFactorGraphProposalSchema.safeParse({
      ...overlapGraph(
        [factor("predicate", "A", 0, 1), factor("argument", "B", 1, 2)],
        []
      ),
      schema_version: 1
    }).success).toBe(false);
    expect(OpenSemanticFactorFormationCaptureSchema.safeParse(
      legacyV1Capture()
    ).success).toBe(false);
  });

  it("binds formation capture identity to producer, source, and graph", () => {
    const graph = groundOpenSemanticFactorGraph({
      schema_version: 2,
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

function variable(variableId: string, surface: string) {
  return { variable_id: variableId, surface };
}

function legacyV1Capture() {
  const body = {
    schema_version: 1,
    operator_id: "open_semantic_factor_formation_v1",
    status: "formed",
    producer_operator_id: "legacy-producer-v1",
    source_sha256: `sha256:${"1".repeat(64)}`,
    graph: {
      schema_version: 1,
      source_kind: "evidence",
      factors: [{
        factor_id: "predicate",
        surface: "A",
        source_span: [0, 1],
        semantic_identity: "a"
      }],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "legacy",
        predicate_factor_id: "predicate",
        arguments: [argument(0, "factor", "predicate")]
      }]
    }
  };
  const preimage = openSemanticFactorFormationCapturePreimage(
    body as unknown as OpenSemanticFactorFormationCaptureBody
  );
  return { ...body, capture_digest: `sha256:${sha256(preimage)}` };
}

function overlapGraph(factors: ReturnType<typeof factor>[], variables: ReturnType<typeof variable>[]) {
  const references = [
    ...factors.slice(1).map(({ factor_id }) => ["factor", factor_id] as const),
    ...variables.map(({ variable_id }) => ["variable", variable_id] as const)
  ];
  return {
    schema_version: 2 as const,
    source_kind: (variables.length === 0 ? "evidence" : "query") as "evidence" | "query",
    factors,
    variables,
    result_variable_ids: variables.map(({ variable_id }) => variable_id),
    propositions: [{
      proposition_id: "overlap",
      predicate_factor_id: factors[0]!.factor_id,
      arguments: references.map(([kind, id], position) =>
        argument(position, kind, id))
    }]
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
