import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { materializeSourceSemanticTableProposal, sourceSemanticEvidenceClosure,
  SourceSemanticResourceLedger, type SourceSemanticInterpretation,
  SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, SourceSemanticResourceExhausted,
  SourceSemanticTableValidationError } from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest, semanticSha256, sourceSemanticRequestCatalog,
  sourceSemanticResponseJsonSchema, sourceSemanticSystemPrompt, SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT } from
  "../../../garden/ingestion/official-api/source-semantic-request.js";
import { receiveSourceSemantics } from
  "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { prepareSourceSemanticRevision } from
  "../../../garden/ingestion/official-api/source-semantic-revision.js";
import { indexSourceSemanticUnits } from "../../../garden/ingestion/official-api/source-semantic-units.js";
import { SOURCE_SEMANTIC_TABLE_EXAMPLE, SOURCE_SEMANTIC_RELATION_EXAMPLE } from
  "../../../garden/ingestion/official-api/source-semantic-table-guidance.js";
import { SOURCE_SEMANTIC_PRESERVATION_GUIDANCE, SOURCE_SEMANTIC_OPERATOR_GUIDANCE,
  SOURCE_SEMANTIC_SCOPE_GUIDANCE, SOURCE_SEMANTIC_DOMAIN_GUIDANCE,
  SOURCE_SEMANTIC_ATTRIBUTION_GUIDANCE } from
  "../../../garden/ingestion/official-api/source-semantic-shared-guidance.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (file: string) => JSON.parse(readFileSync(path.join(here, "fixtures/source-semantic-table", file), "utf8"));
const originals = {
  "dated-approval-source": "Noor approved the Cedar pilot for 22 September 2026 only. I don't know whether anyone has approved the Cedar pilot for 24 September 2026.",
  "reported-denial-source": 'Mira said, "I did not approve the copper order."',
  "denied-report-source": 'Mira did not say, "I approved the copper order."',
  "report-time-source": 'On 8 June 2026, Mira told me, "Oren inspected the valve on 6 June 2026."'
} as const;
const atom = (text: string, assertion_id = 1, occurrence?: number) =>
  ({ text, assertion_id, ...(occurrence === undefined ? {} : { occurrence }) });
const entityRef = (key: string) => ({ kind: "entity_ref", key });
const contentRef = (key: string) => ({ kind: "content_ref", key });
const occurrenceRef = (key: string) => ({ kind: "occurrence_ref", key });
const statement = (key: string, reading: string, arguments_: object[] = []) => ({ kind: "statement", key,
  predicate: { kind: "explicit", reading, support: atom(reading) }, arguments: arguments_, qualifications: [] });
const table = <N extends object, E extends object = object, G extends object = object>(nodes: N[],
  entities: E[] = [], roots: string[] = ["event"], gaps: G[] = []) => ({
  contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" },
  content: { roots: roots.map(key => ({ act: "assertion", expression: contentRef(key) })), entities, nodes, gaps }
});

function closure(h: SourceSemanticInterpretation, id: string) {
  const ids = sourceSemanticEvidenceClosure(h, [id],
    new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 }));
  return h.mentions.filter(m => ids.has(m.id)).map(m => m.text);
}

describe.each([undefined, SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT] as const)("finite source table receive with view %s", (generationViewContract) => {
  function setup(text: string) {
    const sourceCorpus = `User: ${text}`;
    const input = { sourceCorpus, assertionIds: indexSourceSemanticUnits(sourceCorpus).map(row => row.assertion_id),
      sourceScope: "complete-source" as const, source_id: "unbound", source_version: "unbound",
      ...(generationViewContract === undefined ? {} : { generationViewContract }),
      producer_id: "official-api-source-semantic", producer_version: "1" };
    const request = buildSourceSemanticRequest(input);
    return { input, request };
  }

  function receiveTable(text: string, value: unknown, resource_limits?: { output_byte_limit?: number; work_units?: number; memory_bytes?: number }) {
    const prepared = setup(text);
    const input = resource_limits === undefined ? prepared.input : { ...prepared.input, resource_limits };
    return receiveSourceSemantics(JSON.stringify(value),
      resource_limits === undefined ? prepared.request : buildSourceSemanticRequest(input), input);
  }

  for (const [id, text] of Object.entries(originals)) it(`preserves the complete ${id} graph and evidence closure`, () => {
    const { input, request } = setup(text);
    const table = fixture(`${id}-conformed.json`);
    const result = receiveSourceSemantics(JSON.stringify({ ...table.wire,
      contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT }), request, input);
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("interpreted");
    const h = result.interpretation!;
    expect(h).toEqual(table.interpretation);
    expect(h.source.attribution_context?.status).toBe("unknown");
    expect(h.mentions.some(m => m.text === "Avery")).toBe(false);
    const top = [...h.frames, ...h.operators].filter(row => row.context_owner.kind === "source_act");
    if (id === "dated-approval-source") {
      const approvals = h.frames.filter(row => row.predicate_support.reading === "approve");
      expect(top).toHaveLength(2);
      expect(closure(h, approvals[0]!.id)).toContain("for 22 September 2026 only");
      expect(closure(h, approvals[0]!.id)).not.toContain("anyone");
      expect(h.asserted_at_scope).not.toContain(approvals[1]!.id);
      expect(h.gaps[0]!.affected_ids).toContain(approvals[1]!.id);
    } else if (id === "reported-denial-source") {
      expect(top).toHaveLength(1);
      expect(h.frames[0]!.predicate_support.reading).toBe("say");
      expect(h.operators[0]!.context_owner.kind).toBe("embedding");
      expect(h.asserted_at_scope).not.toContain(h.frames[1]!.id);
      expect(closure(h, h.frames[1]!.id)).toEqual(expect.arrayContaining(["Mira", "I", "did not", "approve"]));
    } else if (id === "denied-report-source") {
      expect(top).toHaveLength(1);
      expect(h.operators[0]!.operator).toBe("not");
      expect(h.asserted_at_scope).not.toContain(h.frames[0]!.id);
      expect(h.asserted_at_scope).not.toContain(h.frames[1]!.id);
    } else {
      expect(top).toHaveLength(1);
      const inspection = h.frames.find(row => row.predicate_support.reading === "inspect")!;
      expect(inspection.context_owner.kind).toBe("embedding");
      expect(h.asserted_at_scope).not.toContain(inspection.id);
      expect(closure(h, inspection.id)).toEqual(expect.arrayContaining(["8 June 2026", "6 June 2026"]));
    }
  });

  it("uses shared semantic guidance and admits the neutral table example", () => {
    const text = "The permit is valid on Tuesday only. The clerk does not know whether the permit is valid on Thursday.";
    const { input, request } = setup(text);
    const prompt = sourceSemanticSystemPrompt(request);
    for (const guidance of [SOURCE_SEMANTIC_PRESERVATION_GUIDANCE, SOURCE_SEMANTIC_OPERATOR_GUIDANCE,
      SOURCE_SEMANTIC_SCOPE_GUIDANCE, SOURCE_SEMANTIC_DOMAIN_GUIDANCE, SOURCE_SEMANTIC_ATTRIBUTION_GUIDANCE]) {
      expect(prompt).toContain(guidance);
    }
    expect(JSON.parse(prompt.split("Example response:\n")[1]!)).toEqual(SOURCE_SEMANTIC_TABLE_EXAMPLE);
    const current = receiveSourceSemantics(JSON.stringify(SOURCE_SEMANTIC_TABLE_EXAMPLE), request, input);
    expect(current.outcome.status).toBe("interpreted");
    expect(current.interpretation!.frames.map(row => row.predicate_support.reading))
      .toEqual(["valid", "know whether", "valid"]);
    expect(current.interpretation!.asserted_at_scope).toHaveLength(2);
    expect(current.interpretation!.gaps).toEqual([]);
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(request))).toContain("source-semantic-proposal-v8");
  });

  it("preserves property values and non-assertive acts without inventing transport speech events", () => {
    const text = "The panel's color is amber. Please move it to bay D.\n\nAssistant: Is the panel's color amber?";
    const { input, request } = setup(text);
    expect(sourceSemanticSystemPrompt(request)).toContain(JSON.stringify(SOURCE_SEMANTIC_RELATION_EXAMPLE));
    const result = receiveSourceSemantics(JSON.stringify(SOURCE_SEMANTIC_RELATION_EXAMPLE), request, input);
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("interpreted");
    const h = result.interpretation!;
    expect(h.frames.map(frame => frame.predicate_support.reading)).toEqual(["has color", "move", "has color"]);
    expect(h.frames.map(frame => frame.context_owner)).toEqual([
      { kind: "source_act", source_act: "assertion" },
      { kind: "source_act", source_act: "directive" },
      { kind: "source_act", source_act: "question" }
    ]);
    expect(h.asserted_at_scope).toEqual([h.frames[0]!.id]);
    expect(h.operators).toEqual([]);
    expect(h.gaps).toEqual([]);
    const color = h.frames[0]!, move = h.frames[1]!, askedColor = h.frames[2]!;
    expect(color.slots.map(slot => slot.role_reading)).toEqual(["bearer", "color value"]);
    expect(move.slots.map(slot => slot.role_reading)).toEqual(["object moved", "destination"]);
    expect(color.bindings).toEqual(askedColor.bindings);
    expect(color.bindings[0]!.target).toEqual(move.bindings[0]!.target);
    expect(closure(h, color.id)).toEqual(expect.arrayContaining(["panel", "amber", "color is"]));
    expect(closure(h, move.id)).toEqual(expect.arrayContaining(["it", "bay D", "move"]));
    expect(h.mentions.some(mention => mention.text === "User" || mention.text === "Assistant")).toBe(false);
  });

  it("rejects every gap-only shared alias and validates each materialized alias", () => {
    const text = "Mira approved pilot and she hesitated";
    const base = table([statement("event", "approved", [{ role: "agent", target: entityRef("used") }])],
      [{ form: "entity", key: "used", semantic_key: "person", mentions: [atom("Mira")] }], ["event"],
      [{ kind: "unresolved_referent", support: atom("hesitated"), affected: [entityRef("gapAlias")] }]);
    for (const [mention, referentKind] of [["she", undefined], ["NONEXISTENT", undefined],
      ["she", "ambiguous"]] as const) {
      const candidate = structuredClone(base);
      candidate.content.entities.push({ form: "entity", key: "gapAlias", semantic_key: "person",
        mentions: [atom(mention)], ...(referentKind === undefined ? {} : { referent_kind: referentKind }) });
      const unused = receiveTable(text, candidate);
      expect(unused.outcome.status).toBe("invalid");
      expect(JSON.stringify(unused.outcome)).toContain("unused_entity_definition: gapAlias");
      candidate.content.nodes[0]!.arguments.push({ role: "actor", target: entityRef("gapAlias") });
      const materialized = receiveTable(text, candidate);
      if (mention === "NONEXISTENT") expect(JSON.stringify(materialized.outcome)).toContain("source_selection_absent");
      else if (referentKind === "ambiguous") expect(JSON.stringify(materialized.outcome)).toContain("conflicting_referent_kind");
      else {
        expect(materialized.outcome.status).toBe("interpreted");
        const h = materialized.interpretation!;
        expect(h.referents).toHaveLength(1);
        expect(h.mentions.filter(row => h.referents[0]!.mentions.includes(row.id)).map(row => row.text)).toEqual(["Mira", "she"]);
        expect(h.gaps[0]!.affected_ids).toContain(h.referents[0]!.id);
      }
    }
    const combined = structuredClone(base);
    combined.content.entities[0]!.mentions.push(atom("she"));
    combined.content.gaps[0]!.affected = [entityRef("used")];
    const lawful = receiveTable(text, combined);
    expect(lawful.outcome.status).toBe("interpreted");
    expect(lawful.interpretation!.mentions.filter(row => lawful.interpretation!.referents[0]!.mentions.includes(row.id))
      .map(row => row.text)).toEqual(["Mira", "she"]);
  });

  it("materializes reporter, domain member, exclusion and measurement subject rows", () => {
    const reported = table([statement("event", "event"), { kind: "reported", key: "report", support: atom("reported"),
      reporter: entityRef("speaker"), content: contentRef("event") }],
    [{ form: "selection", key: "speaker", semantic_key: "person", selection: atom("Mira") }], ["report"]);
    expect(receiveTable("Mira reported event", reported).outcome.status).toBe("interpreted");
    const domainBase = table([statement("joined", "joined"), statement("excluded", "excluded"),
      statement("measured", "measured")], [
      { form: "entity", key: "member", semantic_key: "mira", mentions: [atom("Mira")] },
      { form: "entity", key: "excluded", semantic_key: "oren", mentions: [atom("Oren")] }
    ], ["joined", "excluded", "measured"]);
    const domain = { ...domainBase, content: { ...domainBase.content,
      domains: [{ key: "people", context: null, support: atom("Mira"),
        members: [{ referent: entityRef("member"), evidence: "joined", restrictions: [] }],
        exclusions: [{ referent: entityRef("excluded"), evidence: "excluded" }], closure: { kind: "open" } }],
      measurements: [{ key: "count", subject: entityRef("member"), owner: "measured",
        population: "people", metric: "headcount", unit: "person", context: "observed",
        value: "12", support: atom("12") }] } };
    const text = "Mira joined, Oren excluded and measured 12";
    const received = receiveTable(text, domain);
    expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
    expect(received.interpretation!.domains![0]!.members).toHaveLength(1);
    expect(received.interpretation!.domains![0]!.exclusions).toHaveLength(1);
    expect(received.interpretation!.measurements).toHaveLength(1);
    const domainOnly = structuredClone(domain);
    domainOnly.content.measurements = [];
    expect(receiveTable(text, domainOnly).outcome.status).toBe("interpreted");
    const measurementOnly = structuredClone(domain);
    measurementOnly.content.domains[0]!.members = [];
    measurementOnly.content.domains[0]!.exclusions = [];
    measurementOnly.content.entities.pop();
    expect(receiveTable(text, measurementOnly).outcome.status).toBe("interpreted");
  });

  it("preserves ordinary references, same-parent content reuse and exact Unicode selections", () => {
    const text = "李明检查了铜阀。 李明讨论检查。";
    const inspection = statement("inspection", "检查", [{ role: "inspector", target: entityRef("person") },
      { role: "object", target: entityRef("valve") }]);
    const discussion = statement("discussion", "讨论", [{ role: "topic", target: occurrenceRef("inspection"), support: atom("检查", 2) }]);
    discussion.predicate.support = atom("讨论", 2);
    const value = table([inspection, discussion], [
      { form: "selection", key: "person", selection: atom("李明") },
      { form: "selection", key: "valve", selection: atom("铜阀") }
    ], ["inspection", "discussion"]);
    const received = receiveTable(text, value);
    expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
    expect(received.interpretation!.mentions.map(row => row.text)).toEqual(expect.arrayContaining(["李明", "检查", "铜阀", "讨论"]));
    const nested = table([statement("inspection", "检查"),
      statement("event", "讨论", [{ role: "content", target: contentRef("inspection"), support: atom("检查", 2) },
        { role: "same content", target: { kind: "content_reference", key: "inspection" }, support: atom("检查", 2) }])],
      [], ["event"]);
    nested.content.nodes[1]!.predicate.support = atom("讨论", 2);
    expect(receiveTable(text, nested).outcome.status).toBe("interpreted");
  });

  it("keeps malformed, exhausted, abstained and oversized responses separate", () => {
    const text = "Mira approved pilot";
    const value = table([statement("event", "approved")]);
    const { input, request } = setup(text);
    expect(receiveSourceSemantics("{", request, input).outcome).toEqual({ status: "invalid", reason: "malformed_json" });
    expect(receiveTable(text, { contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
      outcome: { status: "abstained" } }).outcome).toEqual({ status: "abstained" });
    expect(receiveTable(text, value, { work_units: 1, memory_bytes: 1 }).outcome).toEqual({ status: "resource_exhausted" });
    const limitedInput = { ...input, resource_limits: { output_byte_limit: 1024 } };
    const limited = buildSourceSemanticRequest(limitedInput);
    expect(receiveSourceSemantics(JSON.stringify(value) + " ".repeat(1024), limited, limitedInput).outcome).toEqual({ status: "truncated" });
  });

  it.each([
    { status: "abstained" }, { status: "invalid", reason: "unsupported reading" },
    { status: "quarantine", reason: "uncertain source" }, { status: "truncated" },
    { status: "transport_failure" }, { status: "resource_exhausted" }
  ])("preserves producer disposition $status without changing its meaning", (outcome) => {
    expect(receiveTable("Mira approved pilot", { contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome }).outcome).toEqual(outcome);
  });

  it.each([
    { status: "no_eligible_source", provider_attempts: 0 }, { status: "unavailable", reason: "provider absent" },
    { status: "unexercised" }, { status: "preparation_required", missing: "query_semantics" }
  ])("rejects producer claims to host-only state $status", (outcome) => {
    expect(receiveTable("Mira approved pilot", { contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome }).outcome.status).toBe("invalid");
  });

  it("reaches every operator and root act through production receive", () => {
    const nodes: object[] = [], roots: string[] = [];
    for (const kind of ["not", "possible", "reported", "conditional", "opaque", "forall"]) {
      const child = `${kind}Child`;
      nodes.push(statement(child, "reads", kind === "forall" ? [{ role: "reader",
        target: { kind: "bound_variable", quantifier: kind }, support: atom("visitor") }] : []));
      const base = { kind, key: kind, support: atom("Every") };
      const reuse = { kind: "content_reference", key: child };
      const operator = kind === "conditional" ? { ...base, antecedent: contentRef(child), consequent: reuse }
        : kind === "opaque" ? { ...base, operands: [contentRef(child), reuse] }
        : kind === "reported" ? { ...base, content: contentRef(child), reporter: entityRef("speaker") }
        : kind === "forall" ? { ...base, content: contentRef(child), domain: "people", restriction: null }
        : { ...base, content: contentRef(child) };
      nodes.push(operator); roots.push(kind);
    }
    const base = table(nodes, [{ form: "entity", key: "speaker", semantic_key: "person",
      mentions: [atom("visitor")] }], roots);
    for (const act of ["question", "directive", "unresolved"]) {
      base.content.nodes.push(statement(act, "reads"));
      base.content.roots.push({ act, expression: contentRef(act) });
    }
    const wire = { ...base, content: { ...base.content,
      domains: [{ key: "people", context: null, support: atom("visitor"),
        members: [], exclusions: [], closure: { kind: "open" } }],
      measurements: [{ key: "count", subject: entityRef("speaker"), owner: "forall",
        population: "people", metric: "headcount", unit: "person", context: "stated", value: "12", support: atom("12") }] } };
    const result = receiveTable("Every visitor reads 12", wire);
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("interpreted");
    const h = result.interpretation!;
    expect(h.operators.map(row => row.operator)).toEqual(["not", "possible", "reported", "conditional", "opaque", "forall"]);
    expect(h.asserted_at_scope).toHaveLength(6);
    expect(h.frames.flatMap(row => row.context_owner.kind === "source_act" ? [row.context_owner.source_act] : []))
      .toEqual(["question", "directive", "unresolved"]);
    expect(h.measurements![0]!.subject).toBe(h.referents[0]!.id);
  });

  it("rejects duplicate ownership, disconnected cycles, foreign reuse and depth overflow", () => {
    const base = table([statement("approval", "approved")], [], ["approval"]);
    const duplicate = structuredClone(base);
    duplicate.content.roots.push(duplicate.content.roots[0]!);
    expect(JSON.stringify(receiveTable("Mira approved pilot", duplicate).outcome)).toContain("ambiguous_root_owner");
    const cycle = table([...base.content.nodes,
      { kind: "not", key: "cycleA", support: atom("approved"), content: contentRef("cycleB") },
      { kind: "not", key: "cycleB", support: atom("approved"), content: contentRef("cycleA") }], [], ["approval"]);
    expect(JSON.stringify(receiveTable("Mira approved pilot", cycle).outcome)).toContain("disconnected_or_cyclic_content");
    const foreign = table([statement("child", "approved"), statement("parent", "approved",
      [{ role: "content", target: contentRef("child") }]), statement("other", "approved",
      [{ role: "content", target: { kind: "content_reference", key: "child" } }])], [], ["parent", "other"]);
    expect(JSON.stringify(receiveTable("Mira approved pilot", foreign).outcome)).toContain("foreign_content_reference");
    const depth = table([statement("approval", "approved"),
      ...Array.from({ length: 17 }, (_, i) => ({ kind: "possible", key: `wrap${i}`,
        support: atom("approved"), content: contentRef(i ? `wrap${i - 1}` : "approval") }))], [], ["wrap16"]);
    expect(JSON.stringify(receiveTable("Mira approved pilot", depth).outcome)).toContain("expression_depth_exceeded");
    const withinDepth = table(depth.content.nodes.slice(0, -1), [], ["wrap15"]);
    expect(receiveTable("Mira approved pilot", withinDepth).interpretation!.operators).toHaveLength(16);
  });

  it("keeps no-executable, host-only, missing-content and exact-selection failures distinct", () => {
    const text = "Mira saw Mira";
    const context = { contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
      outcome: { status: "no_executable_proposition", description: "Context only", context_support: [atom("Mira", 1, 0)] } };
    expect(receiveTable(text, context).outcome.status).toBe("no_executable_proposition");
    expect(receiveTable(text, { contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
      outcome: { status: "no_eligible_source" } }).outcome.status).toBe("invalid");
    expect(JSON.stringify(receiveTable(text, { contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT,
      outcome: { status: "interpreted" } }).outcome)).toContain("outcome_content_mismatch");
    const value = table([statement("seeing", "saw", [{ role: "agent", target: entityRef("person") }])],
      [{ form: "selection", key: "person", selection: atom("Mira") }], ["seeing"]);
    expect(JSON.stringify(receiveTable(text, value).outcome)).toContain("source_selection_ambiguous");
    value.content.entities[0]!.selection = atom("Mira", 1, 1);
    expect(receiveTable(text, value).outcome.status).toBe("interpreted");
    value.content.entities[0]!.selection = atom("ira");
    expect(receiveTable(text, value).outcome.status).toBe("invalid");
  });

  it("charges table expansion and normalization against one remaining ledger", () => {
    const text = "Mira approved pilot";
    const value = table([statement("approval", "approved")], [], ["approval"]);
    const { request } = setup(text);
    const ledger = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
    const envelope = materializeSourceSemanticTableProposal(value,
      { catalog: sourceSemanticRequestCatalog(request), sha256: semanticSha256 }, ledger);
    expect(envelope.outcome.status).toBe("interpreted");
    expect(receiveTable(text, value, { work_units: ledger.spentWork + 100,
      memory_bytes: ledger.spentBytes + 1000 }).outcome.status).toBe("resource_exhausted");
    const repeated = `met ${Array.from({ length: 64 }, () => "Mira").join(" ")}`;
    const nodes = Array.from({ length: 64 }, (_, i) => statement(`event${i}`, "met",
      Array.from({ length: 8 }, (_, j) => ({ role: `participant${j}`, target: entityRef("person") }))));
    const large = table(nodes, [{ form: "entity", key: "person", semantic_key: "person",
      mentions: Array.from({ length: 64 }, (_, i) => atom("Mira", 1, i)) }], nodes.map(row => row.key));
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(2000000);
    expect(receiveTable(repeated, large, { work_units: 200000, memory_bytes: 2000000 }).outcome.status)
      .toBe("resource_exhausted");
  });

  it("keeps table repair diagnostics separate from resource exhaustion in exported revision preparation", () => {
    const text = `met ${Array.from({ length: 64 }, () => "Mira").join(" ")}`;
    const { input, request } = setup(text);
    const valid = table([statement("event", "met", [{ role: "agent", target: entityRef("person") }])],
      [{ form: "entity", key: "person", semantic_key: "person", mentions: [atom("Mira", 1, 0)] }]);
    const invalid = structuredClone(valid);
    invalid.content.nodes[0]!.arguments[0] = { role: "agent", target: entityRef("absent") };
    expect(receiveSourceSemantics(JSON.stringify(valid), request, input).outcome.status).toBe("interpreted");
    expect(receiveSourceSemantics(JSON.stringify(invalid), request, input).outcome.status).toBe("invalid");
    expect(() => materializeSourceSemanticTableProposal(invalid,
      { catalog: sourceSemanticRequestCatalog(request), sha256: semanticSha256 }))
      .toThrow(SourceSemanticTableValidationError);
    const revision = prepareSourceSemanticRevision(request, JSON.stringify(invalid), [],
      { responseCompletion: "complete" });
    expect(revision.structural_diagnostics).toEqual([{
      code: "invalid_table_proposal", path: [], message: "missing_entity: absent"
    }]);
    const revisedRequest = buildSourceSemanticRequest({ ...input, revision });
    expect(receiveSourceSemantics(JSON.stringify(valid), revisedRequest, input).outcome.status).toBe("interpreted");

    const nodes = Array.from({ length: 16 }, (_, i) => statement(`event${i}`, "met",
      Array.from({ length: 8 }, (_, j) => ({ role: `participant${j}`, target: entityRef("person") }))));
    const expensive = table(nodes, [{ form: "entity", key: "person", semantic_key: "person",
      mentions: Array.from({ length: 64 }, (_, i) => atom("Mira", 1, i)) }], nodes.map(node => node.key));
    const raw = JSON.stringify(expensive);
    expect(receiveSourceSemantics(raw, request, input).outcome.status).toBe("resource_exhausted");
    expect(() => prepareSourceSemanticRevision(request, raw, [], { responseCompletion: "complete" }))
      .toThrow(SourceSemanticResourceExhausted);
  });
});
