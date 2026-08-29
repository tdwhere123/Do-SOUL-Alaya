import { describe, expect, it } from "vitest";
import {
  QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID,
  type RecallQueryFactFrameCaptureFrame
} from "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";
import {
  compileCanonicalQueryCompilation,
  compileCanonicalQueryEvidence
} from "../../../../recall/query/canonical-query/index.js";

const BOOKSHELF = "Where did I buy my new bookshelf from?";
const CJK_PLACE = "我在哪里兑换了咖啡奶精优惠券？";
const SNAPSHOT = {
  receipt_digest: `sha256:${"c".repeat(64)}`,
  coherence_state: "coherent_exact"
} as const;
const QUERY_IDENTITY = Object.freeze({
  condition_identity: "cond-1",
  query_operator_id: "recall_query_v1",
  generation_id: "gen-1",
  query_cache_key: "cache-1"
});
const EMPTY_DEMAND = Object.freeze({ schema_version: 1 as const, atoms: [] });

describe("canonical query compiler adapters", () => {
  it("compiles a type-valid English place program with relation provenance", () => {
    const english = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF)
    });
    expect(english.hypotheses).toHaveLength(1);
    expect(english.hypotheses[0]?.answer.kind).toBe("scalar");
    expect(relationOf(english, "shape.relation_terms")).toBe("buy");
    expect(english.hypotheses[0]?.predicates[0]?.provenance).toEqual({
      source_id: "shape.relation_terms",
      producer: "recall_answer_shape_plan"
    });
    expect(english.hypothesis_provenance).toEqual([{
      source_id: "shape.relation_terms",
      producer: "recall_answer_shape_plan"
    }]);
    expect(english.unresolved.some((row) => row.source === "demand")).toBe(true);
    expect(english.unresolved.some((row) => row.code === "unadapted_fact_frame"))
      .toBe(false);
    expect(english.provenance).toContain("shape.relation_terms");
  });

  it("keeps shape-only English place programs partial until targets bind", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND
    });
    expect(compiled.hypotheses).toHaveLength(1);
    expect(compiled.hypotheses[0]?.answer.kind).toBe("scalar");
    expect(compiled.hypotheses[0]?.predicates[0]?.arguments).toEqual(["x0"]);
    expect(relationOf(compiled, "shape.relation_terms")).toBe("buy");
    expect(compiled.unresolved.some((row) => row.code === "unbound_target_term")).toBe(true);
    const partial = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      query_identity: QUERY_IDENTITY
    }, SNAPSHOT);
    expect(partial.compile_status).toBe("partial_program");
    expect(partial.holes.some((hole) => hole.code === "unbound_target_term")).toBe(true);
  });

  it("certifies a CJK place program from grounded shape tokens without jieba", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(CJK_PLACE),
      demand: EMPTY_DEMAND,
      shape: {
        schema_version: 1,
        status: "high_confidence",
        shape: "place",
        target_terms: ["咖啡奶精优惠券"],
        relation_terms: ["兑换"]
      }
    });
    expect(compiled.hypotheses).toHaveLength(1);
    expect(compiled.hypotheses[0]?.answer.kind).toBe("scalar");
    expect(relationOf(compiled, "shape.relation_terms")).toBe("兑换");
    expect(compiled.hypotheses[0]?.predicates[0]?.arguments).toEqual(["x0"]);
    const certified = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes(CJK_PLACE),
      demand: EMPTY_DEMAND,
      shape: {
        schema_version: 1,
        status: "high_confidence",
        shape: "place",
        target_terms: ["咖啡奶精优惠券"],
        relation_terms: ["兑换"]
      },
      factFrameCapture: returnedFactFrame([captureFrame([
        { role: "subject", text: "我" },
        { role: "relation", text: "兑换" },
        { role: "value", text: "咖啡奶精优惠券" }
      ])], CJK_PLACE),
      query_identity: QUERY_IDENTITY
    }, SNAPSHOT);
    expect(certified.compile_status).toBe("certified_program");
    expect(certified.holes).toEqual([]);
    expect(CJK_PLACE.includes("兑换")).toBe(true);
  });

  it("does not silently truncate relations or accept blank relations", () => {
    const overflow = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where is Paris?"),
      shape: {
        schema_version: 1,
        status: "high_confidence",
        shape: "place",
        target_terms: ["paris"],
        relation_terms: ["a", "b", "c", "d", "e", "f", "g", "h", "i"]
      }
    });
    expect(overflow.hypotheses).toEqual([]);
    expect(overflow.unresolved.some((row) => row.code === "limit_overflow")).toBe(true);
    const blank = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where is Paris?"),
      shape: {
        schema_version: 1,
        status: "high_confidence",
        shape: "place",
        target_terms: ["paris"],
        relation_terms: [" "]
      }
    });
    expect(blank.hypotheses).toEqual([]);
    expect(blank.unresolved.length).toBeGreaterThan(0);
  });

  it("does not certify CJK duration or empty-Phi guesses", () => {
    const cjk = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("每天上班通勤要多久？")
    });
    expect(cjk.hypotheses).toEqual([]);
    expect(cjk.unresolved.some((row) => row.code === "unsupported_nesting")).toBe(true);
    expect(cjk.unresolved.some((row) => row.code === "ambiguous_cjk_segmentation"))
      .toBe(true);
    const certified = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("每天上班通勤要多久？"),
      demand: EMPTY_DEMAND
    }, SNAPSHOT);
    expect(certified.compile_status).not.toBe("certified_program");
  });

  it("keeps count/sum and latest-without-time explicit", () => {
    const count = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("How many places did I visit?")
    });
    expect(count.hypotheses).toEqual([]);
    expect(count.unresolved.some((row) => row.code === "count_sum_unsupported")).toBe(true);
    const latest = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("What is the latest password?")
    });
    expect(latest.hypotheses).toEqual([]);
    expect(latest.unresolved.some((row) =>
      row.code === "latest_without_typed_time_key")).toBe(true);
    const dated = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("what is the latest update in 2024?")
    });
    expect(dated.hypotheses).toEqual([]);
    expect(dated.unresolved.some((row) =>
      row.code === "latest_without_typed_time_key")).toBe(true);
    const countWithFrame = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("How many places did I visit?"),
      demand: EMPTY_DEMAND,
      factFrameCapture: returnedFactFrame([visitFrame()], "How many places did I visit?")
    });
    expect(countWithFrame.hypotheses).toEqual([]);
    expect(countWithFrame.unresolved.some((row) => row.code === "count_sum_unsupported"))
      .toBe(true);
    const latestWithFrame = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("What is the latest password?"),
      factFrameCapture: returnedFactFrame([buyFrame()], "What is the latest password?")
    });
    expect(latestWithFrame.hypotheses).toEqual([]);
    expect(latestWithFrame.unresolved.some((row) =>
      row.code === "latest_without_typed_time_key")).toBe(true);
  });

  it("adapts a returned fact-frame relation into Phi with fact-frame provenance", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      factFrameCapture: returnedFactFrame([buyFrame()])
    });
    const frameRelation = compiled.hypotheses.flatMap((query) => query.predicates)
      .find((predicate) => predicate.provenance?.producer
        === QUERY_FACT_FRAME_EXTRACTION_CAPTURE_OPERATOR_ID);
    expect(frameRelation?.relation).toBe("buy");
    expect(frameRelation?.arguments).toEqual(["bookshelf", "x0"]);
    expect(compiled.hypotheses.some((query) =>
      query.constants.some((constant) => constant.value === "bookshelf")
    )).toBe(true);
    expect(compiled.unresolved.some((row) => row.code === "unadapted_fact_frame"))
      .toBe(false);
  });

  it("adapts a formed single-proposition OSF graph without a blanket unadapted_osf", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      osfCapture: formedOsf(BOOKSHELF, 1)
    });
    const osfRelation = compiled.hypotheses.flatMap((query) => query.predicates)
      .find((predicate) => predicate.provenance?.source_id.startsWith("osf.relation.")
        === true);
    expect(osfRelation?.relation).toBe("buy");
    expect(osfRelation?.arguments).toEqual(["bookshelf", "x0"]);
    expect(compiled.hypotheses.some((query) =>
      query.constants.some((constant) => constant.value === "bookshelf")
    )).toBe(true);
    expect(compiled.unresolved.some((row) => row.code === "unadapted_osf")).toBe(false);
  });

  it("does not flatten OSF graphs with 0 or 2+ result variables", () => {
    const none = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      osfCapture: formedOsf(BOOKSHELF, 1, [])
    });
    expect(none.hypotheses.every((query) =>
      query.predicates.every((predicate) =>
        predicate.provenance?.source_id.startsWith("osf.relation.") !== true
      )
    )).toBe(true);
    expect(none.unresolved.some((row) =>
      row.code === "unknown_answer_variable" || row.code === "unadapted_osf")).toBe(true);
    const many = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      osfCapture: formedOsf(BOOKSHELF, 1, ["answer", "other"])
    });
    expect(many.hypotheses.every((query) =>
      query.predicates.every((predicate) =>
        predicate.provenance?.source_id.startsWith("osf.relation.") !== true
      )
    )).toBe(true);
    expect(many.unresolved.some((row) =>
      row.code === "unknown_correlation" || row.code === "unadapted_osf")).toBe(true);
  });

  it("does not flatten distinct to scalar when the observer is missing", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("How many different doctors did I visit?"),
      demand: EMPTY_DEMAND,
      factFrameCapture: returnedFactFrame(
        [buyFrame()],
        "How many different doctors did I visit?"
      )
    });
    expect(compiled.unresolved.some((row) => row.code === "unknown_scope")).toBe(true);
    expect(compiled.hypotheses.every((query) => query.answer.kind !== "scalar")).toBe(true);
  });

  it("keeps conflicting shape and fact-frame relations as two hypotheses", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      factFrameCapture: returnedFactFrame([purchaseFrame()])
    });
    const relations = compiled.hypotheses.map((query) =>
      query.predicates.find((predicate) =>
        predicate.provenance?.source_id.includes(".relation") === true
      )?.relation
    );
    expect(new Set(relations)).toEqual(new Set(["buy", "purchase"]));
    expect(compiled.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(compiled.unresolved.some((row) =>
      row.code === "conflicting_demand_shape" || row.code === "conflicting_shape"))
      .toBe(true);
  });

  it("records unadapted fact-frame/OSF for status-only and unavailable captures", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      factFrameCapture: { status: "returned" },
      osfCapture: { status: "formed" }
    });
    expect(compiled.unresolved.some((row) => row.code === "unadapted_fact_frame")).toBe(true);
    expect(compiled.unresolved.some((row) => row.code === "unadapted_osf")).toBe(true);
    const otherFrames = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      factFrameCapture: {
        status: "returned",
        capture_digest: `sha256:${"a".repeat(64)}`
      },
      osfCapture: { status: "formed", capture_digest: `sha256:${"b".repeat(64)}` }
    });
    const shiftedFrames = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      factFrameCapture: {
        status: "returned",
        capture_digest: `sha256:${"c".repeat(64)}`
      },
      osfCapture: { status: "formed", capture_digest: `sha256:${"d".repeat(64)}` }
    });
    expect(otherFrames.unresolved.find((row) => row.code === "unadapted_fact_frame")
      ?.capture_digest).not.toBe(
      shiftedFrames.unresolved.find((row) => row.code === "unadapted_fact_frame")
        ?.capture_digest
    );
    const otherStatus = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      factFrameCapture: { status: "unavailable" },
      osfCapture: { status: "unavailable" }
    });
    expect(otherStatus.unresolved.some((row) => row.code === "unadapted_fact_frame"))
      .toBe(true);
    expect(otherStatus.unresolved.some((row) => row.code === "unadapted_osf")).toBe(true);
    const pinnedDemand = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: {
        schema_version: 1,
        atoms: [{
          id: "temporal:2024",
          kind: "temporal",
          value: "2024",
          priority: "core"
        }]
      }
    });
    expect(pinnedDemand.unresolved.some((row) =>
      row.code === "unadapted_demand_temporal" && row.source === "demand")).toBe(true);
    const first = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      query_identity: QUERY_IDENTITY
    });
    const second = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      query_identity: QUERY_IDENTITY
    });
    expect(first).toEqual(second);
  });
});

function relationOf(
  compiled: ReturnType<typeof compileCanonicalQueryEvidence>,
  sourceId: string
): string | undefined {
  return compiled.hypotheses[0]?.predicates.find((predicate) =>
    predicate.provenance?.source_id === sourceId
  )?.relation;
}

function returnedFactFrame(
  frames: readonly RecallQueryFactFrameCaptureFrame[],
  queryText = BOOKSHELF
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

function buyFrame(): RecallQueryFactFrameCaptureFrame {
  return captureFrame([
    { role: "subject", text: "I" },
    { role: "relation", text: "buy" },
    { role: "value", text: "bookshelf" }
  ]);
}

function purchaseFrame(): RecallQueryFactFrameCaptureFrame {
  return captureFrame([
    { role: "subject", text: "I" },
    { role: "relation", text: "purchase" },
    { role: "value", text: "bookshelf" }
  ]);
}

function visitFrame(): RecallQueryFactFrameCaptureFrame {
  return captureFrame([
    { role: "subject", text: "I" },
    { role: "relation", text: "visit" },
    { role: "value", text: "places" }
  ]);
}

function captureFrame(
  slots: readonly { readonly role: "subject" | "relation" | "value"; readonly text: string }[]
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

function formedOsf(
  source: string,
  propositions: 1 | 2,
  resultVariableIds: readonly string[] = ["answer"]
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: source,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-test-producer-v1",
      source_text: source,
      graph: osfGraph(propositions, resultVariableIds)
    }
  });
}

function osfGraph(propositions: 1 | 2, resultVariableIds: readonly string[] = ["answer"]) {
  const second = propositions === 2
    ? [{
        factor_id: "second",
        surface: "new",
        semantic_identity: "own",
        source_occurrence: 0
      }]
    : [];
  return {
    schema_version: 2 as const,
    source_kind: "query" as const,
    factors: [
      {
        factor_id: "predicate",
        surface: "buy",
        semantic_identity: "buy",
        source_occurrence: 0
      },
      {
        factor_id: "object",
        surface: "bookshelf",
        semantic_identity: "bookshelf",
        source_occurrence: 0
      },
      ...second
    ],
    variables: resultVariableIds.map((variable_id) => ({
      variable_id,
      surface: variable_id === "answer" ? "Where" : variable_id,
      source_occurrence: 0
    })),
    result_variable_ids: [...resultVariableIds],
    propositions: [
      {
        proposition_id: "buy-query",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "object", "factor", "object"),
          argument(1, "answer", "variable", "answer")
        ]
      },
      ...(propositions === 2
        ? [{
            proposition_id: "own-query",
            predicate_factor_id: "second",
            arguments: [argument(0, "answer", "variable", "answer")]
          }]
        : [])
    ]
  };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
