import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";
import { compileCanonicalQueryEvidence } from
  "../../../../recall/query/canonical-query/index.js";

describe("canonical query compiler adapters", () => {
  it("compiles a type-valid English place program with relation provenance", () => {
    const english = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    });
    expect(english.hypotheses).toHaveLength(1);
    expect(english.hypotheses[0]?.answer.kind).toBe("scalar");
    expect(english.hypotheses[0]?.predicates.map((row) => row.relation)).toEqual(["buy"]);
    expect(english.hypotheses[0]?.predicates[0]?.provenance).toEqual({
      source_id: "shape.relation_terms",
      producer: "recall_answer_shape_plan"
    });
    expect(english.hypothesis_provenance).toEqual([{
      source_id: "shape.relation_terms",
      producer: "recall_answer_shape_plan"
    }]);
    expect(english.unresolved.some((row) => row.source === "demand")).toBe(true);
    expect(english.unresolved.some((row) =>
      row.code === "unbound_target_term")).toBe(true);
    expect(english.provenance).toContain("shape.relation_terms");
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
    expect(cjk.unresolved.some((row) => row.code === "ambiguous_cjk_segmentation")).toBe(true);
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
  });

  it("records unadapted fact-frame/OSF instead of dropping them", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?"),
      factFrameCapture: { status: "returned" },
      osfCapture: { status: "formed" }
    });
    expect(compiled.unresolved.some((row) => row.code === "unadapted_fact_frame")).toBe(true);
    expect(compiled.unresolved.some((row) => row.code === "unadapted_osf")).toBe(true);
    const otherFrames = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?"),
      factFrameCapture: {
        status: "returned",
        capture_digest: `sha256:${"a".repeat(64)}`
      },
      osfCapture: { status: "formed", capture_digest: `sha256:${"b".repeat(64)}` }
    });
    const shiftedFrames = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?"),
      factFrameCapture: {
        status: "returned",
        capture_digest: `sha256:${"c".repeat(64)}`
      },
      osfCapture: { status: "formed", capture_digest: `sha256:${"d".repeat(64)}` }
    });
    expect(otherFrames).not.toEqual(shiftedFrames);
    expect(otherFrames.unresolved.find((row) => row.code === "unadapted_fact_frame")
      ?.capture_digest).not.toBe(
      shiftedFrames.unresolved.find((row) => row.code === "unadapted_fact_frame")
        ?.capture_digest
    );
    const otherStatus = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?"),
      factFrameCapture: { status: "ineligible" },
      osfCapture: { status: "unavailable" }
    });
    expect(otherStatus.unresolved.some((row) => row.code === "unadapted_fact_frame")).toBe(true);
    expect(otherStatus.unresolved.some((row) => row.code === "unadapted_osf")).toBe(true);
    const pinnedDemand = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?"),
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
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    });
    const second = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    });
    expect(first).toEqual(second);
  });
});
