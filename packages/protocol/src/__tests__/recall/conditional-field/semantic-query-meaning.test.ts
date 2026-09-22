import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  SourceSemanticQueryMeaningBodySchema,
  SourceSemanticQuerySchema,
  materializeSourceSemanticQueryMeaning, sourceSemanticQueryBranchViews
} from "../../../recall/conditional-field/index.js";
import { sourceSemanticQueryIdentity } from "../../../garden/source-semantic-identity.js";

const digest = `sha256:${"a".repeat(64)}`;
const identity = { original_query_digest: digest, producer_id: "qp", producer_version: "1" };
const envelope = { ...identity, original_query: "Who sent the sample to Mira?" };
const operation = { reading: "identify the requested participants", support: { kind: "query_text", excerpt: "Who" } };

const meaning = (node: object, extra: object = {}) => ({
  contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, alternatives: [{ conditions: [node] }], gaps: [], ...extra
});

function compiled(node: object, extra: object = {}, original = envelope.original_query) {
  return materializeSourceSemanticQueryMeaning(meaning(node, extra), { ...envelope, original_query: original });
}

function statement(predicate: string, args: object[], extra: object = {}) {
  return { kind: "statement", key: predicate, predicate, arguments: args, ...extra };
}

const occurrenceMeaning = (target = "ring", excerpt: string | null = "ringing") => ({
  contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [], return: [],
  alternatives: [{ conditions: [statement("before", [
    { role: "earlier", target: { kind: "reference", key: target }, ...(excerpt === null ? {} : { excerpt }) },
    { role: "later", target: { kind: "reference", key: "flash" }, excerpt: "flashing" }
  ]), statement("ring", []), statement("flash", [])] }]
});
const occurrenceEnvelope = { ...identity, original_query: "Did ringing precede flashing?" };

it("resolves forward role references to declared propositions without creating entities or embedding", () => {
  const query = materializeSourceSemanticQueryMeaning(occurrenceMeaning(), occurrenceEnvelope);
  expect(query.variables).toEqual([
    { id: "before", sort: "proposition" }, { id: "ring", sort: "proposition" }, { id: "flash", sort: "proposition" }
  ]);
  expect(query.alternatives[0]!.frames[0]!.role_requirements).toEqual([
    { id: "earlier", role_reading: "earlier", target_variable: "ring", support: { kind: "query_text", excerpt: "ringing" } },
    { id: "later", role_reading: "later", target_variable: "flash", support: { kind: "query_text", excerpt: "flashing" } }
  ]);
  expect(query.alternatives[0]!.context_obligations).toEqual([
    { frame: "before", kind: "asserted_at_source" }, { frame: "ring", kind: "asserted_at_source" },
    { frame: "flash", kind: "asserted_at_source" }
  ]);
});

it("keeps a referenced context and its nested occurrence in their declared scope", () => {
  const query = materializeSourceSemanticQueryMeaning({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [], alternatives: [{ conditions: [statement("discuss", [
    { role: "topic", target: { kind: "reference", key: "possibility" }, excerpt: "possible ringing" },
    { role: "event", target: { kind: "reference", key: "ring" }, excerpt: "ringing" }
  ]), { kind: "possible", key: "possibility", content: statement("ring", []) }] }] },
  { ...identity, original_query: "Was possible ringing discussed?" });
  expect(query.variables).toEqual([
    { id: "discuss", sort: "proposition" }, { id: "possibility", sort: "context" }, { id: "ring", sort: "proposition" }
  ]);
  expect(query.alternatives[0]!.context_obligations).toEqual([
    { frame: "discuss", kind: "asserted_at_source" }, { frame: "possibility", kind: "asserted_at_source" },
    { frame: "ring", kind: "explicit_embedded_structure",
      incidence: { kind: "operator_operand", other_frame: "possibility", role: "content" } }
  ]);
});

it("rejects unknown, unsupported and conflicting occurrence role references", () => {
  expect(() => materializeSourceSemanticQueryMeaning(occurrenceMeaning("missing"), occurrenceEnvelope)).toThrow(/undeclared local reference/u);
  expect(() => materializeSourceSemanticQueryMeaning(occurrenceMeaning("ring", null), occurrenceEnvelope)).toThrow(/requires explicit query text support/u);
  expect(() => materializeSourceSemanticQueryMeaning(occurrenceMeaning("ring", "invented"), occurrenceEnvelope)).toThrow(/absent from the original query/u);
  expect(() => materializeSourceSemanticQueryMeaning({ ...occurrenceMeaning(),
    entities: [{ kind: "named", key: "ring", excerpt: "ringing" }] }, occurrenceEnvelope)).toThrow(/cannot share one variable/u);
  expect(() => materializeSourceSemanticQueryMeaning({ ...occurrenceMeaning(), alternatives: [
    ...occurrenceMeaning().alternatives, { conditions: [statement("ring", [])] }
  ] }, occurrenceEnvelope)).toThrow(/requires a unique occurrence declaration/u);
  expect(() => compiled({ kind: "reported", reporter: { kind: "reference", key: "ring" },
    content: statement("ring", []) }, {}, "Who reported ringing?")).toThrow(/undeclared local reference/u);
});

it.each(["question", "directive"] as const)("checks original support before lowering a required evidence %s", act => {
  const original = `Which ${act} concerned ringing?`;
  const query = compiled(statement("ring", [], { required_evidence_act: { act, excerpt: act } }), {}, original);
  expect(query.alternatives[0]!.frames[0]!.source_act).toBe(act);
  expect(query.alternatives[0]!.context_obligations).toEqual([{ frame: "ring", kind: "unresolved" }]);
  expect(compiled(statement("ring", [], { required_evidence_act: { act, excerpt: act }, obligation: "unresolved" }), {}, original))
    .toEqual(query);
  expect(query.gaps).toEqual([]);
  expect(query.alternatives[0]!.frames[0]!.role_requirements).toEqual([]);
  for (const excerpt of ["", "absent support"]) {
    expect(() => compiled(statement("ring", [], { required_evidence_act: { act, excerpt } }), {}, original)).toThrow();
  }
});

it.each(["question", "directive"] as const)("rejects explicit assertion and entailment obligations on %s evidence through shared admission", act => {
  const original = `Which ${act} concerned ringing?`;
  for (const obligation of ["asserted_at_source", "entailed_at_source"] as const) {
    expect(() => compiled(statement("ring", [], { required_evidence_act: { act, excerpt: act }, obligation }), {}, original))
      .toThrow(/cannot require asserted or entailed/u);
    const canonical = compiled(statement("ring", []), {}, original);
    expect(() => SourceSemanticQuerySchema.parse({ ...canonical, alternatives: [{
      ...canonical.alternatives[0], frames: [{ ...canonical.alternatives[0]!.frames[0], source_act: act }],
      context_obligations: [{ frame: "ring", kind: obligation }]
    }] })).toThrow(/cannot require asserted or entailed/u);
  }
});

it.each(["asserted_at_source", "entailed_at_source", "unresolved"] as const)("retains explicit %s when no non-assertive act is required", obligation => {
  expect(compiled(statement("ring", [], { obligation })).alternatives[0]!.context_obligations)
    .toEqual([{ frame: "ring", kind: obligation }]);
});

it.each(["question", "directive"] as const)("preserves nested content of a requested %s root without asserting it", act => {
  const original = `Which ${act} concerned possible ringing?`;
  const query = compiled({ kind: "possible", key: "possibility", required_evidence_act: { act, excerpt: act },
    content: statement("ring", []) }, {}, original);
  expect(query.alternatives[0]!.frames.map(row => row.source_act)).toEqual([act, undefined]);
  expect(query.alternatives[0]!.context_obligations).toEqual([
    { frame: "possibility", kind: "unresolved" },
    { frame: "ring", kind: "explicit_embedded_structure", incidence: {
      kind: "operator_operand", other_frame: "possibility", role: "content"
    } }
  ]);
  for (const kind of ["explicit_embedded_structure", "unresolved"] as const) {
    expect(() => SourceSemanticQuerySchema.parse({ ...query, alternatives: [{ ...query.alternatives[0],
      frames: query.alternatives[0]!.frames.map(frame => frame.id === "ring" ? { ...frame, source_act: act } : frame),
      context_obligations: query.alternatives[0]!.context_obligations.map(row => row.frame === "ring" ? { ...row, kind } : row)
    }] })).toThrow(/source root, not a governed occurrence/u);
  }
});

it("defaults an independently requested question evidence input without changing the factual answer obligation", () => {
  const query = materializeSourceSemanticQueryMeaning({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    requested_operation: { reading: "compare", support: { kind: "query_text", excerpt: "Compare" } },
    alternatives: [{ conditions: [statement("ring", [])], evidence_inputs: [{ conditions: [
      statement("ask", [], { required_evidence_act: { act: "question", excerpt: "question" } })
    ] }] }] }, { ...envelope, original_query: "Compare ringing with the question about it." });
  expect(query.alternatives[0]!.context_obligations).toEqual([
    { frame: "ring", kind: "asserted_at_source" }, { frame: "ask", kind: "unresolved" }
  ]);
});

it("requires current original text and rejects old meaning or unsupported source-act syntax", () => {
  const body = meaning(statement("ring", []));
  expect(() => materializeSourceSemanticQueryMeaning(body, identity as typeof envelope)).toThrow(/requires original query text/u);
  expect(() => materializeSourceSemanticQueryMeaning({ ...body, contract: "source-semantic-query-meaning-v3" }, occurrenceEnvelope)).toThrow();
  expect(() => compiled(statement("ring", [], { source_act: "question" }), {}, occurrenceEnvelope.original_query)).toThrow();
  expect(() => compiled(statement("ring", [], { required_evidence_act: { act: "question" } }), {}, occurrenceEnvelope.original_query)).toThrow();
});

it("does not classify question wording or silently clear an explicitly supported evidence-act choice", () => {
  const ordinary = compiled(statement("ring", []), {}, "Did ringing occur?");
  const authored = compiled(statement("ring", [], { required_evidence_act: { act: "question", excerpt: "Did" } }), {}, "Did ringing occur?");
  expect(ordinary.alternatives[0]!.frames[0]!.source_act).toBeUndefined();
  expect(authored.alternatives[0]!.frames[0]!.source_act).toBe("question");
});

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

it("rejects a source act on governed content and leaves a factual polar question without source_act", () => {
  expect(() => compiled(statement("ask", [
    { role: "asker", target: { kind: "free", key: "asker" }, excerpt: "Who" }
  ], {
    content: statement("open", [
      { role: "theme", target: { kind: "named", key: "vault", excerpt: "vault" }, excerpt: "vault" }
    ], { required_evidence_act: { act: "question", excerpt: "asked whether" } })
  }), {}, "Who asked whether the vault was open?")).toThrow(/source root, not a governed occurrence/u);

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

it.each(["free", "named"] as const)("rejects conflicting entity declarations after an initial %s across every declaration boundary", (kind) => {
  const declaration = (value: "free" | "named") => ({ kind: value, key: "person", excerpt: value === "free" ? "Who" : "Mira" });
  const first = declaration(kind), second = declaration(kind === "free" ? "named" : "free");
  const argument = (target: object) => ({ role: "person", target });
  const bodies = [
    meaning(statement("tell", [argument(first), { role: "recipient", target: second }]), { return: ["person"] }),
    meaning(statement("tell", [argument(second)]), { entities: [first], return: ["person"] }),
    { ...meaning(statement("tell", [argument(first)])), return: ["person"], requested_operation: operation,
      alternatives: [{ conditions: [statement("tell", [argument(first)])],
        evidence_inputs: [{ conditions: [statement("leave", [argument(second)])] }] }] }
  ];
  for (const body of bodies) {
    expect(() => materializeSourceSemanticQueryMeaning(body, envelope)).toThrow(/entity declaration kind conflicts/u);
  }
});

it.each(["free", "named"] as const)("preserves %s redeclarations and explicit references across answer and evidence inputs", (kind) => {
  const declaration = { kind, key: "person", excerpt: kind === "free" ? "Who" : "Mira" };
  const query = materializeSourceSemanticQueryMeaning({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    entities: [declaration], return: ["person"], gaps: [], requested_operation: operation,
    alternatives: [{ conditions: [statement("tell", [{ role: "person", target: declaration }])],
      evidence_inputs: [{ conditions: [statement("leave", [
        { role: "person", target: { kind: "reference", key: "person" } }
      ]), statement("arrive", [{ role: "person", target: declaration }])] }] }] }, envelope);
  expect(query.variables.find(variable => variable.id === "person")).toEqual({ id: "person", sort: "entity",
    ...(kind === "named" ? { reference: { kind: "query_text", excerpt: "Mira" } } : {}) });
  expect(query.return_variables).toEqual(["person"]);
  expect(query.alternatives[0]!.frames.map(frame => frame.role_requirements[0]!.target_variable)).toEqual(["person", "person", "person"]);
  expect(query.alternatives[0]!.evidence_inputs).toEqual([{ frames: ["leave", "arrive"] }]);
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
  ]), { return: ["send"] }), envelope)).toThrow(/cannot share one variable/u);
});

it.each(["shared", "person", "s1"])("allocates an unreferenced occurrence independently of entity alias %s", (key) => {
  const query = compiled(statement("send", [
    { role: "agent", target: { kind: "free", key }, excerpt: "Who" }
  ], { key }));
  const occurrence = key === "s1" ? "s2" : "s1";
  expect(query.variables).toEqual([{ id: key, sort: "entity" }, { id: occurrence, sort: "proposition" }]);
  expect(query.alternatives).toEqual([{
    frames: [{ id: occurrence, variable: occurrence, predicate_reading: "send",
      role_requirements: [{ id: "agent", role_reading: "agent", target_variable: key,
        support: { kind: "query_text", excerpt: "Who" } }] }],
    context_obligations: [{ frame: occurrence, kind: "asserted_at_source" }]
  }]);
  expect(query.return_variables).toEqual([]);
});

it("preserves embedding, explicit gaps and absent operation inputs when an unused nested alias collides", () => {
  const gaps = [{ kind: "unsupported_meaning", affected_ids: ["promotion"],
    support: [{ kind: "query_text", excerpt: "elapsed days" }], description: "The interval remains unrepresented." }];
  const body = meaning(statement("promote", [], { key: "promotion", content: statement("occur_in", [
    { role: "time", target: { kind: "named", key: "period", excerpt: "July 2027" } }
  ], { key: "period" }) }), { return: [], gaps });
  const before = JSON.stringify(body);
  const query = materializeSourceSemanticQueryMeaning(body, envelope);
  expect(JSON.stringify(body)).toBe(before);
  expect(query.variables).toEqual([
    { id: "promotion", sort: "proposition" },
    { id: "period", sort: "entity", reference: { kind: "query_text", excerpt: "July 2027" } },
    { id: "s1", sort: "proposition" }
  ]);
  expect(query.alternatives[0]!.frames.map(frame => [frame.id, frame.predicate_reading])).toEqual([
    ["promotion", "promote"], ["s1", "occur_in"]
  ]);
  expect(query.alternatives[0]!.context_obligations).toEqual([
    { frame: "promotion", kind: "asserted_at_source" },
    { frame: "s1", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "promotion", role: "content" } }
  ]);
  expect(query.return_variables).toEqual([]);
  expect(query.gaps).toEqual(gaps);
  expect(query.requested_operation).toBeUndefined();
  expect(query.alternatives[0]!.evidence_inputs).toBeUndefined();
  expect(query.alternatives[0]!.answer_frames).toBeUndefined();
});

it("allocates an unreferenced context alias without changing a named reporter or its scope", () => {
  const query = compiled({ kind: "reported", key: "speaker",
    reporter: { kind: "named", key: "speaker", excerpt: "Mira" }, content: statement("left", []) });
  expect(query.variables).toEqual([
    { id: "speaker", sort: "entity", reference: { kind: "query_text", excerpt: "Mira" } },
    { id: "left", sort: "proposition" }, { id: "c1", sort: "context" }
  ]);
  expect(query.alternatives[0]!.frames[0]).toMatchObject({ id: "c1", operator: "reported",
    role_requirements: [{ target_variable: "speaker" }] });
  expect(query.alternatives[0]!.context_obligations).toEqual([
    { frame: "c1", kind: "asserted_at_source" },
    { frame: "left", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "c1", role: "content" } }
  ]);
});

const collided = () => statement("send", [
  { role: "agent", target: { kind: "named", key: "shared", excerpt: "Mira" } }
], { key: "shared" });
const referenceProtections: readonly [string, () => unknown][] = [
  ["explicit return", () => meaning(collided(), { return: ["shared"] })],
  ["occurrence return", () => meaning({ ...collided(), return: true })],
  ["inline target return", () => meaning(statement("send", [
    { role: "agent", target: { kind: "free", key: "shared", return: true }, excerpt: "Who" }
  ], { key: "shared" }))],
  ["entity-table return", () => meaning(collided(), { entities: [{ kind: "named", key: "shared", excerpt: "Mira", return: true }] })],
  ["gap target", () => meaning(collided(), { gaps: [{ kind: "unsupported_meaning", affected_ids: ["shared"],
    support: [{ kind: "query_text", excerpt: "already" }] }] })],
  ["domain declaration", () => meaning(collided(), { domains: [{ key: "shared", excerpt: "people" }] })],
  ["occurrence reuse", () => ({ ...meaning(collided()), alternatives: [{ conditions: [collided(), { kind: "occurrence", key: "shared" }] }] })],
  ["later alternative entity reference", () => ({ ...meaning(collided()), alternatives: [{ conditions: [collided()] },
    { conditions: [statement("leave", [{ role: "agent", target: { kind: "reference", key: "shared" }, excerpt: "Mira" }])] }] })],
  ["evidence occurrence reuse", () => ({ ...meaning(collided()), requested_operation: operation,
    alternatives: [{ conditions: [collided()], evidence_inputs: [{ conditions: [{ kind: "occurrence", key: "shared" }] }] }] })],
  ["evidence entity reference", () => ({ ...meaning(collided()), requested_operation: operation,
    alternatives: [{ conditions: [collided()], evidence_inputs: [{ conditions: [statement("leave", [
      { role: "agent", target: { kind: "reference", key: "shared" }, excerpt: "Mira" }
    ])] }] }] })],
  ["reported reference", () => meaning({ kind: "reported", reporter: { kind: "reference", key: "shared" }, content: collided() })],
  ...(["domain", "binder", "local_variables"] as const).map((field): [string, () => unknown] => [
    `universal ${field}`, () => meaning(collided(), { domains: [{ key: "population", excerpt: "people" }],
      evaluation: { kind: "forall", domain: "population", binder: "person", local_variables: ["person"],
        [field]: field === "local_variables" ? ["shared"] : "shared" } })
  ])
];

it.each(referenceProtections)("does not retarget an alias used by %s", (_name, body) => {
  expect(() => materializeSourceSemanticQueryMeaning(body(), envelope)).toThrow(/cannot share one variable/u);
});

it("rejects multiple occurrence declarations, other occurrence sorts and conflicting entity meanings", () => {
  expect(() => materializeSourceSemanticQueryMeaning({ ...meaning(collided()),
    alternatives: [{ conditions: [collided(), statement("leave", [], { key: "shared" })] }] }, envelope))
    .toThrow(/cannot share one variable/u);
  expect(() => compiled({ kind: "possible", key: "shared", content: statement("leave", [], { key: "shared" }) }))
    .toThrow(/cannot share one variable/u);
  expect(() => compiled(collided(), { entities: [{ kind: "named", key: "shared", excerpt: "Omar" }] }))
    .toThrow(/named constraint excerpt conflicts/u);
});

it("preserves an accepted query's complete graph and existing identity material", () => {
  const query = compiled(statement("send", [{ role: "agent", target: { kind: "free", key: "person" }, excerpt: "Who" }], {
    content: { kind: "possible", content: { kind: "statement", predicate: "arrive",
      arguments: [{ role: "agent", target: { kind: "reference", key: "person" }, excerpt: "Who" }] } }
  }), { return: ["person"] });
  const expected = SourceSemanticQuerySchema.parse({
    contract: SOURCE_SEMANTIC_QUERY_CONTRACT, ...identity, contract_version: SOURCE_SEMANTIC_QUERY_CONTRACT,
    variables: [{ id: "send", sort: "proposition" }, { id: "person", sort: "entity" },
      { id: "c1", sort: "context" }, { id: "s1", sort: "proposition" }],
    alternatives: [{ frames: [
      { id: "send", variable: "send", predicate_reading: "send", role_requirements: [{ id: "agent", role_reading: "agent",
        target_variable: "person", support: { kind: "query_text", excerpt: "Who" } }] },
      { id: "c1", variable: "c1", predicate_reading: "possible", operator: "possible", role_requirements: [] },
      { id: "s1", variable: "s1", predicate_reading: "arrive", role_requirements: [{ id: "agent", role_reading: "agent",
        target_variable: "person", support: { kind: "query_text", excerpt: "Who" } }] }
    ], context_obligations: [
      { frame: "send", kind: "asserted_at_source" },
      { frame: "c1", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "send", role: "content" } },
      { frame: "s1", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "c1", role: "content" } }
    ] }], return_variables: ["person"], gaps: []
  });
  expect(query).toEqual(expected);
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  expect(sourceSemanticQueryIdentity(query, sha256)).toBe(sourceSemanticQueryIdentity(expected, sha256));
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
