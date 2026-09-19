import { expect, it } from "vitest";
import { SourceSemanticDraftSchema } from "../../garden/source-semantic-draft.js";
import { SourceInterpretationPacketSchema } from "../../garden/source-interpretation-packet.js";

const mention = { id: "mSent", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } };
const frame = (owner: unknown, bindings: unknown[] = [{ slot_id: "agent", target: { kind: "node", id: "rBob" }, support: [] }]) => ({
  id: "fSend", assertion_ids: [1], context_owner: owner, additional_support: [],
  predicate_support: { kind: "explicit", reading: "send", mentions: ["mSent"] },
  slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mSent"] }] }],
  bindings
});
const draft = (over: Record<string, unknown> = {}) => ({
  contract: "source-interpretation-v3",
  mentions: [mention],
  referents: [{ id: "rBob", referent_kind: "grouped", mentions: ["mSent"] }],
  frames: [frame({ kind: "source_act", source_act: "assertion" })],
  operators: [],
  gaps: [],
  ...over
});

it("accepts an asserted send and rejects extra fields, roots, profile, and catalog hash", () => {
  expect(SourceSemanticDraftSchema.parse(draft()).frames[0]?.context_owner).toEqual({
    kind: "source_act", source_act: "assertion"
  });
  expect(SourceSemanticDraftSchema.safeParse({ ...draft(), score: 1 }).success).toBe(false);
  expect(SourceSemanticDraftSchema.safeParse({ ...draft(), roots: ["fSend"] }).success).toBe(false);
  expect(SourceSemanticDraftSchema.safeParse({ ...draft(), profile_id: "p" }).success).toBe(false);
  expect(SourceSemanticDraftSchema.safeParse({ ...draft(), source_catalog_id: "c" }).success).toBe(false);
});

it("rejects duplicate node handles and unknown cross-references", () => {
  expect(SourceSemanticDraftSchema.safeParse(draft({
    frames: [frame({ kind: "source_act", source_act: "assertion" }), { ...frame({ kind: "source_act", source_act: "assertion" }), id: "fSend" }]
  })).success).toBe(false);
  expect(SourceSemanticDraftSchema.safeParse(draft({
    frames: [frame({ kind: "source_act", source_act: "assertion" },
      [{ slot_id: "agent", target: { kind: "node", id: "missing" }, support: [] }])]
  })).success).toBe(false);
});

it.each([
  ["rBob", true, true], ["fSend", true, true], ["opNot", true, true],
  ["mSent", false, true], ["agent", false, false], ["a1s0", false, false], ["missing", false, false]
] as const)("distinguishes binding targets from gap locations for %s", (id, nodeAllowed, gapAllowed) => {
  const graph = draft({
    frames: [frame({ kind: "source_act", source_act: "assertion" }),
      { ...frame({ kind: "operator", operator_handle: "opNot" }, []), id: "fNested" }],
    operators: [{ id: "opNot", operator: "not", content: "fNested", assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [] }]
  });
  const targeted = { ...graph, frames: [frame({ kind: "source_act", source_act: "assertion" },
    [{ slot_id: "agent", target: { kind: "node", id }, support: [] }]), graph.frames[1]] };
  expect(SourceSemanticDraftSchema.safeParse(targeted).success).toBe(nodeAllowed);
  const located = { ...graph, gaps: [{ kind: "uninterpreted_clause", affected_ids: [id],
    support: [{ kind: "lexical", mentions: ["mSent"] }] }] };
  expect(SourceSemanticDraftSchema.safeParse(located).success).toBe(gapAllowed);
});

it("keeps slot definition without a binding from implying a target", () => {
  const parsed = SourceSemanticDraftSchema.parse(draft({
    frames: [frame({ kind: "source_act", source_act: "assertion" }, [])]
  }));
  expect(parsed.frames[0]?.slots).toHaveLength(1);
  expect(parsed.frames[0]?.bindings).toEqual([]);
});

it("treats two unresolved referents as distinct and rejects a global unknown entity", () => {
  const parsed = SourceSemanticDraftSchema.parse(draft({
    referents: [
      { id: "rMissingOne", referent_kind: "unresolved", mentions: [] },
      { id: "rMissingTwo", referent_kind: "unresolved", mentions: [] }
    ],
    frames: [{
      ...frame({ kind: "source_act", source_act: "assertion" }, [
        { slot_id: "agent", target: { kind: "unresolved" }, support: [] },
        { slot_id: "theme", target: { kind: "unresolved" }, support: [] }
      ]),
      slots: [
        { id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mSent"] }] },
        { id: "theme", role_reading: "theme", support: [] }
      ]
    }]
  }));
  expect(parsed.referents.map((row) => row.id)).toEqual(["rMissingOne", "rMissingTwo"]);
  expect(parsed.frames[0]?.bindings.map((row) => row.target)).toEqual([
    { kind: "unresolved" }, { kind: "unresolved" }
  ]);
  expect(parsed.frames[0]?.bindings[0]?.target).not.toHaveProperty("id");
});

it("accepts future declarative as unresolved and still parses an asserted encoding without rewriting it", () => {
  const unresolved = SourceSemanticDraftSchema.parse(draft({
    frames: [frame({ kind: "source_act", source_act: "unresolved" })]
  }));
  expect(unresolved.frames[0]?.context_owner).toEqual({ kind: "source_act", source_act: "unresolved" });
  const asserted = SourceSemanticDraftSchema.parse(draft({
    frames: [frame({ kind: "source_act", source_act: "assertion" })]
  }));
  expect(asserted.frames[0]?.context_owner).toEqual({ kind: "source_act", source_act: "assertion" });
});

it("distinguishes opaque wrapping from unresolved source_act", () => {
  const opaque = SourceSemanticDraftSchema.parse(draft({
    frames: [frame({ kind: "operator", operator_handle: "opOpaque" })],
    operators: [{
      id: "opOpaque", operator: "opaque", operands: ["fSend"], assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: []
    }]
  }));
  expect(opaque.operators[0]?.operator).toBe("opaque");
  expect(opaque.frames[0]?.context_owner).toEqual({ kind: "operator", operator_handle: "opOpaque" });
  expect(SourceSemanticDraftSchema.safeParse(draft({
    frames: [frame({ kind: "source_act", source_act: "unresolved" })],
    operators: [{
      id: "opOpaque", operator: "opaque", operands: ["fSend"], assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: []
    }]
  })).success).toBe(false);
});

it("rejects invalid operator operands, reporter targets, and unknown operator names", () => {
  expect(SourceSemanticDraftSchema.safeParse(draft({
    frames: [frame({ kind: "operator", operator_handle: "opNot" })],
    operators: [{
      id: "opNot", operator: "not", content: "rBob", assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: []
    }]
  })).success).toBe(false);
  expect(SourceSemanticDraftSchema.safeParse(draft({
    frames: [frame({ kind: "operator", operator_handle: "opRep" })],
    operators: [{
      id: "opRep", operator: "reported", content: "fSend", reporter: "fSend", assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: []
    }]
  })).success).toBe(false);
  expect(SourceSemanticDraftSchema.safeParse(draft({
    operators: [{
      id: "opBad", operator: "believe", content: "fSend", assertion_ids: [1],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: []
    }]
  })).success).toBe(false);
});

it("rejects omitted predicate support instead of treating emptiness as implicit", () => {
  const omitted = frame({ kind: "source_act", source_act: "assertion" }) as Record<string, unknown>;
  delete omitted.predicate_support;
  expect(SourceSemanticDraftSchema.safeParse(draft({ frames: [omitted] })).success).toBe(false);
  expect(SourceSemanticDraftSchema.parse(draft({
    frames: [{ ...frame({ kind: "source_act", source_act: "assertion" }),
      predicate_support: { kind: "implicit", reading: "send", supporting_context: ["mSent"] } }]
  })).frames[0]?.predicate_support.kind).toBe("implicit");
});

it("rejects excess domination depth and excess bytes", () => {
  const nest = (count: number) => {
    const operators = Array.from({ length: count }, (_, index) => ({
      id: `n${index}`, operator: "not" as const,
      content: index === 0 ? "fSend" : `n${index - 1}`,
      assertion_ids: [1],
      context_owner: index === count - 1
        ? { kind: "source_act" as const, source_act: "assertion" as const }
        : { kind: "operator" as const, operator_handle: `n${index + 1}` },
      additional_support: []
    }));
    return draft({
      frames: [frame({ kind: "operator", operator_handle: "n0" })],
      operators
    });
  };
  expect(SourceSemanticDraftSchema.safeParse(nest(16)).success).toBe(true);
  expect(SourceSemanticDraftSchema.safeParse(nest(17)).success).toBe(false);
  expect(SourceSemanticDraftSchema.safeParse(draft({
    gaps: Array.from({ length: 256 }, () => ({
      kind: "unsupported_meaning", affected_ids: [], support: [], description: "x".repeat(1024)
    }))
  })).success).toBe(false);
});

it("does not parse a v3 draft as a live v2 packet", () => {
  expect(SourceInterpretationPacketSchema.safeParse(draft()).success).toBe(false);
});
