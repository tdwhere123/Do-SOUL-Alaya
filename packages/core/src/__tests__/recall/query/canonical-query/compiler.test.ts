import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";
import { compileCanonicalQueryEvidence } from
  "../../../../recall/query/canonical-query/index.js";

describe("canonical query compiler adapters", () => {
  it("compiles supported English and CJK v1 programs", () => {
    const english = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    });
    expect(english.hypotheses.some((row) =>
      row.status === "supported" && row.query.answer.kind === "scalar")).toBe(true);
    const cjk = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("每天上班通勤要多久？")
    });
    expect(cjk.hypotheses.some((row) =>
      row.status === "supported" && row.query.answer.kind === "scalar")).toBe(true);
  });

  it("keeps count/sum and latest-without-time explicit", () => {
    const count = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("How many places did I visit?")
    });
    expect(count.hypotheses.some((row) =>
      row.status === "unsupported" && row.reason_code === "count_sum_unsupported")).toBe(true);
    const latest = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("What is the latest password?")
    });
    expect(latest.hypotheses.some((row) =>
      row.status === "unsupported"
      && row.reason_code === "latest_without_typed_time_key")).toBe(true);
    expect(latest.unresolved.some((row) => row.code === "unknown_time_basis")).toBe(true);
  });

  it("does not silently pick when demand and shape conflict", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where is the latest bookshelf?")
    });
    expect(compiled.unresolved.some((row) => row.code === "conflicting_demand_shape")
      || compiled.hypotheses.length > 1).toBe(true);
    const first = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    });
    const second = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    });
    expect(first).toEqual(second);
  });

  it("does not coerce unknown answers into empty demand", () => {
    const compiled = compileCanonicalQueryEvidence({
      probes: compileRecallQueryProbes("How much is one bike?")
    });
    expect(compiled.hypotheses.some((row) =>
      row.status === "supported" && row.query.predicates.length === 0
      && row.query.answer.kind === "scalar" && compiled.unresolved.length === 0)).toBe(false);
    expect(
      compiled.unresolved.length + compiled.hypotheses.filter((row) =>
        row.status === "unsupported").length
    ).toBeGreaterThan(0);
  });
});
