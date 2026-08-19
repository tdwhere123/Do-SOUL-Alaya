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
    expect(compiler.operator_id).toBe("open_semantic_factor_query_compiler_v6");
    expect(extractor.extract).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        schema_version: 3,
        source_kind: "query",
        source_text: QUERY,
        semantic_completeness_obligation: QUERY_OBLIGATION
      }),
      responseSchemaRetryInstruction: expect.stringContaining("semantic_factor_graph"),
      validateRawJson: expect.any(Function)
    }));
    const request = extractor.extract.mock.calls[0]?.[0];
    const completeEnvelope =
      '"schema_version":2,"source_kind":"query","factors":[...],"variables":[...],"result_variable_ids":[...],"propositions":[...]';
    const variableShape =
      '"variable_id":LOCAL_ID,"surface":EXACT_SUBSTRING';
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(completeEnvelope);
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(variableShape);
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
      "Preserve each predicate's semantic argument order"
    );
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
      "binding names need not match source evidence graphs"
    );
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
      "Place every WH phrase or other requested unknown"
    );
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
      "exact predicate argument position it asks for"
    );
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
      "Keep every explicit non-WH participant or constraint"
    );
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
      "belongs exclusively to one variable"
    );
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
      "any substring inside its surface"
    );
    expect(request?.responseSchemaRetryInstruction).toContain(
      "Preserve each predicate's semantic argument order"
    );
    expect(request?.responseSchemaRetryInstruction).toContain(
      "Place every WH phrase or other requested unknown"
    );
    expect(request?.responseSchemaRetryInstruction).toContain(completeEnvelope);
    expect(request?.responseSchemaRetryInstruction).toContain(variableShape);
    const template = JSON.parse(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE) as {
      semantic_completeness_obligation: Record<string, unknown>;
    };
    expect(template).toMatchObject({
      schema_version: 3, source_kind: "query", source_text: "What did A give?",
      semantic_completeness_obligation: {
        operator_id: "query_fact_frame_osf_obligation_v1",
        subject: { surface: "A", position: 0 },
        value: { surface: "What", position: 1 },
        arity: 2
      }
    });
    expect(digest(JSON.stringify(template))).not.toBe(digest(JSON.stringify({
      ...template,
      semantic_completeness_obligation: {
        ...template.semantic_completeness_obligation,
        arity: 3
      }
    })));
    expect(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE).not.toBe(JSON.stringify({
      schema_version: 1,
      source_kind: "query",
      source_text: "{source_text}"
    }));
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(
      '"predicate_factor_id":"predicate","arguments":[{"position":0,"binding_identity":"giver","reference_kind":"factor","reference_id":"participant"},{"position":1,"binding_identity":"recipient","reference_kind":"variable","reference_id":"answer"}]'
    );
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).not.toContain(
      '"arguments":[{"position":0,"binding_identity":"item","reference_kind":"variable","reference_id":"answer"}]'
    );
    expect(() => request?.validateRawJson?.(
      JSON.stringify({ semantic_factor_graph: queryGraph() })
    )).not.toThrow();
    expect(() => request?.validateRawJson?.('{"signals":[]}'))
      .toThrow(/query semantic factor graph missing or invalid/u);
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

  it("lets schema retry replace the unary G6 graph with the corrected graph", async () => {
    const goodRaw = JSON.stringify({ semantic_factor_graph: g5CorrectedQueryGraph() });
    const extractor = {
      extract: vi.fn(async (input: Parameters<SignalExtractor["extract"]>[0]) => {
        expect(() => input.validateRawJson?.(JSON.stringify({
          semantic_factor_graph: g6UnaryQueryGraph()
        }))).toThrow(/query semantic factor graph missing or invalid/u);
        expect(() => input.validateRawJson?.(goodRaw)).not.toThrow();
        return { rawJson: goodRaw };
      })
    };
    const compiler = createOpenSemanticFactorQueryCompiler({ extractor });

    await expect(compiler.compile("What degree did I graduate with?", g5QueryObligation()))
      .resolves.toMatchObject({ graph: g5CorrectedQueryGraph() });
  });
});

function responseExtractor(graph: unknown) {
  return {
    extract: vi.fn().mockResolvedValue({
      rawJson: JSON.stringify({ semantic_factor_graph: graph })
    })
  };
}

function g6UnaryQueryGraph() {
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [factor("predicate", "graduate", "graduate")],
    variables: [{ variable_id: "answer", surface: "What degree" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "graduation-query",
      predicate_factor_id: "predicate",
      arguments: [argument(0, "variable", "answer", "credential")]
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
  predicateSpan: readonly [number, number],
  subject: string,
  subjectSpan: readonly [number, number],
  value: string,
  valueSpan: readonly [number, number]
): QueryFactFrameOsfObligation {
  const body = {
    schema_version: 1 as const,
    operator_id: QUERY_FACT_FRAME_OSF_OBLIGATION_OPERATOR_ID,
    query_digest: digest(query),
    fact_frame_producer_operator_id: "rule_based_query_fact_frame_extractor_v1",
    fact_frame_capture_digest: digest(`capture:${query}`),
    predicate: { surface: predicate, source_span: predicateSpan, position: 0 },
    subject: { surface: subject, source_span: subjectSpan, position: 0 },
    value: { surface: value, source_span: valueSpan, position: 1 },
    arity: 2 as const
  };
  return { ...body, obligation_digest: digest(queryFactFrameOsfObligationPreimage(body)) };
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
