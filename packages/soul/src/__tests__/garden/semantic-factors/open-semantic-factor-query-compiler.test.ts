import { createHash } from "node:crypto";
import {
  QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
  queryFactFrameOsfObligationPreimage,
  type QueryFactFrameOsfObligation
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import type { SignalExtractor } from "../../../garden/pi-mono-extractor.js";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
  createOpenSemanticFactorQueryCompiler,
  parseOpenSemanticFactorQueryResponse
} from "../../../garden/semantic-factors/query-compiler.js";

const QUERY = "What did I buy?";
const QUERY_OBLIGATION = obligation(QUERY, "buy", [11, 14], "I", [9, 10], "What", [0, 4]);

describe("open semantic factor query compiler", () => {
  it("compiles a grounded query proposal in the same graph schema", async () => {
    const extractor = {
      extract: vi.fn().mockResolvedValue({
        rawJson: JSON.stringify({ semantic_factor_graph: queryGraph() })
      })
    };
    const compiler = createOpenSemanticFactorQueryCompiler({ extractor });

    await expect(compiler.compile(QUERY, QUERY_OBLIGATION)).resolves.toMatchObject({
      graph: queryGraph(), semantic_completeness_receipt: expect.any(Object)
    });
    expect(compiler.operator_id).toBe(OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID);
    expect(compiler.operator_id).toBe("open_semantic_factor_query_compiler_v9");
    const request = extractor.extract.mock.calls[0]?.[0];
    assertCompilerRequest(extractor.extract, request);
    assertPromptContract(request);
    assertRequestTemplateContract();
    assertResponseValidation(request);
  });

  it("fails closed for malformed, wrong-kind, or ungrounded graphs", async () => {
    expect(parseOpenSemanticFactorQueryResponse("not json")).toBeNull();
    expect(parseOpenSemanticFactorQueryResponse(JSON.stringify({
      semantic_factor_graph: { ...queryGraph(), source_kind: "evidence" }
    }))).toBeNull();

    const compiler = createOpenSemanticFactorQueryCompiler({
      extractor: {
        extract: vi.fn().mockResolvedValue({
          rawJson: JSON.stringify({ semantic_factor_graph: {
            ...queryGraph(),
            factors: [
              factor("actor", "I", "speaker"),
              factor("predicate", "purchased", "buy")
            ]
          } })
        })
      }
    });
    await expect(compiler.compile(QUERY, QUERY_OBLIGATION)).resolves.toBeNull();
  });

  it("rejects raw query graphs containing emitted but unbound nodes", () => {
    expect(parseOpenSemanticFactorQueryResponse(JSON.stringify({
      semantic_factor_graph: {
        ...queryGraph(),
        factors: [...queryGraph().factors, factor("unused", "did", "do")]
      }
    }))).toBeNull();
    expect(parseOpenSemanticFactorQueryResponse(JSON.stringify({
      semantic_factor_graph: {
        ...queryGraph(),
        variables: [
          ...queryGraph().variables,
          { variable_id: "unused", surface: "did" }
        ]
      }
    }))).toBeNull();
  });

  it("rejects the observed overlapping G5 query and accepts the corrected relation", async () => {
    const g5Obligation = g5QueryObligation();
    const badCompiler = createOpenSemanticFactorQueryCompiler({
      extractor: responseExtractor(g5OverlappingQueryGraph())
    });
    await expect(badCompiler.compile("What degree did I graduate with?", g5Obligation))
      .resolves.toBeNull();

    const goodCompiler = createOpenSemanticFactorQueryCompiler({
      extractor: responseExtractor(g5CorrectedQueryGraph())
    });
    await expect(goodCompiler.compile("What degree did I graduate with?", g5Obligation))
      .resolves.toMatchObject({ graph: g5CorrectedQueryGraph() });
  });

  it("lets schema retry replace the observed known-subject variable graph", async () => {
    const goodRaw = JSON.stringify({ semantic_factor_graph: g5CorrectedQueryGraph() });
    const extractor = {
      extract: vi.fn(async (input: Parameters<SignalExtractor["extract"]>[0]) => {
        expect(() => input.validateRawJson?.(JSON.stringify({
          semantic_factor_graph: g7KnownSubjectVariableGraph()
        }))).toThrow(/query semantic factor graph missing or invalid/u);
        expect(() => input.validateRawJson?.(goodRaw)).not.toThrow();
        return { rawJson: goodRaw };
      })
    };
    const compiler = createOpenSemanticFactorQueryCompiler({ extractor });

    await expect(compiler.compile("What degree did I graduate with?", g5QueryObligation()))
      .resolves.toMatchObject({ graph: g5CorrectedQueryGraph() });
  });

  it("renders every grounded constraint before the unique result variable", async () => {
    const query = "Where did I redeem a $5 coupon on coffee creamer?";
    const obligation = constrainedObligation(query);
    const extractor = responseExtractor(constrainedGraph());
    const compiler = createOpenSemanticFactorQueryCompiler({ extractor });
    await expect(compiler.compile(query, obligation)).resolves.toMatchObject({
      graph: constrainedGraph()
    });
    const userPrompt = JSON.parse(extractor.extract.mock.calls[0]![0].userPrompt);
    expect(userPrompt.required_graph_layout.arguments).toEqual([
      { position: 0, node_kind: "factor", surface: "I", result: false },
      { position: 1, node_kind: "factor",
        surface: "a $5 coupon on coffee creamer", result: false },
      { position: 2, node_kind: "variable", surface: "Where", result: true,
        binding_identity: "location" }
    ]);
  });
});

type ExtractRequest = Parameters<SignalExtractor["extract"]>[0];

function assertCompilerRequest(
  extract: ReturnType<typeof vi.fn>,
  request: ExtractRequest | undefined
): void {
  expect(extract).toHaveBeenCalledWith(expect.objectContaining({
    systemPrompt: OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({
      schema_version: 5,
      source_kind: "query",
      source_text: QUERY,
      semantic_completeness_obligation: QUERY_OBLIGATION,
      required_graph_layout: {
        schema_version: 1,
        predicate: { node_kind: "factor", surface: "buy" },
        arguments: [
          { position: 0, node_kind: "factor", surface: "I", result: false },
          { position: 1, node_kind: "variable", surface: "What", result: true }
        ],
        arity: 2,
        result_variable_count: 1
      }
    }),
    responseSchemaRetryInstruction: expect.stringContaining("semantic_factor_graph"),
    validateRawJson: expect.any(Function)
  }));
  expect(request).toBeDefined();
}

function assertPromptContract(request: ExtractRequest | undefined): void {
  const completeEnvelope =
    '"schema_version":2,"source_kind":"query","factors":[...],"variables":[...],"result_variable_ids":[...],"propositions":[...]';
  const requiredPhrases = [
    completeEnvelope,
    '"variable_id":LOCAL_ID,"surface":EXACT_SUBSTRING',
    "Preserve each predicate's semantic argument order",
    "binding names need not match source evidence graphs",
    "Place every WH phrase or other requested unknown",
    "exact predicate argument position it asks for",
    "Keep every explicit non-WH participant or constraint",
    "belongs exclusively to one variable",
    "any substring inside its surface",
    "Follow required_graph_layout mechanically",
    "only an entry with result:true may appear in result_variable_ids",
    'When the argument is a duration measure, binding_identity must be "duration"',
    'When it is a location or place participant, binding_identity must be "location"',
    "Other open role names remain allowed"
  ];
  for (const phrase of requiredPhrases) {
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(phrase);
  }
  expect(request?.responseSchemaRetryInstruction).toContain(completeEnvelope);
  expect(request?.responseSchemaRetryInstruction).toContain(
    "Follow required_graph_layout mechanically"
  );
  expect(request?.responseSchemaRetryInstruction).toContain(
    'When the argument is a duration measure, binding_identity must be "duration"'
  );
  expect(request?.responseSchemaRetryInstruction).toContain(
    "Other open role names remain allowed"
  );
  expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).not.toContain(
    "Do not emit world ontology categories, fixed roles"
  );
}

function assertRequestTemplateContract(): void {
  const template = JSON.parse(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE) as {
    semantic_completeness_obligation: Record<string, unknown>;
    required_graph_layout: Record<string, unknown>;
  };
  expect(template).toMatchObject({
    schema_version: 5, source_kind: "query", source_text: "What did A give?",
    semantic_completeness_obligation: {
      operator_id: "query_fact_frame_osf_obligation_v2",
      subject: { surface: "A", position: 0 },
      value: { surface: "What", position: 1 }, constraints: [], arity: 2
    },
    required_graph_layout: {
      schema_version: 1,
      predicate: { node_kind: "factor", surface: "give" },
      arguments: [
        { position: 0, node_kind: "factor", surface: "A", result: false },
        { position: 1, node_kind: "variable", surface: "What", result: true }
      ],
      arity: 2, result_variable_count: 1
    }
  });
  expect(digest(JSON.stringify(template))).not.toBe(digest(JSON.stringify({
    ...template,
    semantic_completeness_obligation: {
      ...template.semantic_completeness_obligation, arity: 3
    }
  })));
}

function assertResponseValidation(request: ExtractRequest | undefined): void {
  expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
    '"predicate_factor_id":"predicate","arguments":[{"position":0,"binding_identity":"giver","reference_kind":"factor","reference_id":"participant"},{"position":1,"binding_identity":"recipient","reference_kind":"variable","reference_id":"answer"}]'
  );
  expect(() => request?.validateRawJson?.(
    JSON.stringify({ semantic_factor_graph: queryGraph() })
  )).not.toThrow();
  expect(() => request?.validateRawJson?.('{"signals":[]}'))
    .toThrow(/query semantic factor graph missing or invalid/u);
}

function responseExtractor(graph: unknown) {
  return {
    extract: vi.fn().mockResolvedValue({
      rawJson: JSON.stringify({ semantic_factor_graph: graph })
    })
  };
}

function g7KnownSubjectVariableGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [factor("predicate", "graduate", "graduate")],
    variables: [
      { variable_id: "answer", surface: "What degree" },
      { variable_id: "subject", surface: "I" }
    ],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "graduation-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "variable", "subject", "agent"),
        argument(1, "variable", "answer", "credential")
      ]
    }]
  };
}

function g5QueryObligation(): QueryFactFrameOsfObligation {
  return obligation(
    "What degree did I graduate with?", "graduate", [18, 26],
    "I", [16, 17], "What degree", [0, 11]
  );
}

function obligation(
  query: string,
  predicate: string,
  predicateSpan: [number, number],
  subject: string,
  subjectSpan: [number, number],
  value: string,
  valueSpan: [number, number]
): QueryFactFrameOsfObligation {
  const body = {
    schema_version: 2 as const,
    operator_id: QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
    query_digest: digest(query),
    fact_frame_producer_operator_id: "rule_based_query_fact_frame_extractor_v2",
    fact_frame_capture_digest: digest(`capture:${query}`),
    predicate: { surface: predicate, source_span: predicateSpan, position: 0 },
    subject: { surface: subject, source_span: subjectSpan, position: 0 },
    value: { surface: value, source_span: valueSpan, position: 1 },
    constraints: [],
    arity: 2 as const
  };
  return { ...body, obligation_digest: digest(queryFactFrameOsfObligationPreimage(body)) };
}

function constrainedObligation(query: string): QueryFactFrameOsfObligation {
  const body = {
    schema_version: 2 as const,
    operator_id: QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
    query_digest: digest(query),
    fact_frame_producer_operator_id: "rule_based_query_fact_frame_extractor_v2",
    fact_frame_capture_digest: digest(`capture:${query}`),
    predicate: { surface: "redeem", source_span: [12, 18] as [number, number], position: 0 },
    subject: { surface: "I", source_span: [10, 11] as [number, number], position: 0 },
    constraints: [
      { surface: "a $5 coupon on coffee creamer",
        source_span: [19, 48] as [number, number], position: 1 }
    ],
    value: { surface: "Where", source_span: [0, 5] as [number, number], position: 2 },
    arity: 3
  };
  return { ...body, obligation_digest: digest(queryFactFrameOsfObligationPreimage(body)) };
}

function constrainedGraph() {
  return {
    schema_version: 2 as const, source_kind: "query" as const,
    factors: [factor("predicate", "redeem", "redeem"), factor("subject", "I", "i"),
      factor("constraint", "a $5 coupon on coffee creamer", "coupon on coffee creamer")],
    variables: [{ variable_id: "answer", surface: "Where" }],
    result_variable_ids: ["answer"],
    propositions: [{ proposition_id: "query", predicate_factor_id: "predicate",
      arguments: [argument(0, "factor", "subject", "agent"),
        argument(1, "factor", "constraint", "constraint"),
        argument(2, "variable", "answer", "location")] }]
  };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function g5OverlappingQueryGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [
      factor("predicate", "graduate", "graduate"),
      factor("degree", "degree", "degree")
    ],
    variables: [{ variable_id: "answer", surface: "What degree" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "graduation-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "variable", "answer", "agent"),
        argument(1, "factor", "degree", "credential")
      ]
    }]
  };
}

function g5CorrectedQueryGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [
      factor("predicate", "graduate", "graduate"),
      factor("participant", "I", "i")
    ],
    variables: [{ variable_id: "answer", surface: "What degree" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "graduation-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "factor", "participant", "agent"),
        argument(1, "variable", "answer", "credential")
      ]
    }]
  };
}

function queryGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [
      factor("actor", "I", "speaker"),
      factor("predicate", "buy", "buy")
    ],
    variables: [{ variable_id: "answer", surface: "What" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "purchase-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "factor", "actor", "agent"),
        argument(1, "variable", "answer", "item")
      ]
    }]
  };
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
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
  bindingIdentity: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
