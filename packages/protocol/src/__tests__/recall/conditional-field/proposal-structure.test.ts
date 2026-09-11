import { describe, expect, it } from "vitest";
import {
  QUERY_PROPOSAL_MAX_AST_DEPTH,
  QUERY_PROPOSAL_MAX_AST_NODES,
  QueryInterpretationProposalSchema,
  QueryProgramSchema,
  inspectQueryProposalStructure
} from "../../../recall/conditional-field/index.js";
import { SoulMemorySearchRequestSchema } from "../../../surfaces/mcp-memory-search-types.js";
import { soulToolJsonSchemas } from "../../../surfaces/mcp-types.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("query proposal structural budget", () => {
  it("rejects a skinny extreme-depth program before QueryProgram decode", () => {
    const deep = nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH);
    const over = nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH + 1);
    expect(inspectQueryProposalStructure(proposal(over)).kind).toBe("reject");
    expect(QueryInterpretationProposalSchema.safeParse(proposal(over)).success).toBe(false);
    expect(SoulMemorySearchRequestSchema.safeParse(mcpRequest(over)).success).toBe(false);
    expect(QueryInterpretationProposalSchema.safeParse(proposal(deep)).success).toBe(true);
    expect(QueryProgramSchema.safeParse(deep).success).toBe(true);
  });

  it("rejects a moderate-depth program that exceeds the node cap and admits the cap", () => {
    const atLimit = bushyProgram(QUERY_PROPOSAL_MAX_AST_NODES);
    const over = bushyProgram(QUERY_PROPOSAL_MAX_AST_NODES + 1);
    expect(inspectQueryProposalStructure(proposal(atLimit)).kind).toBe("ok");
    expect(QueryInterpretationProposalSchema.safeParse(proposal(atLimit)).success).toBe(true);
    expect(inspectQueryProposalStructure(proposal(over)).kind).toBe("reject");
    expect(QueryInterpretationProposalSchema.safeParse(proposal(over)).success).toBe(false);
    expect(SoulMemorySearchRequestSchema.safeParse(mcpRequest(over)).success).toBe(false);
  });

  it("rejects a client verdict on a proposed guard and omits producer_version as 1", () => {
    expect(QueryInterpretationProposalSchema.safeParse({
      ...proposal({ schema_version: 1, kind: "epsilon" }),
      conditions: [{ schema_version: 1, kind: "authorization", verdict: "true" }]
    }).success).toBe(false);
    const parsed = QueryInterpretationProposalSchema.parse(proposal({ schema_version: 1, kind: "epsilon" }));
    expect(parsed.producer_version).toBeUndefined();
  });

  it("advertises producer_id and ProposedGuard without verdict on the MCP catalog", () => {
    const properties = soulToolJsonSchemas["soul.recall"]?.properties as
      | Readonly<Record<string, unknown>>
      | undefined;
    const advertised = properties?.interpretation_proposal;
    expect(advertised).toEqual(expect.objectContaining({ type: "object" }));
    const encoded = JSON.stringify(advertised);
    expect(encoded).toContain("\"producer_id\"");
    expect(encoded).toContain("\"input_limits\"");
    expect(encoded).not.toContain("\"verdict\"");
  });
});

function proposal(program: unknown) {
  return {
    schema_version: 1,
    original_query_digest: DIGEST,
    producer_id: "compiler.ordinary.v1",
    program
  };
}

function mcpRequest(program: unknown) {
  return {
    query: "needle",
    scope_class: null,
    dimension: null,
    domain_tags: null,
    max_results: 5,
    interpretation_proposal: proposal(program)
  };
}

function nestedClosures(depth: number): unknown {
  let node: unknown = { schema_version: 1, kind: "epsilon" };
  for (let index = 1; index < depth; index += 1) {
    node = {
      schema_version: 1,
      kind: "closure",
      product_state_sufficient: true,
      body: node
    };
  }
  return node;
}

function bushyProgram(nodes: number): unknown {
  if (nodes <= 1) return { schema_version: 1, kind: "epsilon" };
  const fanout = Math.min(1000, nodes - 1);
  const base = Math.floor((nodes - 1) / fanout);
  const extra = (nodes - 1) % fanout;
  const steps: unknown[] = [];
  for (let index = 0; index < fanout; index += 1) {
    steps.push(bushyProgram(base + (index < extra ? 1 : 0)));
  }
  return { schema_version: 1, kind: "sequence", steps };
}
