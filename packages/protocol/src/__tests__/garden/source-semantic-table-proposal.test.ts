import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSourceReferenceCatalog } from "../../evidence/source-reference.js";
import { materializeSourceSemanticTableProposal, SourceSemanticTableValidationError,
  SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT } from "../../garden/source-semantic-table-proposal.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const atom = (text: string) => ({ assertion_id: 1, text });
const ref = (key: string) => ({ kind: "content_ref", key });
const entityRef = (key: string) => ({ kind: "entity_ref", key });
const statement = (key: string, reading = "reads", args: object[] = [], qualifications: object[] = []) => ({
  kind: "statement", key, predicate: { kind: "explicit", reading, support: atom(reading) },
  arguments: args, qualifications
});
const table = (nodes: object[], entities: object[] = [], roots = ["event"], extra: object = {}) => ({
  contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" },
  content: { nodes, entities, roots: roots.map(key => ({ act: "assertion", expression: ref(key) })), gaps: [], ...extra }
});
const person = { form: "selection", key: "person", selection: atom("Mira") };
const domain = { key: "people", context: null, support: atom("Mira"), members: [], exclusions: [], closure: { kind: "open" } };
const measurement = { key: "count", subject: entityRef("person"), owner: "event", population: "people",
  metric: "headcount", unit: "person", context: "observed", value: "12", support: atom("12") };
const quantified = { kind: "forall", key: "all", support: atom("Every"), domain: "people", restriction: null, content: ref("event") };
const lower = (value: unknown, text = "Every Mira reads 12", meter?: SourceSemanticResourceLedger) =>
  materializeSourceSemanticTableProposal(value, {
    catalog: buildSourceReferenceCatalog(sha256(text), [{ assertion_id: 1, text }], sha256), sha256
  }, meter);

describe("source semantic table ownership and lowering", () => {
  it("preserves entity identity, qualification evidence, unresolved slots and affected gap identities", () => {
    const value = table([statement("event", "reads", [
      { role: "reader", target: entityRef("person") }, { role: "unknown", target: { kind: "unresolved" }, support: atom("12") }
    ], [{ role: "count", target: entityRef("quantity"), support: atom("12") }])], [
      { ...person, semantic_key: "mira" },
      { form: "entity", key: "quantity", semantic_key: "quantity", referent_kind: "ambiguous", mentions: [atom("12")] }
    ], ["event"], { gaps: [{ kind: "unresolved_referent", support: atom("12"), description: "The quantity is ambiguous",
      affected: [entityRef("quantity"), { kind: "occurrence_ref", key: "event" }] }] });
    const original = structuredClone(value), result = lower(value), draft = result.draft!;
    expect(result.outcome).toMatchObject({ status: "interpreted", gaps: draft.gaps });
    expect(draft.frames[0]!.slots.map(row => row.role_reading)).toEqual(["reader", "unknown", "count"]);
    expect(draft.frames[0]!.bindings[1]!.target).toEqual({ kind: "unresolved" });
    expect(draft.referents.map(row => row.referent_kind)).toEqual(["grouped", "ambiguous"]);
    expect(draft.gaps[0]).toMatchObject({ kind: "unresolved_referent", description: "The quantity is ambiguous",
      affected_ids: expect.arrayContaining([draft.referents[1]!.id, draft.frames[0]!.id]) });
    expect(value).toEqual(original);
  });

  it("retains all operator kinds, bound variables, same-owner reuse and source acts", () => {
    const nodes: object[] = [], roots: string[] = [];
    for (const kind of ["not", "possible", "reported", "conditional", "opaque", "forall"]) {
      const child = `${kind}Child`, base = { kind, key: kind, support: atom("Every") };
      nodes.push(statement(child, "reads", kind === "forall" ? [
        { role: "reader", target: { kind: "bound_variable", quantifier: kind }, support: atom("Mira") }
      ] : []));
      const reuse = { kind: "content_reference", key: child };
      nodes.push(kind === "conditional" ? { ...base, antecedent: ref(child), consequent: reuse }
        : kind === "opaque" ? { ...base, operands: [ref(child), reuse] }
        : kind === "reported" ? { ...base, content: ref(child), reporter: entityRef("person") }
        : kind === "forall" ? { ...base, content: ref(child), domain: "people", restriction: null }
        : { ...base, content: ref(child) });
      roots.push(kind);
    }
    const value = table(nodes, [person], roots, { domains: [domain] });
    for (const act of ["question", "directive", "unresolved"]) {
      value.content.nodes.push(statement(act));
      value.content.roots.push({ act, expression: ref(act) });
    }
    const draft = lower(value).draft!;
    expect(draft.operators.map(row => row.operator)).toEqual(["not", "possible", "reported", "conditional", "opaque", "forall"]);
    expect(draft.frames.filter(row => row.context_owner.kind === "source_act").map(row => row.context_owner))
      .toEqual(["question", "directive", "unresolved"].map(source_act => ({ kind: "source_act", source_act })));
    expect(draft.frames.filter(row => row.context_owner.kind === "operator")).toHaveLength(6);
    expect(draft.frames[5]!.bindings[0]!.target).toMatchObject({ kind: "bound_variable" });
  });

  it("retains ordinary occurrence references separately from owned nested content", () => {
    const value = table([statement("child"), statement("owner", "reads", [
      { role: "content", target: ref("child"), support: atom("reads") },
      { role: "same content", target: { kind: "content_reference", key: "child" }, support: atom("reads") }
    ]), statement("reference", "reads", [{ role: "topic", target: { kind: "occurrence_ref", key: "child" }, support: atom("reads") }])],
    [], ["owner", "reference"]);
    const draft = lower(value).draft!, [owner, child, reference] = draft.frames;
    expect(child!.context_owner).toEqual({ kind: "embedding", parent_frame: owner!.id, content_argument: child!.id });
    expect(owner!.bindings[0]!.target).toEqual(owner!.bindings[1]!.target);
    expect(reference!.bindings[0]!.target).toEqual(owner!.bindings[0]!.target);
  });

  it("preserves member, exclusion and measurement identities in their declared population", () => {
    const value = table([statement("joined", "joined"), statement("excluded", "excluded"), statement("measured", "measured")], [
      person, { form: "entity", key: "other", mentions: [atom("Oren")] }
    ], ["joined", "excluded", "measured"], {
      domains: [{ ...domain, members: [{ referent: entityRef("person"), evidence: "joined", restrictions: [] }],
        exclusions: [{ referent: entityRef("other"), evidence: "excluded" }] }],
      measurements: [{ ...measurement, owner: "measured" }]
    });
    const draft = lower(value, "Mira joined, Oren excluded and measured 12").draft!;
    expect(draft.domains![0]!.members).toHaveLength(1);
    expect(draft.domains![0]!.exclusions).toHaveLength(1);
    expect(draft.measurements![0]).toMatchObject({ subject: draft.referents[0]!.id,
      population: draft.domains![0]!.id, value: "12", metric: "headcount" });
  });

  it.each([
    ["duplicate_entity", "person", table([statement("event")], [person, person])],
    ["duplicate_occurrence", "event", table([statement("event"), statement("event")])],
    ["missing_content", "absent", table([{ kind: "not", key: "event", support: atom("Every"), content: ref("absent") }])],
    ["ambiguous_content_owner", "child", table([statement("child"),
      statement("event", "reads", [{ role: "a", target: ref("child") }, { role: "b", target: ref("child") }])])],
    ["missing_entity", "absent", table([statement("event", "reads", [{ role: "reader", target: entityRef("absent") }])])],
    ["missing_occurrence", "absent", table([statement("event", "reads", [{ role: "topic", target: { kind: "occurrence_ref", key: "absent" } }])])],
    ["wrong_quantifier_kind", "event", table([statement("event", "reads", [{ role: "reader", target: { kind: "bound_variable", quantifier: "event" } }])])],
    ["missing_reporter", "absent", table([statement("child"), { kind: "reported", key: "event",
      support: atom("Every"), content: ref("child"), reporter: entityRef("absent") }])],
    ["missing_root", "absent", table([statement("event")], [], ["absent"])],
    ["ambiguous_root_owner", "event", table([statement("event")], [], ["event", "event"])],
    ["disconnected_or_cyclic_content", "2", table([statement("event"),
      { kind: "not", key: "a", support: atom("Every"), content: ref("b") },
      { kind: "not", key: "b", support: atom("Every"), content: ref("a") }])],
    ["missing_content_reuse", "absent", table([statement("event", "reads", [{ role: "content", target: { kind: "content_reference", key: "absent" } }])])],
    ["foreign_content_reference", "child", table([statement("child"),
      statement("event", "reads", [{ role: "content", target: { kind: "content_reference", key: "child" } }])], [], ["event", "child"])],
    ["unused_entity_definition", "person", table([statement("event")], [person])],
    ["missing_gap_occurrence", "absent", table([statement("event")], [], ["event"], {
      gaps: [{ kind: "unresolved_referent", support: atom("Mira"), affected: [{ kind: "occurrence_ref", key: "absent" }] }] })],
    ["missing_gap_entity", "absent", table([statement("event")], [], ["event"], {
      gaps: [{ kind: "unresolved_referent", support: atom("Mira"), affected: [entityRef("absent")] }] })],
    ["gap_entity_requires_semantic_key", "person", table([statement("event", "reads", [{ role: "reader", target: entityRef("person") }])],
      [person], ["event"], { gaps: [{ kind: "unresolved_referent", support: atom("Mira"), affected: [entityRef("person")] }] })]
  ])("rejects %s before semantic expansion", (code, key, value) => {
    expect(() => lower(value)).toThrowError(new SourceSemanticTableValidationError(code, key));
  });

  it.each([
    ["duplicate_native_key", "event", { domains: [{ ...domain, key: "event" }] }],
    ["missing_domain_entity", "absent", { domains: [{ ...domain, members: [{ referent: entityRef("absent"), evidence: "event", restrictions: [] }] }] }],
    ["missing_measurement_subject", "absent", { domains: [domain], measurements: [{ ...measurement, subject: entityRef("absent") }] }],
    ["duplicate_native_key", "people", { domains: [domain], measurements: [{ ...measurement, key: "people" }] }],
    ["missing_occurrence", "absent", { domains: [{ ...domain, context: "absent" }] }],
    ["missing_occurrence", "absent", { domains: [{ ...domain, members: [{ referent: entityRef("person"), evidence: "event",
      restrictions: [{ restriction: "event", evidence: "absent" }] }] }] }],
    ["missing_occurrence", "absent", { domains: [{ ...domain, closure: { kind: "closed", evidence: "absent" } }] }],
    ["missing_measurement_population", "absent", { domains: [domain], measurements: [{ ...measurement, population: "absent" }] }]
  ])("rejects %s in domain and measurement references", (code, key, extra) => {
    expect(() => lower(table([statement("event")], [person], ["event"], extra)))
      .toThrowError(new SourceSemanticTableValidationError(code, key));
  });

  it("rejects undeclared quantifier domains and entity identities colliding with native keys", () => {
    expect(() => lower(table([statement("event"), quantified], [], ["all"])))
      .toThrowError(new SourceSemanticTableValidationError("missing_quantifier_domain", "people"));
    expect(() => lower(table([statement("event", "reads", [{ role: "reader", target: entityRef("person") }])],
      [{ ...person, semantic_key: "event" }])))
      .toThrowError(new SourceSemanticTableValidationError("duplicate_native_key", "event"));
  });

  it("rejects combined argument overflow and excess native occurrences", () => {
    const args = Array.from({ length: 8 }, (_, index) => ({ role: `role${index}`, target: { kind: "unresolved" }, support: atom("reads") }));
    expect(() => lower(table([statement("event", "reads", args, [args[0]!])])))
      .toThrowError(new SourceSemanticTableValidationError("argument_capacity_exceeded", "event"));
    const nodes = Array.from({ length: 257 }, (_, index) => statement(`event${index}`));
    expect(() => lower(table(nodes, [], ["event0"])))
      .toThrowError(new SourceSemanticTableValidationError("native_occurrence_capacity_exceeded", "event256"));
  });

  it("bounds ownership depth before recursive expansion and keeps resource exhaustion distinct", () => {
    const nodes = [statement("event"), ...Array.from({ length: 17 }, (_, index) => ({ kind: "possible", key: `wrap${index}`,
      support: atom("Every"), content: ref(index === 0 ? "event" : `wrap${index - 1}`) }))];
    expect(() => lower(table(nodes, [], ["wrap16"]))).toThrow(/expression_depth_exceeded/u);
    expect(lower(table(nodes.slice(0, -1), [], ["wrap15"])).draft!.operators).toHaveLength(16);
    expect(() => lower(table([statement("event")]), undefined,
      new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1 }))).toThrow(SourceSemanticResourceExhausted);
  });

  it("preserves negative producer dispositions while refusing host state and content claims", () => {
    expect(lower({ contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status: "abstained" } }))
      .toEqual({ contract: "source-interpretation-response-v5", outcome: { status: "abstained" } });
    const context = lower({ contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
      outcome: { status: "no_executable_proposition", description: "A heading", context_support: [atom("Notes")] } }, "Notes");
    expect(context.outcome).toMatchObject({ status: "no_executable_proposition", context_support: [
      { kind: "source_reference", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }
    ] });
    for (const status of ["transport_failure", "resource_exhausted", "no_eligible_source"]) {
      expect(() => lower({ contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status } }))
        .toThrowError(new SourceSemanticTableValidationError("host_only_outcome", "producer"));
    }
    expect(() => lower({ contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" } }))
      .toThrowError(new SourceSemanticTableValidationError("outcome_content_mismatch", "producer"));
    expect(() => lower({ ...table([statement("event")]), outcome: { status: "abstained" } }))
      .toThrowError(new SourceSemanticTableValidationError("outcome_content_mismatch", "producer"));
  });
});
