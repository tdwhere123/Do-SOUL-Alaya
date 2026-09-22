import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildSourceReferenceCatalog, sourceReferenceResolver } from "../../evidence/source-reference.js";
import { sourceSemanticInterpretationIdentity } from "../../garden/source-semantic-identity.js";
import {
  SOURCE_SEMANTIC_K_VERSION, SOURCE_SEMANTIC_NORMALIZER_VERSION, normalizeSourceSemantics
} from "../../garden/normalize-source-semantics.js";
import { SourceInterpretationPacketSchema } from "../../garden/source-interpretation-packet.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const digest = `sha256:${"a".repeat(64)}`;

function catalogFor(text: string, assertionId = 1) {
  return buildSourceReferenceCatalog(sha(text), [{ assertion_id: assertionId, text }], sha);
}

function run(
  draft: unknown,
  catalog: ReturnType<typeof buildSourceReferenceCatalog>,
  over: { budget?: { work_units: number; memory_bytes: number } } = {}
) {
  return normalizeSourceSemantics({
    draft, catalog, sha256: sha,
    source: { source_id: "src", source_version: "1", content_digest: digest },
    producer_id: "producer", producer_version: "p1", contract_version: "source-interpretation-v4",
    ...over
  });
}

function mention(id: string, first: string, last: string, assertionId = 1) {
  return { id, assertion_id: assertionId, source_ref: { first, last } };
}

function frame(over: Record<string, unknown> = {}) {
  return {
    id: "fSend", assertion_ids: [1],
    context_owner: { kind: "source_act", source_act: "assertion" },
    additional_support: [],
    predicate_support: { kind: "explicit", reading: "send", mentions: ["mSent"] },
    slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mSent"] }] }],
    bindings: [{ slot_id: "agent", target: { kind: "node", id: "rBob" }, support: [] }],
    ...over
  };
}

function draft(over: Record<string, unknown> = {}) {
  return {
    contract: "source-interpretation-v4",
    mentions: [mention("mSent", "a1s0", "a1s0")],
    referents: [{ id: "rBob", referent_kind: "grouped", mentions: ["mSent"] }],
    frames: [frame()],
    operators: [],
    gaps: [],
    ...over
  };
}

function expectNormalized(result: ReturnType<typeof normalizeSourceSemantics>) {
  expect(result.status).toBe("normalized");
  if (result.status !== "normalized") throw new Error("expected normalized interpretation");
  return result;
}

it("reconstructs repeated we and CJK/emoji text from catalog first/last", () => {
  const text = "we 中🙂文 we";
  const catalog = catalogFor(text);
  const segments = catalog.assertions[0]!.segments;
  expect(segments.map((row) => row.text).join("")).toBe(text);
  const firstWe = segments[0]!;
  const lastWe = segments[segments.length - 1]!;
  const cjkFirst = segments.find((row) => row.text === "中")!;
  const cjkLast = segments.find((row) => row.text === "文")!;
  const result = expectNormalized(run(draft({
    mentions: [
      mention("mWe0", firstWe.id, firstWe.id),
      mention("mCjk", cjkFirst.id, cjkLast.id),
      mention("mWe1", lastWe.id, lastWe.id)
    ],
    referents: [
      { id: "rWe0", referent_kind: "grouped", mentions: ["mWe0"] },
      { id: "rWe1", referent_kind: "grouped", mentions: ["mWe1"] }
    ],
    frames: [frame({
      predicate_support: { kind: "explicit", reading: "send", mentions: ["mCjk"] },
      slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mWe0"] }] }],
      bindings: [{ slot_id: "agent", target: { kind: "node", id: "rWe0" }, support: [] }]
    })]
  }), catalog));
  const references = sourceReferenceResolver(catalog, sha);
  for (const row of result.interpretation.mentions) {
    const expected = references.resolve(catalog.catalog_id, 1, row.source_ref);
    expect(row.text).toBe(expected.text);
    expect(row.utf8_span).toEqual(expected.span);
    expect(text.slice(row.utf8_span[0], row.utf8_span[1])).toBe(row.text);
  }
  expect(result.interpretation.mentions.map((row) => row.text)).toEqual(["we", "中🙂文", "we"]);
  expect(result.interpretation.mentions[0]?.utf8_span).not.toEqual(result.interpretation.mentions[2]?.utf8_span);
});

it("keeps explicit implicit copula support and does not auto-select implicit when support is omitted", () => {
  const text = "The parcel, to Alice.";
  const catalog = catalogFor(text);
  const parcel = catalog.assertions[0]!.segments.find((row) => row.text === "parcel")!;
  const implicit = expectNormalized(run(draft({
    mentions: [mention("mParcel", parcel.id, parcel.id)],
    referents: [{ id: "rParcel", referent_kind: "grouped", mentions: ["mParcel"] }],
    frames: [frame({
      predicate_support: { kind: "implicit", reading: "send", supporting_context: ["mParcel"] },
      slots: [{ id: "theme", role_reading: "theme", support: [{ kind: "lexical", mentions: ["mParcel"] }] }],
      bindings: [{ slot_id: "theme", target: { kind: "node", id: "rParcel" }, support: [] }]
    })]
  }), catalog));
  expect(implicit.interpretation.frames[0]?.predicate_support).toEqual({
    kind: "implicit", reading: "send", supporting_context: ["mParcel"]
  });
  const omitted = frame() as Record<string, unknown>;
  delete omitted.predicate_support;
  const missing = run(draft({
    mentions: [mention("mParcel", parcel.id, parcel.id)],
    frames: [omitted]
  }), catalog);
  expect(missing.status).toBe("invalid");
  expect(missing).not.toHaveProperty("interpretation");
});

it("keeps same-name surface strings as two referent ids", () => {
  const text = "Alex packed. Alex labelled.";
  const catalog = catalogFor(text);
  const alexes = catalog.assertions[0]!.segments.filter((row) => row.text === "Alex");
  const packed = catalog.assertions[0]!.segments.find((row) => row.text === "packed")!;
  const result = expectNormalized(run(draft({
    mentions: [
      mention("mAlex0", alexes[0]!.id, alexes[0]!.id),
      mention("mAlex1", alexes[1]!.id, alexes[1]!.id),
      mention("mPacked", packed.id, packed.id)
    ],
    referents: [
      { id: "rAlex0", referent_kind: "grouped", mentions: ["mAlex0"] },
      { id: "rAlex1", referent_kind: "grouped", mentions: ["mAlex1"] }
    ],
    frames: [frame({
      predicate_support: { kind: "explicit", reading: "pack", mentions: ["mPacked"] },
      slots: [
        { id: "agent0", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mAlex0"] }] },
        { id: "agent1", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mAlex1"] }] }
      ],
      bindings: [
        { slot_id: "agent0", target: { kind: "node", id: "rAlex0" }, support: [] },
        { slot_id: "agent1", target: { kind: "node", id: "rAlex1" }, support: [] }
      ]
    })]
  }), catalog));
  expect(result.interpretation.referents.map((row) => row.id)).toEqual(["rAlex0", "rAlex1"]);
  expect(result.interpretation.mentions[0]?.text).toBe("Alex");
  expect(result.interpretation.mentions[1]?.text).toBe("Alex");
  expect(result.interpretation.mentions[0]?.utf8_span).not.toEqual(result.interpretation.mentions[1]?.utf8_span);
});

it("keeps two unresolved agents as two ids and does not invent a global unknown", () => {
  const text = "sent inspected";
  const catalog = catalogFor(text);
  const sent = catalog.assertions[0]!.segments.find((row) => row.text === "sent")!;
  const result = expectNormalized(run(draft({
    mentions: [mention("mSent", sent.id, sent.id)],
    referents: [
      { id: "rMissingOne", referent_kind: "unresolved", mentions: [] },
      { id: "rMissingTwo", referent_kind: "unresolved", mentions: [] }
    ],
    frames: [frame({
      slots: [
        { id: "agent", role_reading: "agent", support: [] },
        { id: "theme", role_reading: "theme", support: [] }
      ],
      bindings: [
        { slot_id: "agent", target: { kind: "node", id: "rMissingOne" }, support: [] },
        { slot_id: "theme", target: { kind: "node", id: "rMissingTwo" }, support: [] }
      ]
    })]
  }), catalog));
  expect(result.interpretation.referents.map((row) => row.id)).toEqual(["rMissingOne", "rMissingTwo"]);
  expect(result.interpretation.frames[0]?.slots).toHaveLength(2);
  expect(result.interpretation.frames[0]?.bindings.map((row) => row.target)).toEqual([
    { kind: "node", id: "rMissingOne" }, { kind: "node", id: "rMissingTwo" }
  ]);
  expect(result.interpretation.referents.some((row) => row.id === "unknown")).toBe(false);
});

it("does not copy assertion permission across a shared entity", () => {
  const text = "Carol said Bob sent. Bob sent.";
  const catalog = catalogFor(text);
  const said = catalog.assertions[0]!.segments.find((row) => row.text === "said")!;
  const sent = catalog.assertions[0]!.segments.filter((row) => row.text === "sent");
  const bob = catalog.assertions[0]!.segments.filter((row) => row.text === "Bob");
  const carol = catalog.assertions[0]!.segments.find((row) => row.text === "Carol")!;
  const result = expectNormalized(run(draft({
    mentions: [
      mention("mSaid", said.id, said.id),
      mention("mSent0", sent[0]!.id, sent[0]!.id),
      mention("mSent1", sent[1]!.id, sent[1]!.id),
      mention("mBob0", bob[0]!.id, bob[0]!.id),
      mention("mBob1", bob[1]!.id, bob[1]!.id),
      mention("mCarol", carol.id, carol.id)
    ],
    referents: [
      { id: "rBob", referent_kind: "grouped", mentions: ["mBob0", "mBob1"] },
      { id: "rCarol", referent_kind: "grouped", mentions: ["mCarol"] }
    ],
    frames: [
      frame({
        id: "fSendReported",
        context_owner: { kind: "operator", operator_handle: "opRep" },
        predicate_support: { kind: "explicit", reading: "send", mentions: ["mSent0"] },
        slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mSent0"] }] }],
        bindings: [{ slot_id: "agent", target: { kind: "node", id: "rBob" }, support: [] }]
      }),
      frame({
        id: "fSendAsserted",
        predicate_support: { kind: "explicit", reading: "send", mentions: ["mSent1"] },
        slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["mSent1"] }] }],
        bindings: [{ slot_id: "agent", target: { kind: "node", id: "rBob" }, support: [] }]
      })
    ],
    operators: [{
      id: "opRep", operator: "reported", content: "fSendReported", reporter: "rCarol",
      assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
      additional_support: [{ kind: "additional", mentions: ["mSaid"], reading: "report" }]
    }]
  }), catalog));
  expect(result.interpretation.entry_roots).toEqual(["fSendAsserted", "opRep"]);
  expect(result.interpretation.asserted_at_scope).toEqual(["fSendAsserted", "opRep"]);
  expect(result.interpretation.entry_roots).not.toContain("fSendReported");
  expect(result.interpretation.asserted_at_scope).not.toContain("fSendReported");
  expect(result.interpretation.frames.map((row) => row.id)).toEqual(["fSendReported", "fSendAsserted"]);
});

it("gives question and directive entry_roots without asserted_at_scope", () => {
  const text = "sent";
  const catalog = catalogFor(text);
  for (const source_act of ["question", "directive", "unresolved"] as const) {
    const result = expectNormalized(run(draft({
      mentions: [mention("mSent", "a1s0", "a1s0")],
      frames: [frame({ context_owner: { kind: "source_act", source_act } })]
    }), catalog));
    expect(result.interpretation.entry_roots).toEqual(["fSend"]);
    expect(result.interpretation.asserted_at_scope).toEqual([]);
  }
});

it("keeps promise embedding visitable without granting send assertion", () => {
  const text = "promised to send";
  const catalog = catalogFor(text);
  const promised = catalog.assertions[0]!.segments.find((row) => row.text === "promised")!;
  const sent = catalog.assertions[0]!.segments.find((row) => row.text === "send")!;
  const result = expectNormalized(run(draft({
    mentions: [
      mention("mPromised", promised.id, promised.id),
      mention("mSent", sent.id, sent.id)
    ],
    frames: [
      frame({
        id: "fPromise",
        predicate_support: { kind: "explicit", reading: "promise", mentions: ["mPromised"] },
        slots: [{ id: "promisor", role_reading: "promisor", support: [] }],
        bindings: [{ slot_id: "promisor", target: { kind: "node", id: "rBob" }, support: [] }]
      }),
      frame({
        id: "fSend",
        context_owner: { kind: "embedding", parent_frame: "fPromise", content_argument: "fSend" },
        additional_support: [{ kind: "dominating", via_id: "fPromise" }]
      })
    ]
  }), catalog));
  expect(result.interpretation.frames.map((row) => row.id)).toEqual(["fPromise", "fSend"]);
  expect(result.interpretation.entry_roots).toEqual(["fPromise"]);
  expect(result.interpretation.asserted_at_scope).toEqual(["fPromise"]);
  expect(result.interpretation.frames[1]?.additional_support).toEqual([{ kind: "dominating", via_id: "fPromise" }]);
});

it("rejects a domination cycle as an invalid source interpretation and admits an ordinary binding cycle", () => {
  const text = "sent";
  const catalog = catalogFor(text);
  const cyclic = run({
    contract: "source-interpretation-v4",
    mentions: [], referents: [], frames: [],
    operators: [
      {
        id: "opA", operator: "not", content: "opB", assertion_ids: [1],
        context_owner: { kind: "operator", operator_handle: "opB" }, additional_support: []
      },
      {
        id: "opB", operator: "not", content: "opA", assertion_ids: [1],
        context_owner: { kind: "operator", operator_handle: "opA" }, additional_support: []
      }
    ],
    gaps: []
  }, catalog);
  expect(cyclic.status).toBe("invalid");
  expect(cyclic).not.toHaveProperty("interpretation");
  if (cyclic.status === "invalid") expect(cyclic.reason).toMatch(/domination cycle/u);
  const bound = expectNormalized(run(draft({
    mentions: [mention("mSent", "a1s0", "a1s0")],
    frames: [
      frame({
        id: "fLeft",
        slots: [{ id: "other", role_reading: "other", support: [] }],
        bindings: [{ slot_id: "other", target: { kind: "node", id: "fRight" }, support: [] }]
      }),
      frame({
        id: "fRight",
        slots: [{ id: "other", role_reading: "other", support: [] }],
        bindings: [{ slot_id: "other", target: { kind: "node", id: "fLeft" }, support: [] }]
      })
    ]
  }), catalog));
  expect(bound.interpretation.entry_roots).toEqual(["fLeft", "fRight"]);
});

it("admits a new domain predicate accession without a profile", () => {
  const text = "accessioned folio";
  const catalog = catalogFor(text);
  const accessioned = catalog.assertions[0]!.segments.find((row) => row.text === "accessioned")!;
  const result = expectNormalized(run(draft({
    mentions: [mention("mAcc", accessioned.id, accessioned.id)],
    referents: [{ id: "rFolio", referent_kind: "grouped", mentions: ["mAcc"] }],
    frames: [frame({
      predicate_support: { kind: "explicit", reading: "accession", mentions: ["mAcc"] },
      slots: [{ id: "bay", role_reading: "bay", support: [] }],
      bindings: [{ slot_id: "bay", target: { kind: "node", id: "rFolio" }, support: [] }]
    })]
  }), catalog));
  expect(result.interpretation.frames[0]?.predicate_support.reading).toBe("accession");
  expect(result.interpretation.frames[0]?.slots[0]?.role_reading).toBe("bay");
  expect(result.interpretation.k_version).toBe(SOURCE_SEMANTIC_K_VERSION);
  expect(result.interpretation.normalizer_version).toBe(SOURCE_SEMANTIC_NORMALIZER_VERSION);
  expect(result.interpretation).not.toHaveProperty("budget");
  expect(result.interpretation).not.toHaveProperty("principal");
  expect(SourceInterpretationPacketSchema.safeParse(result.interpretation).success).toBe(false);
});

it("lets alpha-renamed handles hash differently and agree under an explicit mapping", () => {
  const text = "sent";
  const catalog = catalogFor(text);
  const left = expectNormalized(run(draft({ mentions: [mention("mSent", "a1s0", "a1s0")] }), catalog));
  const right = expectNormalized(run(draft({
    mentions: [mention("m1", "a1s0", "a1s0")],
    referents: [{ id: "r1", referent_kind: "grouped", mentions: ["m1"] }],
    frames: [frame({
      id: "f1",
      predicate_support: { kind: "explicit", reading: "send", mentions: ["m1"] },
      slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical", mentions: ["m1"] }] }],
      bindings: [{ slot_id: "agent", target: { kind: "node", id: "r1" }, support: [] }]
    })]
  }), catalog));
  const hidLeft = sourceSemanticInterpretationIdentity(left.interpretation, sha);
  const hidRight = sourceSemanticInterpretationIdentity(right.interpretation, sha);
  expect(hidLeft).not.toBe(hidRight);
  expect(left.alpha_map).toEqual({ mSent: "mSent", rBob: "rBob", fSend: "fSend" });
  expect(right.alpha_map).toEqual({ m1: "m1", r1: "r1", f1: "f1" });
  const map = { m1: "mSent", r1: "rBob", f1: "fSend" } as const;
  expect(right.interpretation.entry_roots.map((id) => map[id as keyof typeof map])).toEqual(
    left.interpretation.entry_roots
  );
  expect(right.interpretation.asserted_at_scope.map((id) => map[id as keyof typeof map])).toEqual(
    left.interpretation.asserted_at_scope
  );
  expect(right.interpretation.frames[0]?.predicate_support.reading).toBe(
    left.interpretation.frames[0]?.predicate_support.reading
  );
});

it("fails resource and byte bounds as resource_exhausted, not an empty source interpretation", () => {
  const text = "sent";
  const catalog = catalogFor(text);
  const budgeted = run(draft({ mentions: [mention("mSent", "a1s0", "a1s0")] }), catalog, {
    budget: { work_units: 0, memory_bytes: 0 }
  });
  expect(budgeted.status).toBe("resource_exhausted");
  expect(budgeted).not.toHaveProperty("interpretation");
  const oversized = run(draft({
    mentions: [mention("mSent", "a1s0", "a1s0")],
    gaps: Array.from({ length: 256 }, () => ({
      kind: "unsupported_meaning", affected_ids: [], support: [], description: "x".repeat(1024)
    }))
  }), catalog);
  expect(oversized.status).toBe("resource_exhausted");
  expect(oversized).not.toHaveProperty("interpretation");
});

it("rejects missing, reversed, and cross-assertion references as an invalid source interpretation", () => {
  const catalog = buildSourceReferenceCatalog(sha("generation"), [
    { assertion_id: 1, text: "one two" }, { assertion_id: 2, text: "two" }
  ], sha);
  for (const source_ref of [
    { first: "a1s999", last: "a1s999" },
    { first: "a1s2", last: "a1s0" },
    { first: "a1s0", last: "a2s0" }
  ]) {
    const result = run(draft({ mentions: [{ id: "mSent", assertion_id: 1, source_ref }] }), catalog);
    expect(result.status).toBe("invalid");
    expect(result).not.toHaveProperty("interpretation");
  }
});
