import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  QUERY_PROPOSAL_MAX_AST_DEPTH,
  QUERY_PROPOSAL_MAX_AST_NODES,
  type ProposedGuard,
  type ProposedQueryProgram,
  type QueryInterpretationProposal
} from "@do-soul/alaya-protocol";
import {
  collectRelations,
  compileConditionalFieldQuery,
  digestOriginalQuery
} from "../../../../recall/conditional-field/query/compile-query.js";
import { evaluateGuard } from "../../../../recall/conditional-field/engine/binding-environment.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget
} from "../reference/deployment.fixture.js";

const SCHEMA = CONDITIONAL_FIELD_SCHEMA_VERSION;
const TEXT = "xyzzy unrelated request";

describe("query proposal authority and AST budget", () => {
  it("does not treat a proposed authorization as true when current facts do not authorize", () => {
    const interpretation = compileOrdinaryProposal({
      program: relationProgram({
        schema_version: SCHEMA,
        kind: "authorization",
        authorization_scope: "secret",
        variable: "t"
      }),
      conditions: [{
        schema_version: SCHEMA,
        kind: "authorization",
        authorization_scope: "secret",
        variable: "t"
      }]
    });
    expect(interpretation.status).not.toBe("unsupported");
    const guard = collectRelations(interpretation.program)[0]?.guard;
    expect(guard?.kind).toBe("authorization");
    expect(guard?.verdict).toBe("unresolved");
    const env = new Map([["t", "fact"]]);
    expect(evaluateGuard(guard!, env, new Map())).toBe("unresolved");
    expect(evaluateGuard(guard!, env, new Map([["fact", { object_id: "fact", scope_class: "public" }]])))
      .toBe("false");
    expect(evaluateGuard({ ...guard!, verdict: "true" }, env, new Map([["fact", { object_id: "fact", scope_class: "public" }]])))
      .toBe("false");
  });

  it("does not treat a proposed equality as true when bound sides differ", () => {
    const interpretation = compileOrdinaryProposal({
      program: relationProgram({
        schema_version: SCHEMA,
        kind: "equality",
        variable: "s",
        equals_variable: "t"
      })
    });
    const guard = collectRelations(interpretation.program)[0]?.guard;
    expect(evaluateGuard(guard!, new Map([["s", "a"], ["t", "b"]]), new Map())).toBe("false");
    expect(evaluateGuard({ ...guard!, verdict: "true" }, new Map([["s", "a"], ["t", "b"]]), new Map()))
      .toBe("false");
  });

  it("does not treat a proposed source_bound_entity as true when the bound id disagrees", () => {
    const interpretation = compileOrdinaryProposal({
      program: relationProgram({
        schema_version: SCHEMA,
        kind: "source_bound_entity",
        variable: "t",
        entity_id: "memory-a"
      })
    });
    const guard = collectRelations(interpretation.program)[0]?.guard;
    expect(evaluateGuard(guard!, new Map([["t", "other"]]), new Map())).toBe("false");
    expect(evaluateGuard({ ...guard!, verdict: "true" }, new Map([["t", "other"]]), new Map()))
      .toBe("false");
  });

  it("rejects a smuggled final verdict instead of executing it", () => {
    const interpretation = compileOrdinaryProposal({
      program: relationProgram({
        schema_version: SCHEMA,
        kind: "authorization",
        authorization_scope: "secret",
        variable: "t",
        verdict: "true"
      } as never)
    });
    expect(interpretation.status).toBe("malformed");
    expect(interpretation.program.kind).toBe("epsilon");
  });

  it("returns unsupported for an unknown or unregistered producer without adopting the program", () => {
    const unknown = compileOrdinaryProposal({
      producer_id: "forged.unknown.v1",
      program: relationProgram({
        schema_version: SCHEMA,
        kind: "query_predicate",
        predicate_name: "source.identity.v1",
        variable: "t"
      })
    });
    expect(unknown.status).toBe("unsupported");
    expect(unknown.program.kind).toBe("epsilon");
    const forged = compileOrdinaryProposal({
      producer_id: "alaya.query.proposal.forged.v1",
      program: relationProgram({
        schema_version: SCHEMA,
        kind: "authorization",
        authorization_scope: "secret",
        variable: "t"
      })
    });
    expect(forged.status).toBe("unsupported");
    expect(forged.program.kind).toBe("epsilon");
  });

  it("changes query_id when producer_id or producer_version changes", () => {
    const base = compileOrdinaryProposal({ producer_id: "compiler.test.v1" });
    const otherProducer = compileOrdinaryProposal({ producer_id: "compiler.ordinary.v1" });
    const defaultedVersion = compileOrdinaryProposal({
      producer_id: "compiler.test.v1",
      producer_version: "1"
    });
    const otherVersion = compileOrdinaryProposal({
      producer_id: "compiler.test.v1",
      producer_version: "2"
    });
    expect(base.status).not.toBe("unsupported");
    expect(otherProducer.status).not.toBe("unsupported");
    expect(otherVersion.status).not.toBe("unsupported");
    expect(otherProducer.query_id).not.toBe(base.query_id);
    expect(defaultedVersion.query_id).toBe(base.query_id);
    expect(otherVersion.query_id).not.toBe(base.query_id);
  });

  it("rejects oversize proposal programs without throwing", () => {
    const atDepth = compileOrdinaryProposal({ program: nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH) as ProposedQueryProgram });
    const overDepth = compileOrdinaryProposal({ program: nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH + 1) as ProposedQueryProgram });
    const atNodes = compileOrdinaryProposal({ program: bushyProgram(QUERY_PROPOSAL_MAX_AST_NODES) as ProposedQueryProgram });
    const overNodes = compileOrdinaryProposal({ program: bushyProgram(QUERY_PROPOSAL_MAX_AST_NODES + 1) as ProposedQueryProgram });
    expect(atDepth.status).not.toBe("resource_rejected");
    expect(atDepth.program.kind).not.toBe("epsilon");
    expect(overDepth.status).toBe("resource_rejected");
    expect(overDepth.program.kind).toBe("epsilon");
    expect(atNodes.status).not.toBe("resource_rejected");
    expect(overNodes.status).toBe("resource_rejected");
    expect(overNodes.program.kind).toBe("epsilon");
  });

  it("rejects a declared AST cap that the program exceeds", () => {
    const interpretation = compileOrdinaryProposal({
      input_limits: { max_ast_nodes: 100 },
      program: bushyProgram(101) as ProposedQueryProgram
    });
    expect(interpretation.status).toBe("resource_rejected");
    expect(interpretation.program.kind).toBe("epsilon");
  });

  it("still rejects an unknown producer with a huge program and does not execute it", () => {
    const interpretation = compileOrdinaryProposal({
      producer_id: "forged.unknown.v1",
      program: nestedClosures(QUERY_PROPOSAL_MAX_AST_DEPTH + 8) as ProposedQueryProgram
    });
    expect(["resource_rejected", "unsupported"]).toContain(interpretation.status);
    expect(interpretation.program.kind).toBe("epsilon");
  });
});

function compileOrdinaryProposal(
  extra: Partial<QueryInterpretationProposal> & {
    readonly producer_id?: string;
  } = {}
) {
  return compileConditionalFieldQuery({
    source: "ordinary",
    snapshot_id: SNAPSHOT_ID,
    budget: defaultBudget(),
    text: TEXT,
    interpretation_clock: INTERPRETATION_CLOCK,
    interpretation_proposal: {
      schema_version: SCHEMA,
      original_query_digest: digestOriginalQuery(TEXT),
      producer_id: extra.producer_id ?? "compiler.test.v1",
      ...extra
    }
  });
}

function relationProgram(guard: ProposedGuard): ProposedQueryProgram {
  return {
    schema_version: SCHEMA,
    kind: "relation",
    relation_kind: "observed_log",
    source_variable: "s",
    target_variable: "t",
    facet_mode: "same_path",
    threshold_milligrades: 0,
    guard
  };
}

function nestedClosures(depth: number): unknown {
  let node: unknown = { schema_version: SCHEMA, kind: "epsilon" };
  for (let index = 1; index < depth; index += 1) {
    node = {
      schema_version: SCHEMA,
      kind: "closure",
      product_state_sufficient: true,
      body: node
    };
  }
  return node;
}

function bushyProgram(nodes: number): unknown {
  if (nodes <= 1) return { schema_version: SCHEMA, kind: "epsilon" };
  const fanout = Math.min(1000, nodes - 1);
  const base = Math.floor((nodes - 1) / fanout);
  const extra = (nodes - 1) % fanout;
  const steps: unknown[] = [];
  for (let index = 0; index < fanout; index += 1) {
    steps.push(bushyProgram(base + (index < extra ? 1 : 0)));
  }
  return { schema_version: SCHEMA, kind: "sequence", steps };
}
