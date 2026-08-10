import { describe, expect, it, vi } from "vitest";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
  createOpenSemanticFactorQueryCompiler,
  parseOpenSemanticFactorQueryResponse
} from "../../../garden/semantic-factors/query-compiler.js";

const QUERY = "What did I buy?";

describe("open semantic factor query compiler", () => {
  it("compiles a grounded query proposal in the same graph schema", async () => {
    const extractor = {
      extract: vi.fn().mockResolvedValue({
        rawJson: JSON.stringify({ semantic_factor_graph: queryGraph() })
      })
    };
    const compiler = createOpenSemanticFactorQueryCompiler({ extractor });

    await expect(compiler.compile(QUERY)).resolves.toMatchObject(queryGraph());
    expect(compiler.operator_id).toBe(OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID);
    expect(extractor.extract).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({
        schema_version: 1,
        source_kind: "query",
        source_text: QUERY
      }),
      responseSchemaRetryInstruction: expect.stringContaining("semantic_factor_graph"),
      validateRawJson: expect.any(Function)
    }));
    const request = extractor.extract.mock.calls[0]?.[0];
    const completeEnvelope =
      '"schema_version":1,"source_kind":"query","factors":[...],"variables":[...],"result_variable_ids":[...],"propositions":[...]';
    const variableShape =
      '"variable_id":LOCAL_ID,"surface":EXACT_SUBSTRING';
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(completeEnvelope);
    expect(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT).toContain(variableShape);
    expect(request?.responseSchemaRetryInstruction).toContain(completeEnvelope);
    expect(request?.responseSchemaRetryInstruction).toContain(variableShape);
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
    await expect(compiler.compile(QUERY)).resolves.toBeNull();
  });
});

function queryGraph() {
  return {
    schema_version: 1 as const,
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
