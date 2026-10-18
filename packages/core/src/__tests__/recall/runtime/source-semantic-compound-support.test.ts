import { afterAll, expect, it, vi } from "vitest";

// Reuse the native authored-control restrictions before importing any runtime owner.
const isolation = await vi.hoisted(async () => {
  const [{ default: http }, { default: https }, { default: net }, { default: tls },
    { default: http2 }, { default: dgram }, { default: fs }, { default: fsp }, { syncBuiltinESMExports }] =
    await Promise.all([import("node:http"), import("node:https"), import("node:net"), import("node:tls"),
      import("node:http2"), import("node:dgram"), import("node:fs"), import("node:fs/promises"), import("node:module")]);
  const forbidden: string[] = [], restores: (() => void)[] = [];
  function block(owner: object, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)!;
    Object.defineProperty(owner, key, { ...descriptor, value: () => {
      forbidden.push(key); throw new Error(`Network access forbidden in authored core control: ${key}`);
    } });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  for (const owner of [http, https]) for (const key of ["request", "get"]) block(owner, key);
  for (const key of ["connect", "createConnection"]) block(net, key);
  block(net.Socket.prototype, "connect"); block(tls, "connect"); block(http2, "connect");
  block(dgram, "createSocket"); block(globalThis, "fetch");
  const environment = process.env;
  process.env = new Proxy(environment, { get(target, key) {
    if (typeof key === "string" && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)) {
      forbidden.push("credential environment read"); throw new Error("Credential environment reads forbidden");
    }
    return Reflect.get(target, key);
  } });
  restores.push(() => { process.env = environment; });
  for (const owner of [fs, fsp]) for (const key of ["readFile", "readFileSync", "open", "openSync", "createReadStream"]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor?.value === undefined) continue;
    Object.defineProperty(owner, key, { ...descriptor, value: new Proxy(descriptor.value, {
      apply(target, receiver, args) {
        if (/(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.aws|\.azure|credentials(?:\.json)?|auth\.json)(?:$|[/\\])/iu.test(String(args[0]))) {
          forbidden.push("credential file read"); throw new Error("Credential file reads forbidden");
        }
        return Reflect.apply(target, receiver, args);
      }
    }) });
    restores.push(() => Object.defineProperty(owner, key, descriptor));
  }
  syncBuiltinESMExports();
  return { forbidden, restore: () => { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); } };
});

import { type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticCorrespondence,
  type SourceSemanticReasoningResult, sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity, sourceSemanticCorrespondenceIdentity } from "@do-soul/alaya-protocol";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { executeSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { source, query, correspondenceFor, deliveredProofFixture, CLOCK, BUDGET } from "./source-semantic-proof-fixture.js";

afterAll(() => { try { expect(isolation.forbidden).toEqual([]); } finally { isolation.restore(); } });

type Fact = Readonly<{ id: string; predicate: string; subject: string; positive: boolean; sentence?: string }>;
type Input = Readonly<{ interpretation: SourceSemanticInterpretation; semantics: SourceSemanticQuery;
  correspondence: SourceSemanticCorrespondence; original: string }>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// These are direct-Core authored premises, not authenticated or published H.
// Referents are distinct by stipulation; the vocabulary and rule meanings are inputs.
function authoredSource(id: string, subjects: readonly string[], facts: readonly Fact[], definition: string): SourceSemanticInterpretation {
  const base = source(), mentions: SourceSemanticInterpretation["mentions"][number][] = [];
  let text = `${definition}\n${subjects.join(", ")}.\n`;
  for (const subject of subjects) {
    const start = Buffer.byteLength(text.slice(0, text.indexOf(subject)));
    mentions.push({ id: `m${subject}`, assertion_id: 1, text: subject, utf8_span: [start, start + subject.length],
      source_ref: { first: "a1s0", last: "a1s0" } });
  }
  const frames: SourceSemanticInterpretation["frames"][number][] = [];
  const operators: SourceSemanticInterpretation["operators"][number][] = [];
  const roots: string[] = [];
  for (const fact of facts) {
    const sentence = fact.sentence ?? `${fact.subject}: ${fact.positive ? "" : "not "}${fact.predicate}.`;
    const start = Buffer.byteLength(text) + sentence.lastIndexOf(fact.predicate);
    mentions.push({ id: `m${fact.id}`, assertion_id: 1, text: fact.predicate, utf8_span: [start, start + fact.predicate.length],
      source_ref: { first: "a1s0", last: "a1s0" } });
    text += `${sentence}\n`;
    frames.push({ id: fact.id, assertion_ids: [1], additional_support: [],
      context_owner: fact.positive ? { kind: "source_act", source_act: "assertion" } : { kind: "operator", operator_handle: `not${fact.id}` },
      predicate_support: { kind: "explicit", reading: fact.predicate, mentions: [`m${fact.id}`] },
      slots: [{ id: "parcel", role_reading: "parcel", support: [] }],
      bindings: [{ slot_id: "parcel", target: { kind: "node", id: `r${fact.subject}` }, support: [] }] });
    if (!fact.positive) operators.push({ id: `not${fact.id}`, operator: "not", content: fact.id, assertion_ids: [1],
      additional_support: [], context_owner: { kind: "source_act", source_act: "assertion" } });
    roots.push(fact.positive ? fact.id : `not${fact.id}`);
  }
  return { ...base, source: { ...base.source, source_id: id, content_digest: `sha256:${sha(text)}` }, mentions,
    referents: subjects.map(subject => ({ id: `r${subject}`, referent_kind: "grouped", mentions: [`m${subject}`] })),
    frames, operators, entry_roots: roots, asserted_at_scope: roots };
}

function authoredQuery(original: string, predicates: readonly string[], entailed = false, negative = false): SourceSemanticQuery {
  const base = query(original, false);
  const frames: SourceSemanticQuery["alternatives"][number]["frames"][number][] = predicates.map(predicate => ({
    id: `q${predicate}`, variable: `v${predicate}`, predicate_reading: predicate,
    role_requirements: [{ id: "parcel", role_reading: "parcel", target_variable: "parcel",
      support: { kind: "query_text", excerpt: "parcel" } }] }));
  const variables: SourceSemanticQuery["variables"][number][] = [{ id: "parcel", sort: "entity" },
    ...frames.map(frame => ({ id: frame.variable, sort: "proposition" as const }))];
  if (negative) {
    variables.push({ id: "negative", sort: "context" });
    frames.unshift({ id: "qNot", variable: "negative", predicate_reading: "not", operator: "not", role_requirements: [] });
  }
  return { ...base, variables, alternatives: [{ frames, context_obligations: negative
    ? [{ frame: "qNot", kind: entailed ? "entailed_at_source" : "asserted_at_source" },
      { frame: frames[1]!.id, kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qNot", role: "content" } }]
    : frames.map(frame => ({ frame: frame.id, kind: entailed ? "entailed_at_source" : "asserted_at_source" })) }],
    return_variables: ["parcel"], gaps: [] };
}

function authoredInput(interpretation: SourceSemanticInterpretation, original: string, predicates: readonly string[], entailed = false, negative = false): Input {
  const semantics = authoredQuery(original, predicates, entailed, negative);
  const base = correspondenceFor(interpretation, semantics, false);
  const correspondences: SourceSemanticCorrespondence["correspondences"][number][] = [];
  // Exact equality is justified only by this stipulated toy vocabulary, not a language matcher.
  // No P endpoint exists in atomic-only H; do not invent P=A or P=B to fill that obligation.
  for (const qFrame of semantics.alternatives[0]!.frames.filter(frame => frame.operator === undefined)) {
    for (const frame of interpretation.frames.filter(row => row.predicate_support.reading === qFrame.predicate_reading)) {
      if (frame.predicate_support.kind !== "explicit") throw new Error("Authored vocabulary requires explicit support");
      correspondences.push({ relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: qFrame.id },
        source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: qFrame.predicate_reading },
        source_semantic_support: [{ kind: "lexical", mentions: frame.predicate_support.mentions }] },
      { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: qFrame.id, slot: "parcel" },
        source_endpoint: { kind: "slot", frame: frame.id, slot: "parcel" }, query_support: { kind: "query_text", excerpt: "parcel" },
        source_semantic_support: [] });
    }
  }
  return freeze({ interpretation, semantics, original, correspondence: { ...base, correspondences,
    source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, sha), query_semantics_id: sourceSemanticQueryIdentity(semantics, sha) } });
}

function execute(input: Input) {
  expect(admitSourceSemanticCorrespondence({ source_interpretation: input.interpretation, query_semantics: input.semantics,
    semantic_correspondence: input.correspondence, original_query: input.original }).kind).toBe("admitted");
  return executeSourceSemanticInterpretation({ source_interpretation: input.interpretation, query_semantics: input.semantics,
    semantic_correspondence: input.correspondence, original_query: input.original, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
    request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: input.correspondence.source_interpretation_id, query_semantics_id: input.correspondence.query_semantics_id,
      semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(input.correspondence, sha), original_query: input.original, budget: BUDGET, output_byte_limit: 1_000_000 } });
}

function returned(result: SourceSemanticReasoningResult): string[] {
  expect(result.outcome.status).toBe("interpreted");
  expect(result).toMatchObject({ semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation", world_claim: "unknown" });
  expect(result.binding_results?.every(row => row.kind === "answer" && row.query_complete)).toBe(true);
  return result.binding_results!.map(row => row.returned.parcel!.node_id).sort();
}

function consumedPredicates(input: Input, result: SourceSemanticReasoningResult) {
  return result.consumed_leaves.filter(leaf => leaf.leaf_kind === "semantic_correspondence_predicate").map(leaf =>
    input.correspondence.correspondences[leaf.correspondence_index!]!.query_endpoint).filter(endpoint => endpoint.kind === "predicate").map(endpoint => endpoint.frame);
}

it("aligns faithful compound and atomic readings but leaves an absent compound endpoint explicitly unqualified", () => {
  // Independent complete assignments: P is A AND B, never A or B alone.
  const assignments = freeze([
    { subject: "Both", A: true, B: true, P: true }, { subject: "AOnly", A: true, B: false, P: false },
    { subject: "BOnly", A: false, B: true, P: false }, { subject: "Neither", A: false, B: false, P: false }
  ]);
  const facts = assignments.flatMap(row => (["A", "B", "P"] as const).map(predicate =>
    ({ id: `${predicate}${row.subject}`, subject: row.subject, predicate, positive: row[predicate] })));
  const definition = "P means A AND B. The following parcels are distinct and all four assignments are complete.";
  const compoundH = authoredSource("compound-parcels", assignments.map(row => row.subject), facts, definition);
  const atomicH = authoredSource("atomic-parcels", assignments.map(row => row.subject), facts.filter(row => row.predicate !== "P"), definition);
  const original = "Which parcel satisfies P (A and B)?";
  // Freeze every presentation and adapter before any observation.
  const sameGranularity = authoredInput(compoundH, original, ["P"]);
  const decomposed = authoredInput(compoundH, original, ["A", "B"]);
  const atomicAligned = authoredInput(atomicH, original, ["A", "B"]);
  const missingEndpoint = authoredInput(atomicH, original, ["P"]);
  expect(assignments.map(row => row.A && row.B)).toEqual(assignments.map(row => row.P));
  expect(assignments.map(row => row.P)).not.toEqual(assignments.map(row => row.A));
  expect(assignments.map(row => row.P)).not.toEqual(assignments.map(row => row.B));

  for (const input of [sameGranularity, decomposed, atomicAligned]) {
    const delivered = deliveredProofFixture({ ...input, budget: BUDGET });
    expect(returned(delivered.proof)).toEqual(["rBoth"]);
    expect(delivered.qualifier.evidence_kind).toBe("semantic_proof");
    expect(delivered.index.entries).toHaveLength(1);
    if (input !== sameGranularity) {
      expect(delivered.proof.binding_results![0]!.bindings.parcel!.node_id).toBe("rBoth");
      expect(new Set(consumedPredicates(input, delivered.proof))).toEqual(new Set(["qA", "qB"]));
      expect(delivered.source_dependencies).toEqual(expect.arrayContaining(["ABoth", "BBoth"]));
      expect(delivered.proof.consumed_leaves.filter(leaf => leaf.leaf_kind === "source_interpretation_binding"))
        .toEqual(expect.arrayContaining([expect.objectContaining({ occurrence: "ABoth", target: "rBoth" }),
          expect.objectContaining({ occurrence: "BBoth", target: "rBoth" })]));
    } else {
      expect(new Set(consumedPredicates(input, delivered.proof))).toEqual(new Set(["qP"]));
      expect(delivered.source_dependencies).toContain("PBoth");
    }
  }
  expect(atomicH.frames.map(frame => frame.predicate_support.reading)).not.toContain("P");
  const missing = execute(missingEndpoint);
  expect(returned(missing.result)).toEqual([]);
  expect(missing.result.attention).toMatchObject({ kind: "computed", entries: expect.arrayContaining([
    expect.objectContaining({ frame: "qP", obligation: "predicate", state: "correspondence_missing" })
  ]) });
  expect(missing.index?.entries ?? []).toEqual([]);
  // This is a missing adapter for this endpoint inventory, not source absence or a universal impossibility.
});

function purchaseSource(): SourceSemanticInterpretation {
  const subjects = ["Bought", "Gift", "Neither"];
  const facts: Fact[] = [
    ...subjects.map(subject => ({ id: `parcel${subject}`, predicate: "parcel", subject, positive: true })),
    { id: "purchaseBought", predicate: "purchase", subject: "Bought", positive: true },
    { id: "purchaseGift", predicate: "purchase", subject: "Gift", positive: false },
    { id: "acquisitionGift", predicate: "acquisition", subject: "Gift", positive: true },
    { id: "purchaseNeither", predicate: "purchase", subject: "Neither", positive: false },
    { id: "acquisitionNeither", predicate: "acquisition", subject: "Neither", positive: false },
    { id: "acquisitionTemplate", predicate: "acquisition", subject: "Bought", positive: true,
      sentence: "Every parcel satisfying purchase has acquisition." },
    { id: "purchaseRestriction", predicate: "purchase", subject: "Bought", positive: true,
      sentence: "purchase restricts that same universally bound parcel." }
  ];
  const authored = authoredSource("purchase-and-gift", subjects, facts,
    "Purchase implies acquisition. Gift is an acquisition without purchase. Neither has neither property. Parcels are distinct.");
  const templates = new Set(["acquisitionTemplate", "purchaseRestriction"]);
  return { ...authored,
    frames: authored.frames.map(frame => !templates.has(frame.id) ? frame : { ...frame,
      context_owner: { kind: "operator", operator_handle: "allPurchases" },
      bindings: [{ slot_id: "parcel", target: { kind: "bound_variable", quantifier: "allPurchases", binder: "parcel" }, support: [] }] }),
    operators: [...authored.operators, { id: "allPurchases", operator: "forall", binder: "parcel", domain: "parcels",
      restriction: "purchaseRestriction", content: "acquisitionTemplate", assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [{ kind: "lexical", mentions: ["macquisitionTemplate"] }] }],
    domains: [{ id: "parcels", context: null, support: [{ kind: "lexical", mentions: ["mparcelBought"] }],
      members: subjects.map(subject => ({ referent: `r${subject}`, evidence: `parcel${subject}`,
        restrictions: subject === "Bought" ? [{ restriction: "purchaseRestriction", evidence: "purchaseBought" }] : [] })),
      exclusions: [], closure: { kind: "closed", evidence: "parcelBought" } }],
    entry_roots: [...authored.entry_roots.filter(id => !templates.has(id)), "allPurchases"],
    asserted_at_scope: [...authored.asserted_at_scope.filter(id => !templates.has(id)), "allPurchases"] };
}

it("uses an accountable purchase rule for acquisition without reversing it or negating gift acquisition", () => {
  // Independent facts, not truth inferred from engine output.
  const expected = freeze({ acquisition: ["rBought", "rGift"], purchase: ["rBought"],
    notPurchase: ["rGift", "rNeither"], notAcquisition: ["rNeither"] });
  const interpretation = purchaseSource();
  const acquisition = authoredInput(interpretation, "Which parcel has acquisition?", ["acquisition"], true);
  const purchase = authoredInput(interpretation, "Which parcel has purchase?", ["purchase"], true);
  const notPurchase = authoredInput(interpretation, "Which parcel has not purchase?", ["purchase"], true, true);
  const notAcquisition = authoredInput(interpretation, "Which parcel has not acquisition?", ["acquisition"], true, true);
  const literal = authoredInput(interpretation, "Which parcel has acquisition?", ["acquisition"]);

  const acquired = deliveredProofFixture({ ...acquisition, budget: BUDGET });
  expect(returned(acquired.proof)).toEqual(expected.acquisition);
  expect(acquired.qualifier.evidence_kind).toBe("semantic_proof");
  expect(acquired.source_dependencies).toEqual(expect.arrayContaining(["allPurchases", "parcelBought", "purchaseBought", "acquisitionGift"]));
  expect(acquired.proof.derived_nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "instantiation", template: "acquisitionTemplate", quantifier: "allPurchases", member: "rBought" })
  ]));
  expect(acquired.proof.consumed_leaves).toEqual(expect.arrayContaining([
    expect.objectContaining({ leaf_kind: "source_interpretation_membership", member: "rBought", occurrence: "parcelBought" }),
    expect.objectContaining({ leaf_kind: "source_interpretation_restriction", member: "rBought", occurrence: "purchaseBought" }),
    expect.objectContaining({ leaf_kind: "source_interpretation_assertion_permission", occurrence: "allPurchases" })
  ]));
  expect(new Set(consumedPredicates(acquisition, acquired.proof))).toEqual(new Set(["qacquisition"]));
  for (const [input, answer] of [[purchase, expected.purchase], [notPurchase, expected.notPurchase],
    [notAcquisition, expected.notAcquisition], [literal, ["rGift"]]] as const) {
    const delivered = deliveredProofFixture({ ...input, budget: BUDGET });
    expect(returned(delivered.proof)).toEqual(answer);
    expect(delivered.qualifier.evidence_kind).toBe("semantic_proof");
  }
  // C aligns acquisition with acquisition, never purchase with acquisition. The directed work lives in H.
  expect(acquisition.correspondence.correspondences.filter(row => row.query_endpoint.kind === "predicate")
    .map(row => row.source_endpoint)).toEqual([{ kind: "frame", frame: "acquisitionGift" }, { kind: "frame", frame: "acquisitionNeither" },
    { kind: "frame", frame: "acquisitionTemplate" }]);
});
