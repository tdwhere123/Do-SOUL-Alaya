import { expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SourceSemanticQueryMeaningBodySchema,
  SourceSemanticQuerySchema,
  materializeSourceSemanticQueryMeaning, sourceSemanticQueryBranchViews
} from "../../../recall/conditional-field/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const envelope = { original_query_digest: digest, producer_id: "qp", producer_version: "1" };
const operation = { reading: "identify the requested participants", support: { kind: "query_text", excerpt: "Who" } };

const meaning = (node: object, extra: object = {}) => ({
  contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, alternatives: [{ conditions: [node] }], gaps: [], ...extra
});

function compiled(node: object, extra: object = {}) {
  return materializeSourceSemanticQueryMeaning(meaning(node, extra), envelope);
}

function statement(predicate: string, args: object[], extra: object = {}) {
  return { kind: "statement", key: predicate, predicate, arguments: args, ...extra };
}

it("represents independent conjuncts with a shared participant without inventing embedding", () => {
  const query = materializeSourceSemanticQueryMeaning({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    alternatives: [{ conditions: [statement("invited", [{ role: "person", target: { kind: "free", key: "person" }, excerpt: "Who" }]),
      statement("spoke", [{ role: "person", target: { kind: "reference", key: "person" }, excerpt: "Who" }])] }], return: ["person"] }, envelope);
  expect(query.alternatives[0]!.context_obligations).toEqual([
    { frame: "invited", kind: "asserted_at_source" }, { frame: "spoke", kind: "asserted_at_source" }
  ]);
});

it("keeps an evidence occurrence inside its entire conditional scope including the sibling operand", () => {
  const query = materializeSourceSemanticQueryMeaning({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    requested_operation: operation, alternatives: [{ conditions: [{ kind: "conditional", key: "condition",
      antecedent: statement("invited", []), consequent: statement("spoke", []) }],
    evidence_inputs: [{ conditions: [{ kind: "occurrence", key: "spoke" }] }] }] }, envelope);
  const view = sourceSemanticQueryBranchViews(query.alternatives[0]!)[1]!;
  expect(view.alternative.frames.map(frame => frame.id)).toEqual(["condition", "invited", "spoke"]);
  expect(view.alternative.context_obligations.filter(row => row.kind === "asserted_at_source").map(row => row.frame)).toEqual(["condition"]);
  expect(query.alternatives[0]!.evidence_inputs).toEqual([{ frames: ["spoke"] }]);
});

it("retains an unrepresented original answer while admitting a faithfully stated input", () => {
  const query = materializeSourceSemanticQueryMeaning({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    requested_operation: operation, alternatives: [{ conditions: [], evidence_inputs: [{ conditions: [statement("joined", [])] }] }] }, envelope);
  expect(query.alternatives[0]!.answer_frames).toEqual([]);
  expect(query.return_variables).toEqual([]);
  expect(sourceSemanticQueryBranchViews(query.alternatives[0]!)[0]!.alternative.frames).toEqual([]);
});

it("rejects finite evaluation with evidence inputs before any branch can be silently discarded", () => {
  expect(() => materializeSourceSemanticQueryMeaning({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    requested_operation: operation, alternatives: [{ conditions: [], evidence_inputs: [{ conditions: [statement("joined", [])] }] }],
    domains: [{ key: "people", excerpt: "Who" }], evaluation: { kind: "comparison", domain: "people", operation: "minimum",
      left: "person", strict: false, metric: "age", unit: "years", context: "now", scope: "asserted" } }, envelope)).toThrow(/finite evaluation/u);
});

it("keeps a free sender distinct from a named recipient and a send proposition", () => {
  const query = compiled(statement("send", [
    { role: "sender", target: { kind: "free", key: "sender" }, excerpt: "Who" },
    { role: "theme", target: { kind: "named", key: "sample", excerpt: "sample" }, excerpt: "sample" },
    { role: "recipient", target: { kind: "named", key: "mira", excerpt: "Mira" }, excerpt: "Mira" }
  ]), { return: ["sender"] });
  const byId = new Map(query.variables.map((row) => [row.id, row]));
  expect(byId.get("sender")).toMatchObject({ sort: "entity" });
  expect(byId.get("sender")?.reference).toBeUndefined();
  expect(byId.get("mira")).toEqual({ id: "mira", sort: "entity", reference: { kind: "query_text", excerpt: "Mira" } });
  expect(byId.get("send")).toMatchObject({ sort: "proposition" });
  expect(query.return_variables).toEqual(["sender"]);
  expect(query.alternatives[0]?.frames[0]?.source_act).toBeUndefined();
  expect(query.alternatives[0]?.context_obligations).toEqual([{ frame: "send", kind: "asserted_at_source" }]);
});

it("nests possible around a move statement and does not add a source-question constraint", () => {
  const query = compiled({
    kind: "possible", key: "possible",
    content: statement("move", [
      { role: "actor", target: { kind: "free", key: "actor" }, excerpt: "Who" },
      { role: "destination", target: { kind: "named", key: "suzhou", excerpt: "Suzhou" }, excerpt: "Suzhou" }
    ])
  }, { return: ["actor"] });
  const frames = query.alternatives[0]!.frames;
  expect(frames[0]).toMatchObject({ id: "possible", operator: "possible", role_requirements: [] });
  expect(frames[1]).toMatchObject({ id: "move", predicate_reading: "move" });
  expect(frames[1]?.role_requirements.map((row) => row.target_variable)).toEqual(["actor", "suzhou"]);
  expect(frames.some((row) => row.source_act !== undefined)).toBe(false);
  expect(query.alternatives[0]?.context_obligations).toEqual([
    { frame: "possible", kind: "asserted_at_source" },
    { frame: "move", kind: "explicit_embedded_structure",
      incidence: { kind: "operator_operand", other_frame: "possible", role: "content" } }
  ]);
});

it("marks requested question content and leaves a factual polar question without source_act", () => {
  const asked = compiled(statement("ask", [
    { role: "asker", target: { kind: "free", key: "asker" }, excerpt: "Who" }
  ], {
    content: statement("open", [
      { role: "theme", target: { kind: "named", key: "vault", excerpt: "vault" }, excerpt: "vault" }
    ], { source_act: "question" })
  }));
  expect(asked.alternatives[0]?.frames.find((row) => row.id === "ask")?.source_act).toBeUndefined();
  expect(asked.alternatives[0]?.frames.find((row) => row.id === "open")?.source_act).toBe("question");
  expect(asked.alternatives[0]?.context_obligations.find((row) => row.frame === "open")).toMatchObject({
    kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "ask", role: "content" }
  });

  const polar = compiled(statement("open", [
    { role: "theme", target: { kind: "named", key: "vault", excerpt: "vault" }, excerpt: "vault" }
  ]));
  expect(polar.alternatives[0]?.frames[0]?.source_act).toBeUndefined();
  expect(polar.alternatives[0]?.context_obligations).toEqual([{ frame: "open", kind: "asserted_at_source" }]);
});

it("keeps a promised send embedded rather than asserted as an actual send", () => {
  const query = compiled(statement("promise", [
    { role: "promisor", target: { kind: "named", key: "bob", excerpt: "Bob" }, excerpt: "Bob" }
  ], {
    content: statement("send", [
      { role: "theme", target: { kind: "free", key: "parcel" }, excerpt: "parcel" },
      { role: "recipient", target: { kind: "named", key: "alice", excerpt: "Alice" }, excerpt: "Alice" }
    ])
  }), { return: ["parcel"] });
  expect(query.alternatives[0]?.context_obligations).toEqual([
    { frame: "promise", kind: "asserted_at_source" },
    { frame: "send", kind: "explicit_embedded_structure",
      incidence: { kind: "embedding", other_frame: "promise", role: "content" } }
  ]);
  expect(query.alternatives[0]?.frames.find((row) => row.id === "send")?.source_act).toBeUndefined();
});

it("preserves not and conditional operand roles instead of reversing implication", () => {
  const negated = compiled({
    kind: "not", key: "not",
    content: statement("open", [
      { role: "theme", target: { kind: "named", key: "vault", excerpt: "vault" }, excerpt: "vault" }
    ])
  });
  expect(negated.alternatives[0]?.frames[0]).toMatchObject({ operator: "not", role_requirements: [] });
  expect(negated.alternatives[0]?.context_obligations[1]).toMatchObject({
    incidence: { kind: "operator_operand", other_frame: "not", role: "content" }
  });

  const conditional = compiled({
    kind: "conditional", key: "if",
    antecedent: statement("arrive", [
      { role: "theme", target: { kind: "named", key: "train", excerpt: "train" }, excerpt: "train" }
    ]),
    consequent: statement("open", [
      { role: "theme", target: { kind: "named", key: "gate", excerpt: "gate" }, excerpt: "gate" }
    ])
  });
  expect(conditional.alternatives[0]?.context_obligations.map((row) => row.incidence?.role))
    .toEqual([undefined, "antecedent", "consequent"]);
});

it("separates a named entity called Who from a free target and retains an ambiguous gap", () => {
  const query = compiled(statement("greet", [
    { role: "agent", target: { kind: "named", key: "whoPerson", excerpt: "Who" }, excerpt: "Who" },
    { role: "theme", target: { kind: "free", key: "guest" }, excerpt: "them" }
  ]), { gaps: [{ kind: "unresolved_referent", affected_ids: ["guest"], support: [{ kind: "query_text", excerpt: "them" }] }] });
  expect(query.variables.find((row) => row.id === "whoPerson")?.reference?.excerpt).toBe("Who");
  expect(query.variables.find((row) => row.id === "guest")?.reference).toBeUndefined();
  expect(query.gaps[0]?.kind).toBe("unresolved_referent");
});

it("reuses a shared entity and can return a proposition without forcing an entity conversion", () => {
  const query = compiled(statement("pack", [
    { role: "theme", target: { kind: "free", key: "parcel" }, excerpt: "parcel" }
  ], {
    content: statement("inspect", [
      { role: "theme", target: { kind: "reference", key: "parcel" }, excerpt: "parcel" }
    ], { return: true })
  }), { return: ["parcel"] });
  const roles = query.alternatives[0]!.frames.flatMap((row) => row.role_requirements);
  expect(roles.map((row) => row.target_variable)).toEqual(["parcel", "parcel"]);
  expect(query.return_variables).toEqual(expect.arrayContaining(["parcel", "inspect"]));
  expect(query.variables.find((row) => row.id === "inspect")?.sort).toBe("proposition");
});

it("preserves universal and comparison evaluation on the canonical query", () => {
  const universal = compiled(statement("use", [
    { role: "agent", target: { kind: "free", key: "actor" }, excerpt: "user" },
    { role: "theme", target: { kind: "named", key: "tools", excerpt: "tools" }, excerpt: "tools" }
  ], { obligation: "entailed_at_source" }), {
    domains: [{ key: "people", excerpt: "registered user" }],
    evaluation: { kind: "forall", domain: "people", binder: "actor", local_variables: ["actor", "tools", "use"] }
  });
  expect(universal.evaluation).toEqual({
    kind: "forall", domain: "people", binder: "actor", local_variables: ["actor", "tools", "use"]
  });

  const comparison = materializeSourceSemanticQueryMeaning({
    contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: [] }],
    gaps: [],
    domains: [{ key: "people", excerpt: "Alice" }],
    entities: [{ kind: "named", key: "alice", excerpt: "Alice" }, { kind: "named", key: "bob", excerpt: "Bob" }],
    evaluation: {
      kind: "comparison", domain: "people", operation: "gt", left: "alice", right: "bob",
      strict: true, metric: "speed", unit: "ms", context: "lab", scope: "asserted"
    }
  }, envelope);
  expect(comparison.alternatives[0]?.frames).toEqual([]);
  expect(comparison.evaluation).toMatchObject({ kind: "comparison", left: "alice", right: "bob", strict: true });
  expect(comparison.variables).toEqual([
    { id: "alice", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } },
    { id: "bob", sort: "entity", reference: { kind: "query_text", excerpt: "Bob" } }
  ]);
});

it("generates universal evaluation without advertising unsupported nested forall", () => {
  const body = meaning(statement("use", [
    { role: "agent", target: { kind: "reference", key: "actor" } }
  ]), { domains: [{ key: "people", excerpt: "people" }],
    evaluation: { kind: "forall", domain: "people", binder: "actor", local_variables: ["actor"] } });
  expect(SourceSemanticQueryMeaningBodySchema.safeParse(body).success).toBe(true);
  expect(SourceSemanticQueryMeaningBodySchema.safeParse(meaning({
    kind: "forall", domain: "people", binder: "actor",
    content: statement("use", [])
  })).success).toBe(false);
});

it("rejects nested forall rather than erase its domain and binder", () => {
  expect(() => compiled({ kind: "possible", content: {
    kind: "forall", domain: "people", binder: "actor",
    content: statement("travel", [{ role: "agent", target: { kind: "reference", key: "actor" } }])
  } }, { domains: [{ key: "people", excerpt: "people" }] })).toThrow(/Invalid/u);
});

it("uses recursive meaning while rejecting a ten-node nesting path before materialization", () => {
  let node: object = statement("travel", []);
  for (let index = 0; index < 5; index += 1) node = { kind: "possible", content: node };
  expect(SourceSemanticQueryMeaningBodySchema.safeParse(meaning(node)).success).toBe(true);
  expect(compiled(node).alternatives[0]!.frames).toHaveLength(6);
  for (let index = 0; index < 4; index += 1) node = { kind: "possible", content: node };
  expect(() => compiled(node)).toThrow(/query meaning nesting exceeds its bound/u);
});

it("refuses cyclic, undeclared, and kind-conflicting references instead of repairing them", () => {
  expect(() => compiled({ kind: "occurrence", key: "missing" })).toThrow(/undeclared local reference/u);
  expect(() => compiled(statement("loop", [], { key: "loop", content: { kind: "occurrence", key: "loop" } })))
    .toThrow(/cyclic local reference|cannot govern itself/u);
  expect(() => compiled(statement("send", [
    { role: "agent", target: { kind: "reference", key: "ghost" }, excerpt: "Who" }
  ]))).toThrow(/undeclared local reference/u);
  expect(() => materializeSourceSemanticQueryMeaning(meaning(statement("send", [
    { role: "agent", target: { kind: "free", key: "send" }, excerpt: "Who" }
  ])), envelope)).toThrow(/cannot share one variable/u);
});

it("does not treat a legacy producer graph as meaning syntax or repair its sorts", () => {
  const legacy = {
    variables: [{ id: "who", sort: "entity" as const }, { id: "move", sort: "entity" as const }],
    alternatives: [{ frames: [{ id: "qMove", variable: "move", predicate_reading: "move", role_requirements: [] }],
      context_obligations: [] }],
    return_variables: ["who"],
    gaps: []
  };
  expect(SourceSemanticQueryMeaningBodySchema.safeParse(legacy).success).toBe(false);
  expect(SourceSemanticQuerySchema.safeParse({
    contract: SOURCE_SEMANTIC_QUERY_CONTRACT, original_query_digest: digest,
    producer_id: "qp", producer_version: "1", contract_version: SOURCE_SEMANTIC_QUERY_CONTRACT, ...legacy
  }).success).toBe(false);
});

it("keeps generation schema on the meaning contract without host identities or sort tables", () => {
  const parsed = SourceSemanticQueryMeaningBodySchema.parse(meaning(statement("hand", [
    { role: "agent", target: { kind: "free", key: "agent" }, excerpt: "Who" }
  ])));
  expect(parsed.contract).toBe(SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT);
  expect(SourceSemanticQueryMeaningBodySchema.safeParse({
    ...parsed, original_query_digest: digest
  }).success).toBe(false);
  expect(SourceSemanticQueryMeaningBodySchema.safeParse({
    contract: SOURCE_SEMANTIC_QUERY_CONTRACT, alternatives: parsed.alternatives, gaps: []
  }).success).toBe(false);
});
