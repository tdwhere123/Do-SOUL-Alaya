import { describe, expect, it } from "vitest";
import {
  CANONICAL_QUERY_OPERATOR_ID,
  digestCanonicalQueryV1,
  serializeCanonicalQueryV1,
  validateCanonicalQueryV1,
  type CanonicalAnswerProgramV1,
  type CanonicalQueryInputV1,
  type CanonicalVariableV1
} from "../../../../recall/query/canonical-query/index.js";

const ENTITY: CanonicalVariableV1 = { name: "x", sort: "entity" };
const TIME: CanonicalVariableV1 = { name: "t", sort: "time" };

describe("canonical query algebra v1", () => {
  it("accepts scalar, distinct, extrema, and sequence programs", () => {
    expect(supported({
      variables: [ENTITY],
      answer: { kind: "scalar", variable: "x" }
    }).query.operator_id).toBe(CANONICAL_QUERY_OPERATOR_ID);
    expect(supported({
      variables: [ENTITY],
      answer: { kind: "distinct", variable: "x", completion: { kind: "at_most", n: 5 } }
    }).query.answer.kind).toBe("distinct");
    expect(supported({
      variables: [ENTITY],
      answer: {
        kind: "distinct",
        variable: "x",
        completion: {
          kind: "all_observable",
          scope: "workspace-1",
          principal: "principal-1",
          snapshot_bind: "Sigma_q",
          observer_contract: "observer-v1"
        }
      }
    }).query.answer.kind).toBe("distinct");
    expect(supported({
      variables: [ENTITY, TIME],
      answer: { kind: "argmax", order_key: "t", inner: { kind: "scalar", variable: "x" } }
    }).query.answer.kind).toBe("argmax");
    expect(supported({
      variables: [ENTITY, TIME],
      answer: { kind: "argmin", order_key: "t", inner: { kind: "scalar", variable: "x" } }
    }).query.answer.kind).toBe("argmin");
    expect(supported({
      variables: [ENTITY, TIME],
      answer: {
        kind: "sequence",
        order_key: "t",
        variable: "x",
        completion: { kind: "at_most", n: 3 }
      }
    }).query.answer.kind).toBe("sequence");
  });

  it("rejects undeclared variables, unbound keys, and wrong temporal domains", () => {
    expect(validateCanonicalQueryV1({
      variables: [ENTITY],
      answer: { kind: "scalar", variable: "missing" }
    }).status).toBe("unsupported");
    expect(codeOf({
      variables: [ENTITY],
      answer: { kind: "argmax", order_key: "missing", inner: { kind: "scalar", variable: "x" } }
    })).toBe("undeclared_variable");
    expect(codeOf({
      variables: [ENTITY, { name: "k", sort: "scalar" }],
      answer: { kind: "argmax", order_key: "k", inner: { kind: "scalar", variable: "x" } }
    })).toBe("unbound_order_key");
    expect(codeOf({
      variables: [ENTITY, { name: "k", sort: "order_key" }],
      answer: { kind: "argmax", order_key: "k", inner: { kind: "scalar", variable: "x" } }
    })).toBe("wrong_temporal_domain");
  });

  it("rejects multiple terminals, overflow, and keeps count/sum/latest unsupported", () => {
    expect(codeOf({
      variables: [ENTITY],
      answers: [
        { kind: "scalar", variable: "x" },
        { kind: "scalar", variable: "x" }
      ]
    })).toBe("multiple_terminal_programs");
    expect(codeOf({
      variables: Array.from({ length: 9 }, (_, index) => ({
        name: `v${index}`,
        sort: "entity" as const
      })),
      answer: { kind: "scalar", variable: "v0" }
    })).toBe("limit_overflow");
    const nested: CanonicalAnswerProgramV1 = {
      kind: "argmax",
      order_key: "t",
      inner: {
        kind: "argmax",
        order_key: "t",
        inner: { kind: "argmax", order_key: "t", inner: { kind: "scalar", variable: "x" } }
      }
    };
    expect(codeOf({ variables: [ENTITY, TIME], answer: nested })).toBe("limit_overflow");
    expect(codeOf({ variables: [ENTITY], unsupported: "count" })).toBe("count_sum_unsupported");
    expect(codeOf({ variables: [ENTITY], unsupported: "sum" })).toBe("count_sum_unsupported");
    expect(codeOf({ variables: [ENTITY], unsupported: "latest" }))
      .toBe("latest_without_typed_time_key");
    expect(codeOf({ variables: [ENTITY], unsupported: "nesting" })).toBe("unsupported_nesting");
  });

  it("serializes a normalized AST stably", () => {
    const left = supported({
      variables: [TIME, ENTITY],
      predicates: [
        { id: "p2", relation: "works_at", arguments: ["x"] },
        { id: "p1", relation: "named", arguments: ["x"] }
      ],
      answer: { kind: "scalar", variable: "x" }
    });
    const right = supported({
      variables: [ENTITY, TIME],
      predicates: [
        { id: "p1", relation: "named", arguments: ["x"] },
        { id: "p2", relation: "works_at", arguments: ["x"] }
      ],
      answer: { kind: "scalar", variable: "x" }
    });
    expect(serializeCanonicalQueryV1(left.query)).toBe(serializeCanonicalQueryV1(right.query));
    expect(digestCanonicalQueryV1(left.query)).toBe(digestCanonicalQueryV1(right.query));
    expect(Object.isFrozen(left.query)).toBe(true);
  });

  it("rejects undeclared Phi arguments and coerced snapshot binds", () => {
    expect(codeOf({
      variables: [ENTITY],
      predicates: [{ id: "p1", relation: "works_at", arguments: ["y"] }],
      answer: { kind: "scalar", variable: "x" }
    })).toBe("undeclared_variable");
    expect(codeOf({
      variables: [ENTITY],
      answer: {
        kind: "distinct",
        variable: "x",
        completion: {
          kind: "all_observable",
          scope: "scope-1",
          principal: "principal-1",
          snapshot_bind: "not_sigma" as "Sigma_q",
          observer_contract: "observer-v1"
        }
      }
    })).toBe("invalid_all_observable");
    expect(codeOf({
      variables: [{ name: "x", sort: "nope" as "entity" }],
      answer: { kind: "scalar", variable: "x" }
    })).toBe("invalid_sort");
    expect(codeOf({
      variables: [ENTITY],
      predicates: [{ id: "p1", relation: " ", arguments: ["x"] }],
      answer: { kind: "scalar", variable: "x" }
    })).toBe("undeclared_variable");
  });
});

function supported(input: CanonicalQueryInputV1) {
  const result = validateCanonicalQueryV1(input);
  expect(result.status).toBe("supported");
  if (result.status !== "supported") throw new Error("expected supported");
  return result;
}

function codeOf(input: CanonicalQueryInputV1): string {
  const result = validateCanonicalQueryV1(input);
  expect(result.status).toBe("unsupported");
  return result.status === "unsupported" ? result.reason_code : "supported";
}
