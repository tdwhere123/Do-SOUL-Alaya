import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import {
  SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, SourceSemanticQueryCarrierBodySchema, SourceSemanticQueryMeaningBodySchema,
  encodeSourceSemanticQueryCarrier, expandSourceSemanticQueryCarrier,
  materializeSourceSemanticQueryMeaning
} from "../../../recall/conditional-field/index.js";
import { sourceSemanticQueryIdentity } from "../../../garden/source-semantic-identity.js";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "../../../conversation/utterance-attribution.js";
import { SourceSemanticResourceExhausted } from "../../../garden/source-semantic-resources.js";

const original = "Who sent the sample to Mira?";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const envelope = { original_query: original, original_query_digest: `sha256:${sha256(original)}`,
  producer_id: "authored", producer_version: "1",
  approved_fixed_context: { context_id: "authored-question", notes: "The question author is Rowan." },
  attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION };
const sent = { kind: "statement", key: "sent", predicate: "send", arguments: [
  { role: "sender", target: { kind: "free", key: "answer", return: true }, excerpt: "Who" },
  { role: "theme", target: { kind: "named", key: "sample", excerpt: "the sample" } },
  { role: "recipient", target: { kind: "named", key: "mira", excerpt: "Mira" } }
] };
const body = (conditions: readonly unknown[], extra: object = {}) => ({
  contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
  alternatives: [{ conditions }], gaps: [], ...extra
});

type CarrierBody = typeof SourceSemanticQueryCarrierBodySchema._output;
type MeaningBody = typeof SourceSemanticQueryMeaningBodySchema._output;

it("requires typed carrier nodes and excludes nodes from nested meaning", () => {
  const carrier: CarrierBody = { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: ["n"] }], gaps: [],
    nodes: [{ node: "n", kind: "statement", predicate: "send", arguments: [] }] };
  const nested: MeaningBody = { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: [{ kind: "statement", predicate: "send", arguments: [] }] }], gaps: [] };
  expect(carrier.nodes[0]?.node).toBe("n");
  expect(SourceSemanticQueryCarrierBodySchema.safeParse(carrier).success).toBe(true);
  expect(SourceSemanticQueryMeaningBodySchema.safeParse(nested).success).toBe(true);
  expectTypeOf<CarrierBody["nodes"][number]["node"]>().toEqualTypeOf<string>();
  expectTypeOf<"nodes" extends keyof MeaningBody ? true : false>().toEqualTypeOf<false>();

  // @ts-expect-error carrier nodes are required
  const missing: CarrierBody = { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: ["n"] }], gaps: [] };
  const wrong: CarrierBody = { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: ["n"] }], gaps: [],
    // @ts-expect-error carrier nodes must be rows
    nodes: "wrong" };
  const nestedWithNodes: MeaningBody = { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: [{ kind: "statement", predicate: "send", arguments: [] }] }], gaps: [],
    // @ts-expect-error nested meaning has no nodes field
    nodes: [] };
  expect(SourceSemanticQueryCarrierBodySchema.safeParse(missing).success).toBe(false);
  expect(SourceSemanticQueryCarrierBodySchema.safeParse(wrong).success).toBe(false);
  expect(SourceSemanticQueryMeaningBodySchema.safeParse(nestedWithNodes).success).toBe(false);
});

function roundTrip(value: unknown) {
  const parsed = SourceSemanticQueryMeaningBodySchema.parse(value);
  const wire = encodeSourceSemanticQueryCarrier(parsed);
  const expanded = expandSourceSemanticQueryCarrier(wire);
  expect(expanded).toEqual(parsed);
  const direct = materializeSourceSemanticQueryMeaning(parsed, envelope);
  const carried = materializeSourceSemanticQueryMeaning(expanded, envelope);
  expect(carried).toEqual(direct);
  expect(sourceSemanticQueryIdentity(carried, sha256)).toBe(sourceSemanticQueryIdentity(direct, sha256));
  expect(carried.approved_fixed_context).toEqual(envelope.approved_fixed_context);
  return { wire, carried };
}

it("round trips every expression variant through one meaning compiler with stable canonical identity", () => {
  const variants = [
    sent,
    { kind: "not", key: "negative", content: sent },
    { kind: "possible", key: "possibility", content: sent },
    { kind: "reported", key: "report", reporter: { kind: "named", key: "mira", excerpt: "Mira" }, content: sent },
    { kind: "conditional", key: "condition", antecedent: { kind: "statement", predicate: "arrive", arguments: [] },
      consequent: sent },
    { kind: "opaque", key: "opaque", operands: [sent, { kind: "not", content: { kind: "statement",
      predicate: "leave", arguments: [] } }] }
  ];
  for (const expression of variants) roundTrip(body([expression]));
  const occurrence = roundTrip(body([sent, { kind: "occurrence", key: "sent" }]));
  expect(occurrence.wire.nodes).toHaveLength(2);
  expect(occurrence.carried.return_variables).toEqual(["answer"]);
});

it("keeps independent input branches, exact support and explicit gaps", () => {
  const input = { kind: "statement", key: "time", predicate: "time of sending", arguments: [
    { role: "event", target: { kind: "reference", key: "sent" }, excerpt: "sent the sample" },
    { role: "time", target: { kind: "free", key: "when", excerpt: "sent" } }
  ] };
  const value = body([sent], {
    requested_operation: { reading: "identify the sender", support: { kind: "query_text", excerpt: "Who" } },
    alternatives: [{ conditions: [sent], evidence_inputs: [{ conditions: [{ kind: "occurrence", key: "sent" }, input] }] }],
    gaps: [{ kind: "unsupported_meaning", affected_ids: ["sent"],
      support: [{ kind: "query_text", excerpt: "sent" }], description: "The event time remains open." }]
  });
  const { carried } = roundTrip(value);
  expect(carried.alternatives[0]!.evidence_inputs).toHaveLength(1);
  expect(carried.gaps).toHaveLength(1);
  const forged = roundTrip(body([{ ...sent, arguments: [{ role: "sender", target: { kind: "free", key: "answer", return: true },
    excerpt: "invented" }] }]));
  expect(forged.carried.alternatives[0]!.frames[0]!.role_requirements[0]!.support.excerpt).toBe("invented");
});

it.each(["conditional", "reported"] as const)("does not turn a repeated ordinary %s child token into an occurrence", kind => {
  const original_query = kind === "conditional"
    ? "Compare Mira's departure if she was invited with an independently asserted departure by Mira."
    : "Compare Mira's departure as reported by Mira with an independently asserted departure by Mira.";
  const selected = { ...envelope, original_query, original_query_digest: `sha256:${sha256(original_query)}` };
  const roles = [{ role: "agent", target: { kind: "reference", key: "mira" }, excerpt: "Mira" }];
  const governed = { kind: "statement", key: "governed", predicate: "leave", arguments: roles };
  const scope = kind === "conditional"
    ? { node: "scope", kind, key: "scope", antecedent: "invited", consequent: "governed" }
    : { node: "scope", kind, key: "scope", reporter: { kind: "reference", key: "mira" }, content: "governed" };
  for (const separateDeclaration of [false, true]) {
    const rootKey = separateDeclaration ? "independent" : "governed";
    const independent = { ...governed, key: rootKey,
      ...(separateDeclaration ? { obligation: "asserted_at_source" } : {}) };
    const nodes = [scope,
      ...(kind === "conditional" ? [{ node: "invited", kind: "statement", key: "invited",
        predicate: "invite", arguments: roles }] : []),
      { node: "governed", ...governed },
      ...(separateDeclaration ? [{ node: rootKey, ...independent }] : [])];
    for (const roots of [["scope", rootKey], [rootKey, "scope"]]) {
      for (const table of [nodes, [...nodes].reverse()]) {
        const expanded = expandSourceSemanticQueryCarrier({
          contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
          entities: [{ kind: "named", key: "mira", excerpt: "Mira" }],
          requested_operation: { reading: "compare departures", support: { kind: "query_text", excerpt: "Compare" } },
          alternatives: [{ conditions: [], evidence_inputs: roots.map(root => ({ conditions: [root] })) }], nodes: table
        });
        const rootIndex = roots.indexOf(rootKey);
        expect(expanded.alternatives[0]!.evidence_inputs![rootIndex]!.conditions).toEqual([independent]);
        if (!separateDeclaration) {
          expect(() => materializeSourceSemanticQueryMeaning(expanded, selected)).toThrow(/duplicate handles rejected/u);
          continue;
        }
        const query = materializeSourceSemanticQueryMeaning(expanded, selected);
        expect(query.alternatives[0]!.evidence_inputs![rootIndex]).toEqual({ frames: ["independent"] });
        expect(query.alternatives[0]!.context_obligations.filter(row => row.frame === "independent"))
          .toEqual([{ frame: "independent", kind: "asserted_at_source" }]);
        expect(query.alternatives[0]!.context_obligations.filter(row => row.frame === "governed"))
          .toEqual([{ frame: "governed", kind: "explicit_embedded_structure", incidence: {
            kind: "operator_operand", other_frame: "scope", role: kind === "conditional" ? "consequent" : "content"
          } }]);
        expect(query.alternatives[0]!.frames.filter(frame => frame.predicate_reading === "leave").map(frame => frame.id))
          .toEqual(roots[0] === "scope" ? ["governed", "independent"] : ["independent", "governed"]);
      }
    }
  }
});

it("keeps inner and outer negation distinct and permits finite evaluation without expression nodes", () => {
  const inner = roundTrip(body([{ kind: "statement", key: "say", predicate: "say", arguments: [],
    content: { kind: "not", key: "denial", content: sent } }]));
  const outer = roundTrip(body([{ kind: "not", key: "denial", content: { kind: "statement", key: "say",
    predicate: "say", arguments: [], content: sent } }]));
  expect(sourceSemanticQueryIdentity(inner.carried, sha256)).not.toBe(sourceSemanticQueryIdentity(outer.carried, sha256));
  const comparison = roundTrip(body([], {
    domains: [{ key: "people", excerpt: "Mira" }],
    entities: [{ kind: "named", key: "left", excerpt: "Mira" }, { kind: "named", key: "right", excerpt: "the sample" }],
    evaluation: { kind: "comparison", domain: "people", operation: "gt", left: "left", right: "right",
      strict: true, metric: "duration", unit: "seconds", context: "event", scope: "asserted" }
  }));
  expect(comparison.wire.nodes).toEqual([]);
  expect(comparison.carried.evaluation).toMatchObject({ kind: "comparison", operation: "gt" });
});

it("rejects missing, duplicate, cyclic, unreachable and wrong-kind serialization references", () => {
  expect(() => expandSourceSemanticQueryCarrier(undefined)).toThrow(/requires JSON structure/u);
  const valid = encodeSourceSemanticQueryCarrier(SourceSemanticQueryMeaningBodySchema.parse(body([sent])));
  const query = valid;
  expect(() => expandSourceSemanticQueryCarrier({ ...valid, alternatives: [{ conditions: ["missing"] }] }))
    .toThrow(/missing serialization reference/u);
  expect(() => expandSourceSemanticQueryCarrier({ ...valid, nodes: [...query.nodes, query.nodes[0]] }))
    .toThrow(/duplicate serialization reference/u);
  expect(() => expandSourceSemanticQueryCarrier({ ...valid, nodes: [...query.nodes,
    { node: "unused", kind: "statement", predicate: "unused", arguments: [] }] }))
    .toThrow(/unreachable serialization reference/u);
  expect(() => expandSourceSemanticQueryCarrier({ ...valid, alternatives: [{ conditions: [7] }] }))
    .toThrow();
  const cycle = { ...valid, alternatives: [{ conditions: ["a"] }], nodes: [
    { node: "a", kind: "not", content: "b" }, { node: "b", kind: "possible", content: "a" }
  ] };
  expect(() => expandSourceSemanticQueryCarrier(cycle)).toThrow(/cyclic serialization reference/u);
});

it("rejects graph amplification before constructing its expanded meaning", () => {
  const nodes: object[] = [{ node: "leaf", kind: "statement", predicate: "send", arguments: [] }];
  let previous = "leaf";
  for (let depth = 1; depth <= 8; depth += 1) {
    const node = `level${depth}`;
    nodes.push({ node, kind: "opaque", operands: Array(8).fill(previous) });
    previous = node;
  }
  const carrier = { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, gaps: [],
    alternatives: [{ conditions: [previous] }], nodes };
  expect(() => expandSourceSemanticQueryCarrier(carrier)).toThrow(SourceSemanticResourceExhausted);
  expect(() => expandSourceSemanticQueryCarrier(carrier, { work_units: 0 })).toThrow(SourceSemanticResourceExhausted);
});

it("reports a long serialization cycle explicitly before recursive expansion", () => {
  const nodes = Array.from({ length: 2048 }, (_, index) => ({
    node: `n${index}`, kind: "not", content: `n${(index + 1) % 2048}`
  }));
  expect(() => expandSourceSemanticQueryCarrier({ contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
    alternatives: [{ conditions: ["n0"] }], gaps: [], nodes })).toThrow(/cyclic serialization reference/u);
});
