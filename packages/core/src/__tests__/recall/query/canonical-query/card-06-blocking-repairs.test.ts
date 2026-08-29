import { describe, expect, it } from "vitest";
import {
  QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID,
  type RecallQueryFactFrameCaptureFrame
} from "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import {
  compileCanonicalQueryCompilation,
  compileCanonicalQueryEvidence,
  digestCanonicalQueryV1
} from "../../../../recall/query/canonical-query/index.js";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";

const CJK_PLACE = "咖啡奶精优惠券在哪里兑换？";
const WHAT_BUY = "What did Alice buy?";
const BOOKSHELF = "Where did I buy my new bookshelf from?";
const EMPTY_DEMAND = Object.freeze({ schema_version: 1 as const, atoms: [] });
const SNAPSHOT = Object.freeze({
  receipt_digest: `sha256:${"c".repeat(64)}`,
  coherence_state: "coherent_exact" as const
});
const QUERY_IDENTITY = Object.freeze({
  condition_identity: "cond-1",
  query_operator_id: "recall_query_v1",
  generation_id: "gen-1",
  query_cache_key: "cache-1"
});

describe("Card 06 Blocking repair falsifiers", () => {
  it("keeps a shape target hole local when another CJK hypothesis binds its answer", () => {
    const compilation = compileCjk(QUERY_IDENTITY);
    const shape = hypothesisFrom(compilation, "shape.relation_terms");
    const frame = hypothesisFrom(compilation, "fact_frame.relation.");
    const targetHole = compilation.holes.find((hole) =>
      hole.code === "unbound_target_term");

    expect(shape?.predicates[0]?.arguments).toEqual(["x0"]);
    expect(frame?.predicates[0]?.arguments).toEqual(["咖啡奶精优惠券", "x0"]);
    expect(targetHole?.hypothesis_digest).toBe(digestCanonicalQueryV1(shape!));
    expect(compilation.compile_status).toBe("partial_program");
    expect(compilation.hypothetical_mode).toBe("best_effort");
  });

  it("binds x0 from one interrogative slot and rejects a frame with no answer slot", () => {
    const bound = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(WHAT_BUY),
      demand: EMPTY_DEMAND,
      factFrameCapture: returnedFactFrame(WHAT_BUY, [captureFrame([
        { role: "value", text: "What" },
        { role: "subject", text: "Alice" },
        { role: "relation", text: "buy" }
      ])])
    });
    const boundFrame = hypothesisFrom(bound, "fact_frame.relation.");
    expect(boundFrame?.predicates[0]?.arguments).toEqual(["alice", "x0"]);
    expect(boundFrame?.constants.map((constant) => constant.value)).toEqual(["alice"]);

    const unbound = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      factFrameCapture: returnedFactFrame(BOOKSHELF, [captureFrame([
        { role: "subject", text: "I" },
        { role: "relation", text: "buy" },
        { role: "value", text: "bookshelf" }
      ])])
    });
    expect(hypothesisFrom(unbound, "fact_frame.relation.")).toBeUndefined();
    expect(unbound.unresolved).toContainEqual(expect.objectContaining({
      code: "unknown_answer_variable",
      source: "fact_frame"
    }));
  });

  it.each([
    ["missing", undefined],
    ["malformed", { ...QUERY_IDENTITY, query_cache_key: " bad" }]
  ])("fails closed on %s query identity", (_label, queryIdentity) => {
    const valid = compileCjk(QUERY_IDENTITY);
    const invalid = compileCjk(queryIdentity);
    expect(valid.holes.some((hole) => hole.code === "unbound_query_identity")).toBe(false);
    expect(invalid.holes).toContainEqual(expect.objectContaining({
      code: "unbound_query_identity",
      impacts: ["blocks_all_delivery", "blocks_certified_delivery"]
    }));
    expect(invalid.compile_status).not.toBe("certified_program");
    expect(invalid.hypothetical_mode).toBe("abstained");
  });
});

function compileCjk(queryIdentity: typeof QUERY_IDENTITY | undefined) {
  return compileCanonicalQueryCompilation({
    probes: compileRecallQueryProbes(CJK_PLACE),
    demand: EMPTY_DEMAND,
    shape: {
      schema_version: 1,
      status: "high_confidence",
      shape: "place",
      target_terms: ["咖啡奶精优惠券"],
      relation_terms: ["兑换"]
    },
    factFrameCapture: returnedFactFrame(CJK_PLACE, [captureFrame([
      { role: "subject", text: "咖啡奶精优惠券" },
      { role: "relation", text: "兑换" },
      { role: "value", text: "哪里" }
    ])]),
    ...(queryIdentity === undefined ? {} : { query_identity: queryIdentity })
  }, SNAPSHOT);
}

function hypothesisFrom<T extends { readonly hypotheses: readonly {
  readonly predicates: readonly { readonly provenance?: { readonly source_id: string } }[]
}[] }>(compiled: T, sourcePrefix: string): T["hypotheses"][number] | undefined {
  return compiled.hypotheses.find((query) => query.predicates.some((predicate) =>
    predicate.provenance?.source_id.startsWith(sourcePrefix) === true));
}

function returnedFactFrame(
  queryText: string,
  frames: readonly RecallQueryFactFrameCaptureFrame[]
) {
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID,
    status: "returned" as const,
    query_text_digest: digestRecallFieldIdentity({ query_text: queryText }),
    producer_operator_id: "structured_query_frame_v1",
    frames
  });
  return Object.freeze({ ...body, capture_digest: digestRecallFieldIdentity(body) });
}

function captureFrame(
  slots: readonly {
    readonly role: "subject" | "relation" | "value" | "qualifier";
    readonly text: string;
  }[]
): RecallQueryFactFrameCaptureFrame {
  let cursor = 0;
  return {
    schema_version: 1,
    slots: slots.map((slot) => {
      const start = cursor;
      const end = start + slot.text.length;
      cursor = end;
      return { role: slot.role, text: slot.text, source_offset: [start, end] as const };
    })
  };
}
