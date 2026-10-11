import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSourceReferenceCatalog } from "../../evidence/source-reference.js";
import { materializeSourceSemanticInlineProposal } from "../../garden/source-semantic-inline-proposal.js";
import { SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT } from "../../garden/source-semantic-table-shape.js";
import { SourceSemanticTableValidationError } from "../../garden/source-semantic-table-proposal.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const atom = (text: string, occurrence?: number) => ({ assertion_id: 1, text,
  ...(occurrence === undefined ? {} : { occurrence }) });
const entity = (text: string, key?: string) => ({ kind: "entity", mentions: [atom(text)], ...(key === undefined ? {} : { key }) });
const ref = (key: string) => ({ kind: "content_ref", key });
const statement = (key: string, reading: string, target: object = entity("Mira", "mira")) => ({ kind: "statement", key,
  predicate: { kind: "explicit", reading, support: atom(reading) }, arguments: [{ role: "subject", target }], qualifications: [] });
const proposal = (nodes: ReturnType<typeof statement>[], extra: object = {}) => ({
  contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" },
  content: { nodes, roots: nodes.map(node => ({ act: "assertion", expression: ref(node.key) })), gaps: [], ...extra }
});
const lower = (value: unknown, text = "Mira Chen approved and signed 12", meter?: SourceSemanticResourceLedger) =>
  materializeSourceSemanticInlineProposal(value, {
    catalog: buildSourceReferenceCatalog(sha256(text), [{ assertion_id: 1, text }], sha256), sha256
  }, meter);

describe("source semantic inline entity adaptation", () => {
  it("reuses exact constructors while retaining distinct local mention groups under one semantic identity", () => {
    const value = proposal([statement("approval", "approved"), statement("signature", "signed", entity("Mira Chen", "mira"))]);
    const before = structuredClone(value), draft = lower(value).draft!;
    expect(draft.referents).toHaveLength(1);
    expect(draft.referents[0]!.mentions).toHaveLength(2);
    expect(draft.frames[0]!.bindings[0]!.target).toEqual(draft.frames[1]!.bindings[0]!.target);
    expect(draft.frames[0]!.bindings[0]!.support).not.toEqual(draft.frames[1]!.bindings[0]!.support);
    const repeated = lower(proposal([statement("approval", "approved"), statement("signature", "signed")])).draft!;
    expect(repeated.referents).toHaveLength(1);
    expect(repeated.referents[0]!.mentions).toHaveLength(1);
    expect(value).toEqual(before);
  });

  it("keeps host row addresses and occurrence indices separate from semantic identity keys", () => {
    const value = proposal([statement("approval", "approved", { kind: "entity", key: "u0", mentions: [atom("Mira", 0)] }),
      statement("signature", "signed", { kind: "entity", key: "u0", mentions: [atom("Mira", 1)] })]);
    const draft = lower(value, "Mira approved and Mira signed").draft!;
    expect(draft.referents).toHaveLength(1);
    expect(draft.referents[0]!.mentions.map(id => draft.mentions.find(row => row.id === id)!.source_ref.first))
      .toEqual(["a1s0", "a1s6"]);
  });

  it("preserves unkeyed and typed constructors without inventing an identity key", () => {
    const draft = lower(proposal([statement("approval", "approved", entity("Mira")),
      statement("signature", "signed", { ...entity("Chen", "other"), referent_kind: "ambiguous" })])).draft!;
    expect(draft.referents.map(row => row.referent_kind)).toEqual(["grouped", "ambiguous"]);
    expect(draft.frames[0]!.bindings[0]!.target).not.toEqual(draft.frames[1]!.bindings[0]!.target);
  });

  it("binds gap entity keys only to materialized constructors and preserves occurrence targets", () => {
    const gap = { kind: "unresolved_referent", support: atom("12"),
      affected: [{ kind: "entity_ref", key: "mira" }, { kind: "occurrence_ref", key: "approval" }] };
    const draft = lower(proposal([statement("approval", "approved")], { gaps: [gap] })).draft!;
    expect(draft.gaps[0]!.affected_ids).toEqual(expect.arrayContaining([draft.referents[0]!.id, draft.frames[0]!.id]));
    expect(() => lower(proposal([statement("approval", "approved", entity("Mira"))], { gaps: [gap] })))
      .toThrowError(new SourceSemanticTableValidationError("missing_gap_entity", "mira"));
  });

  it("adapts reporters and qualification entities without changing their evidence", () => {
    const event = { ...statement("event", "approved"), arguments: [],
      qualifications: [{ role: "count", target: entity("12", "quantity"), support: atom("12") }] };
    const value = { contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, outcome: { status: "interpreted" }, content: {
      nodes: [event, { kind: "reported", key: "report", support: atom("reported"), content: ref("event"), reporter: entity("Mira", "mira") }],
      roots: [{ act: "assertion", expression: ref("report") }], gaps: []
    } };
    const draft = lower(value, "Mira reported approved 12").draft!;
    expect(draft.operators[0]!.operator).toBe("reported");
    expect(draft.frames[0]!.context_owner).toEqual({ kind: "operator", operator_handle: draft.operators[0]!.id });
    expect(draft.frames[0]!.slots[0]!.role_reading).toBe("count");
    expect(draft.referents).toHaveLength(2);
  });

  it("uses the same entity identity for domain members and measurement subjects while preserving exclusions", () => {
    const mira = entity("Mira", "mira"), oren = entity("Oren", "oren");
    const value = proposal([statement("joined", "joined", mira), statement("excluded", "excluded", oren), statement("measured", "measured", mira)], {
      domains: [{ key: "people", context: null, support: atom("Mira"),
        members: [{ referent: mira, evidence: "joined", restrictions: [] }],
        exclusions: [{ referent: oren, evidence: "excluded" }], closure: { kind: "open" } }],
      measurements: [{ key: "count", subject: mira, owner: "measured", population: "people",
        metric: "headcount", unit: "person", context: "observed", value: "12", support: atom("12") }]
    });
    const draft = lower(value, "Mira joined, Oren excluded and measured 12").draft!;
    expect(draft.referents).toHaveLength(2);
    expect(draft.domains![0]!.members[0]!.referent).toBe(draft.measurements![0]!.subject);
    expect(draft.domains![0]!.exclusions[0]!.referent).not.toBe(draft.measurements![0]!.subject);
    expect(draft.measurements![0]!.population).toBe(draft.domains![0]!.id);
  });

  it("rejects a new constructor beyond native entity capacity while repeated exact uses remain bounded", () => {
    const make = (unique: boolean) => proposal(Array.from({ length: 33 }, (_, index) => ({ ...statement(`event${index}`, "approved"),
      arguments: Array.from({ length: index === 32 ? 1 : 8 }, (_, slot) => ({ role: `role${slot}`,
        target: entity("Mira", unique ? `person${index * 8 + slot}` : "person") })) })));
    expect(() => lower(make(true))).toThrowError(new SourceSemanticTableValidationError("native_entity_capacity_exceeded", "257"));
    const draft = lower(make(false)).draft!;
    expect(draft.referents).toHaveLength(1);
    expect(draft.frames).toHaveLength(33);
    expect(() => lower(make(false), undefined, new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1 })))
      .toThrow(SourceSemanticResourceExhausted);
  });

  it("preserves abstention without synthesizing content and rejects table-only entity declarations", () => {
    expect(lower({ contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, outcome: { status: "abstained" } }))
      .toEqual({ contract: "source-interpretation-response-v5", outcome: { status: "abstained" } });
    expect(() => lower(proposal([statement("approval", "approved")], { entities: [] })))
      .toThrowError(expect.objectContaining({ issues: [expect.objectContaining({
        code: "unrecognized_keys", keys: ["entities"], path: ["content"]
      })] }));
  });
});
