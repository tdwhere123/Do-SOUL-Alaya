import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";
import {
  compileCanonicalQueryCompilation,
  QUERY_HOLE_IMPACTS,
  verifyCanonicalQueryCompilationV1
} from "../../../../recall/query/canonical-query/index.js";

const SNAPSHOT = {
  receipt_digest: `sha256:${"c".repeat(64)}`,
  coherence_state: "coherent_exact"
} as const;
const OTHER = {
  receipt_digest: `sha256:${"d".repeat(64)}`,
  coherence_state: "coherent_exact"
} as const;

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
        observer_contract: "observer-v1"
      }
    }, SNAPSHOT);
    const snapshotBlocked = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?")
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
  });

  it("changes digest on snapshot and operator identity and verifies stored digest", () => {
    const probes = compileRecallQueryProbes("Where did I buy my new bookshelf from?");
    const first = compileCanonicalQueryCompilation({ probes }, SNAPSHOT);
    const second = compileCanonicalQueryCompilation({ probes }, SNAPSHOT);
    const drifted = compileCanonicalQueryCompilation({ probes }, OTHER);
    expect(first.digest).toBe(second.digest);
    expect(drifted.digest).not.toBe(first.digest);
    expect(first.operator_id).toBe("recall_canonical_query_v1");
    expect(() => verifyCanonicalQueryCompilationV1(first)).not.toThrow();
    expect(() => verifyCanonicalQueryCompilationV1({
      ...first,
      digest: OTHER.receipt_digest
    })).toThrow(/digest/u);
    expect(first.hypotheses[0]?.answer.kind).toBe("scalar");
    expect(first.hypotheses[0]?.predicates[0]?.provenance?.producer)
      .toBe("recall_answer_shape_plan");
    expect(first.hypothesis_provenance[0]?.source_id).toBe("shape.relation_terms");
    expect(first.compile_status === "certified_program"
      || first.compile_status === "partial_program").toBe(true);
  });

  it("counts silent empty-demand fallbacks as zero on the golden corpus", () => {
    const corpus = [
      "Where did I buy my new bookshelf from?",
      "每天上班通勤要多久？",
      "How many places did I visit?",
      "How much is one bike?",
      "What is the latest password?"
    ];
    let silentFallback = 0;
    for (const query of corpus) {
      const compiled = compileCanonicalQueryCompilation({
        probes: compileRecallQueryProbes(query)
      }, SNAPSHOT);
      silentFallback += compiled.hypotheses.filter((queryAst) =>
        queryAst.predicates.length === 0 && compiled.holes.length === 0
      ).length;
    }
    expect(silentFallback).toBe(0);
  });
});
