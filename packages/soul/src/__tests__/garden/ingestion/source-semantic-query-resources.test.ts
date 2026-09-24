import { expect, it } from "vitest";
import { proposeQuerySemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const original = "Who inspected the rotor?";
const ample = { work_units: 200000, memory_bytes: 20000000 };
const leaf = { node: "inspection", kind: "statement", key: "inspect", predicate: "inspect", arguments: [
  { role: "inspector", target: { kind: "free", key: "person", return: true }, excerpt: "Who" },
  { role: "object", target: { kind: "named", key: "rotor", excerpt: "rotor" } }
] };
const body = (nodes: readonly object[] = [leaf], conditions: readonly string[] = ["inspection"], extra: object = {}) => ({
  contract: "source-semantic-query-meaning-v5", alternatives: [{ conditions }], gaps: [], nodes, ...extra
});

function receive(query: object, limits: object = ample, original_query = original) {
  return proposeQuerySemantics({ original_query, producer_id: "alaya.source.semantic.query.soul.v1",
    producer_version: "1", resource_limits: limits }, { rawJson: JSON.stringify({
    contract: "source-semantic-query-response-v8", outcome: { status: "interpreted" }, query
  }) });
}

it("uses one native allowance across carrier and canonical meaning for a valid statement", () => {
  const positive = receive(body());
  expect(positive.outcome.status).toBe("interpreted");
  expect(positive.query?.return_variables).toEqual(["person"]);
  for (const limits of [{ work_units: 0 }, { work_units: 1 }, { memory_bytes: 0 }, { memory_bytes: 100 }]) {
    expect(receive(body(), limits).outcome).toEqual({ status: "resource_exhausted" });
  }
});

it("charges finite meaning with no expression nodes and retains an adequately funded result", () => {
  const query = body([], [], { domains: [{ key: "parts", excerpt: "rotor" }],
    entities: [{ kind: "named", key: "left", excerpt: "rotor" },
      { kind: "named", key: "right", excerpt: "axle" }],
    evaluation: { kind: "comparison", domain: "parts", operation: "gt", left: "left", right: "right",
      strict: true, metric: "mass", unit: "kg", context: "weighing", scope: "asserted" } });
  const question = "Is the rotor heavier than the axle?";
  expect(receive(query, ample, question)).toMatchObject({ outcome: { status: "interpreted" },
    query: { evaluation: { kind: "comparison", operation: "gt" } } });
  for (const limits of [{ work_units: 0 }, { work_units: 1 }, { memory_bytes: 0 }, { memory_bytes: 100 }]) {
    expect(receive(query, limits, question).outcome).toEqual({ status: "resource_exhausted" });
  }
});

it("keeps malformed reference, cycle, shape and depth failures structural under adequate resources", () => {
  const cycle = body([{ node: "inspection", kind: "not", content: "inspection" }]);
  const longChain = body(Array.from({ length: 10 }, (_, index) => index === 9
    ? { ...leaf, node: `n${index}` }
    : { node: `n${index}`, kind: "possible", content: `n${index + 1}` }), ["n0"]);
  for (const query of [body([leaf], ["missing"]), cycle,
    body([{ ...leaf, arguments: "not-an-array" }]), longChain]) {
    expect(receive(query).outcome.status).toBe("invalid");
  }
  expect(proposeQuerySemantics({ original_query: original, producer_id: "alaya.source.semantic.query.soul.v1",
    producer_version: "1", resource_limits: { output_byte_limit: 1024 } },
  { rawJson: " ".repeat(1025) }).outcome.status).toBe("truncated");
});
