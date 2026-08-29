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
  impactsFor,
  QUERY_HOLE_IMPACTS,
  verifyCanonicalQueryCompilationV1,
  type CanonicalQueryCompilationV1,
  type CanonicalQueryEvidenceV1
} from "../../../../recall/query/canonical-query/index.js";

const BOOKSHELF = "Where did I buy my new bookshelf from?";
const CJK_PLACE = "我在哪里兑换了咖啡奶精优惠券？";
const SNAPSHOT = {
  principal: "principal-1",
  authorized_scopes: ["scope-1"],
  receipt_digest: `sha256:${"c".repeat(64)}`,
  coherence_state: "coherent_exact"
} as const;
const OTHER = {
  principal: "principal-1",
  authorized_scopes: ["scope-1"],
  receipt_digest: `sha256:${"d".repeat(64)}`,
  coherence_state: "coherent_exact"
} as const;
const QUERY_IDENTITY = Object.freeze({
  condition_identity: "cond-1",
  query_operator_id: "recall_query_v1",
  generation_id: "gen-1",
  query_cache_key: "cache-1"
});
const EMPTY_DEMAND = Object.freeze({ schema_version: 1 as const, atoms: [] });

describe("canonical query compilation holes", () => {
  it("covers every hole impact without empty-demand certification", () => {
    const count = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("How many places did I visit?")
    }, SNAPSHOT);
    const unknown = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("How much is one bike?")
    }, SNAPSHOT);
    const latest = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("What is the latest password?")
    }, SNAPSHOT);
    const distinct = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("How many different doctors did I visit?"),
      observer: {
        principal: "principal-1",
        scope: "scope-1",
        observer_universe: ["obs-1"]
      }
    }, SNAPSHOT);
    const snapshotBlocked = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes(BOOKSHELF)
    }, { ...SNAPSHOT, coherence_state: "unavailable" });
    const cjk = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("每天上班通勤要多久？")
    }, SNAPSHOT);
    const noRelation = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("Where is Paris?"),
      shape: {
        schema_version: 1,
        status: "high_confidence",
        shape: "place",
        target_terms: ["paris"],
        relation_terms: []
      }
    }, SNAPSHOT);
    const allImpacts = new Set([
      ...count.holes, ...unknown.holes, ...latest.holes, ...distinct.holes,
      ...snapshotBlocked.holes, ...cjk.holes, ...noRelation.holes
    ].flatMap((hole) => hole.impacts));
    expect([...QUERY_HOLE_IMPACTS].sort()).toEqual([...allImpacts].sort());
    expect(count.compile_status).toBe("unsupported");
    expect(unknown.holes.some((hole) =>
      hole.impacts.includes("blocks_membership"))).toBe(true);
    expect(distinct.holes.some((hole) =>
      hole.impacts.includes("blocks_completeness_claim"))).toBe(true);
    expect(distinct.hypotheses[0]?.answer.kind).toBe("distinct");
    expect(snapshotBlocked.holes.some((hole) =>
      hole.impacts.includes("blocks_all_delivery"))).toBe(true);
    expect(snapshotBlocked.hypothetical_mode).toBe("abstained");
  });

  it("fails closed when observer principal is not the snapshot principal", () => {
    const compiled = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("How many different doctors did I visit?"),
      observer: {
        principal: "alice",
        scope: "scope-1",
        observer_universe: ["obs-1"]
      }
    }, { ...SNAPSHOT, principal: "bob" });
    expect(compiled.hypotheses.some((query) => query.answer.kind === "distinct"))
      .toBe(false);
    expect(compiled.holes.some((hole) => hole.code === "invalid_all_observable"))
      .toBe(true);
    expect(compiled.compile_status).not.toBe("certified_program");
  });

  it("changes digest on query identity, snapshot, and operator identity", () => {
    const probes = compileRecallQueryProbes(BOOKSHELF);
    const first = compileCanonicalQueryCompilation({
      probes,
      query_identity: QUERY_IDENTITY
    }, SNAPSHOT);
    const second = compileCanonicalQueryCompilation({
      probes,
      query_identity: QUERY_IDENTITY
    }, SNAPSHOT);
    const generation = compileCanonicalQueryCompilation({
      probes,
      query_identity: { ...QUERY_IDENTITY, generation_id: "gen-2" }
    }, SNAPSHOT);
    const condition = compileCanonicalQueryCompilation({
      probes,
      query_identity: { ...QUERY_IDENTITY, condition_identity: "cond-2" }
    }, SNAPSHOT);
    const drifted = compileCanonicalQueryCompilation({ probes }, OTHER);
    expect(first.digest).toBe(second.digest);
    expect(generation.digest).not.toBe(first.digest);
    expect(condition.digest).not.toBe(first.digest);
    expect(drifted.digest).not.toBe(first.digest);
    expect(first.operator_id).toBe("recall_canonical_query_v1");
    expect(first.query_identity).toEqual(QUERY_IDENTITY);
    const firstEvidence = { probes, query_identity: QUERY_IDENTITY };
    expect(() => verifyCanonicalQueryCompilationV1(first, firstEvidence, SNAPSHOT))
      .not.toThrow();
    expect(() => verifyCanonicalQueryCompilationV1({
      ...first,
      digest: OTHER.receipt_digest
    }, firstEvidence, SNAPSHOT)).toThrow(/digest/u);
    expect(first.hypotheses[0]?.answer.kind).toBe("scalar");
    expect(first.hypotheses[0]?.predicates.find((predicate) =>
      predicate.provenance?.source_id === "shape.relation_terms"
    )?.provenance?.producer).toBe("recall_answer_shape_plan");
    expect(first.hypothesis_provenance[0]?.source_id).toBe("shape.relation_terms");
    expect(first.compile_status).toBe("partial_program");
  });

  it("plants unknown_correlation for two fact frames and two OSF propositions", () => {
    const frames = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("How much is one bike?"),
      factFrameCapture: returnedFactFrame(
        [buyFrame(), visitFrame()],
        "How much is one bike?"
      )
    }, SNAPSHOT);
    expect(frames.holes.some((hole) => hole.code === "unknown_correlation")).toBe(true);
    const correlation = frames.holes.find((hole) => hole.code === "unknown_correlation");
    expect(correlation?.impacts).toEqual(impactsFor("unknown_correlation"));
    expect(correlation?.impacts).toEqual([
      "blocks_pointwise_comparison",
      "blocks_certified_delivery"
    ]);
    expect(frames.compile_status).not.toBe("certified_program");
    const osf = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND,
      osfCapture: formedOsf(BOOKSHELF, 2)
    }, SNAPSHOT);
    expect(osf.holes.some((hole) => hole.code === "unknown_correlation")).toBe(true);
    expect(osf.compile_status).not.toBe("certified_program");
  });

  it("preserves every impact on every hole in one multi-hole compilation", () => {
    const compiled = compileCanonicalQueryCompilation({
      probes: {
        ...compileRecallQueryProbes("How many places did I visit?"),
        normalized_query: "How many places did I visit? 每天上班通勤要多久？"
      },
      demand: {
        schema_version: 1,
        atoms: [{
          id: "ordering:latest",
          kind: "ordering",
          value: "latest",
          priority: "core"
        }]
      },
      shape: {
        schema_version: 1,
        status: "high_confidence",
        shape: "distinct_entities",
        target_terms: [],
        relation_terms: []
      },
      observer: {
        principal: "principal-1",
        scope: "scope-1",
        observer_universe: ["obs-1"]
      },
      factFrameCapture: returnedFactFrame(
        [buyFrame(), visitFrame()],
        "How many places did I visit? 每天上班通勤要多久？"
      )
    }, { ...SNAPSHOT, coherence_state: "unavailable" });
    expect(compiled.holes.length).toBeGreaterThan(1);
    expect(new Set(compiled.holes.map((hole) => hole.code)).size)
      .toBeGreaterThan(1);
    for (const hole of compiled.holes) {
      expect([...hole.impacts].sort()).toEqual([...impactsFor(hole.code)].sort());
    }
    const remaining = new Set(compiled.holes.flatMap((hole) => hole.impacts));
    expect([...QUERY_HOLE_IMPACTS].every((impact) => remaining.has(impact))).toBe(true);
    expect(compiled.holes.some((hole) => hole.code === "count_sum_unsupported")).toBe(true);
    expect(compiled.holes.some((hole) => hole.code === "unknown_correlation")).toBe(true);
    expect(compiled.holes.some((hole) => hole.code === "ambiguous_cjk_segmentation"))
      .toBe(true);
    expect(compiled.holes.some((hole) => hole.code === "unknown_correlation")).toBe(true);
    expect(compiled.holes.some((hole) => hole.code === "blocks_completeness_claim"))
      .toBe(true);
    expect(compiled.holes.some((hole) => hole.code === "unavailable")).toBe(true);
    expect(compiled.compile_status).not.toBe("certified_program");
  });

  it("rejects hole deletion and silent impact mutation after digest recompute", () => {
    const evidence: CanonicalQueryEvidenceV1 = {
      probes: compileRecallQueryProbes("opaque question"),
      demand: EMPTY_DEMAND,
      shape: {
        schema_version: 1,
        status: "unknown",
        shape: null,
        target_terms: [],
        relation_terms: []
      }
    };
    const compiled = compileCanonicalQueryCompilation(evidence, SNAPSHOT);
    expect(compiled.holes.length).toBeGreaterThan(0);
    expect(() => verifyCanonicalQueryCompilationV1(compiled, evidence, SNAPSHOT))
      .not.toThrow();
    const deleted = { ...compiled, holes: compiled.holes.slice(1) };
    expect(() => verifyCanonicalQueryCompilationV1({
      ...deleted,
      digest: digestRecallFieldIdentity(compilationBody(deleted))
    }, evidence, SNAPSHOT)).toThrow(/mismatch/u);
    const mutated = {
      ...compiled,
      holes: compiled.holes.map((hole, index) => index === 0
        ? { ...hole, impacts: [] }
        : hole)
    };
    expect(() => verifyCanonicalQueryCompilationV1({
      ...mutated,
      digest: digestRecallFieldIdentity(compilationBody(mutated))
    }, evidence, SNAPSHOT)).toThrow(/impact mismatch|mismatch/u);
    const unavailable = { ...SNAPSHOT, coherence_state: "unavailable" as const };
    const blocked = compileCanonicalQueryCompilation(evidence, unavailable);
    const snapshotGone = {
      ...blocked,
      holes: blocked.holes.filter((hole) => hole.provenance !== "snapshot"),
      compile_status: "unsupported" as const,
      hypothetical_mode: "unsupported" as const
    };
    expect(() => verifyCanonicalQueryCompilationV1({
      ...snapshotGone,
      digest: digestRecallFieldIdentity(compilationBody(snapshotGone))
    }, evidence, unavailable)).toThrow(/mismatch/u);
    const coordinated = {
      ...compiled,
      unresolved: [],
      holes: []
    };
    expect(() => verifyCanonicalQueryCompilationV1({
      ...coordinated,
      digest: digestRecallFieldIdentity(compilationBody(coordinated))
    }, evidence, SNAPSHOT)).toThrow(/mismatch/u);
  });

  it("derives bounded decision effects only from Q_q", () => {
    const compiled = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes(BOOKSHELF),
      demand: EMPTY_DEMAND
    }, SNAPSHOT);
    expect(compiled.sensitivities.every((row) => [
      "answer_binding",
      "answer_position",
      "proposition_bound",
      "extremum_range",
      "completion_scope"
    ].includes(row.effect))).toBe(true);
    expect(compiled.sensitivities.some((row) =>
      row.target === "probes" || row.target === "demand" || row.target === "shape"
    )).toBe(false);
    expect(compiled.sensitivities.some((row) =>
      row.effect === "proposition_bound" && row.target.endsWith(":buy")
    )).toBe(true);
    expect(compiled.sensitivities.some((row) => row.effect === "answer_binding")).toBe(true);
  });

  it("counts silent empty-demand fallbacks as zero on the golden corpus", () => {
    const corpus = [
      BOOKSHELF,
      "每天上班通勤要多久？",
      "How many places did I visit?",
      "How much is one bike?",
      "What is the latest password?",
      CJK_PLACE
    ];
    let silentFallback = 0;
    for (const query of corpus) {
      const compiled = compileCanonicalQueryCompilation({
        probes: compileRecallQueryProbes(query),
        demand: EMPTY_DEMAND,
        shape: query === CJK_PLACE
          ? {
              schema_version: 1 as const,
              status: "high_confidence" as const,
              shape: "place" as const,
              target_terms: ["咖啡奶精优惠券"],
              relation_terms: ["兑换"]
            }
          : undefined
      }, SNAPSHOT);
      silentFallback += compiled.hypotheses.filter((queryAst) =>
        queryAst.predicates.length === 0 && compiled.holes.length === 0
      ).length;
    }
    expect(silentFallback).toBe(0);
  });
});

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

function formedOsf(source: string, propositions: 1 | 2) {
  const second = propositions === 2
    ? [{
        factor_id: "second",
        surface: "new",
        semantic_identity: "own",
        source_occurrence: 0
      }]
    : [];
  return materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: source,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-test-producer-v1",
      source_text: source,
      graph: {
        schema_version: 2,
        source_kind: "query",
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
        variables: [{ variable_id: "answer", surface: "Where", source_occurrence: 0 }],
        result_variable_ids: ["answer"],
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
      }
    }
  });
}

function compilationBody(
  compilation: CanonicalQueryCompilationV1
): Omit<CanonicalQueryCompilationV1, "digest"> {
  const { digest: _digest, ...body } = compilation;
  return body;
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
