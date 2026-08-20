import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import { parseDurationExtent } from
  "../../../../recall/field/open-semantic-factors/duration/measure.js";
import { normalizeDurationUnit } from
  "../../../../recall/query/duration-unit-family.js";

const QUERY_TEXT = "How long is my daily commute to work?";
const HOURS_QUERY = "How many hours is my daily commute to work?";

describe("duration measure value unit and direction", () => {
  it("aligns canonical Chinese units to the shared duration family", () => {
    expect(parseDurationExtent("四十五分钟")).toEqual({ amount: 45, unit: "minute" });
    expect(parseDurationExtent("45分钟")).toEqual({ amount: 45, unit: "minute" });
    expect(parseDurationExtent("三小时")).toEqual({ amount: 3, unit: "hour" });
    expect(parseDurationExtent("十秒")).toEqual({ amount: 10, unit: "second" });
    expect(parseDurationExtent("两天")).toEqual({ amount: 2, unit: "day" });
    expect(normalizeDurationUnit("分钟")).toBe(normalizeDurationUnit("minutes"));
    expect(normalizeDurationUnit("小时")).toBe(normalizeDurationUnit("hours"));
    expect(normalizeDurationUnit("秒")).toBe(normalizeDurationUnit("seconds"));
    expect(normalizeDurationUnit("天")).toBe(normalizeDurationUnit("days"));
    expect(parseDurationExtent("一周")).toEqual({ amount: 1, unit: "week" });
    expect(parseDurationExtent("三个星期")).toEqual({ amount: 3, unit: "week" });
    expect(parseDurationExtent("一个月")).toEqual({ amount: 1, unit: "month" });
    expect(parseDurationExtent("三年")).toEqual({ amount: 3, unit: "year" });
    expect(parseDurationExtent("半小时")).toEqual({ amount: 0.5, unit: "hour" });
    expect(parseDurationExtent("三个小时")).toEqual({ amount: 3, unit: "hour" });
    expect(parseDurationExtent("a week")).toEqual({ amount: 1, unit: "week" });
    expect(parseDurationExtent("3 months")).toEqual({ amount: 3, unit: "month" });
    expect(parseDurationExtent("2 years")).toEqual({ amount: 2, unit: "year" });
    expect(parseDurationExtent("half an hour")).toEqual({ amount: 0.5, unit: "hour" });
    expect(normalizeDurationUnit("周")).toBe(normalizeDurationUnit("weeks"));
    expect(normalizeDurationUnit("星期")).toBe(normalizeDurationUnit("weeks"));
    expect(normalizeDurationUnit("月")).toBe(normalizeDurationUnit("months"));
    expect(normalizeDurationUnit("年")).toBe(normalizeDurationUnit("years"));
    expect(receipt(commuteDuration("一个月", "一个月"))).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
    expect(receipt(commuteDuration("三个小时", "三个小时"))).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
    expect(receipt(commuteDuration("half an hour", "half an hour"))).toMatchObject({
      status: "compatible",
      matched_query_proposition_count: 1
    });
  });

  it.each([
    ["三岁", "age"],
    ["三点", "clock"],
    ["第二次", "ordinal leftover"],
    ["四十五公斤", "wrong unit"]
  ] as const)("does not parse %s as a duration extent", (surface) => {
    expect(parseDurationExtent(surface)).toBeNull();
  });

  it("rejects an age compound that is not a duration extent", () => {
    expect(receipt(ageCompoundEvidence())).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("rejects leftover content after a unit token", () => {
    expect(receipt(secondLookEvidence())).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("rejects a how-many-hours surface that the obligation owner does not certify", () => {
    expect(receipt(listenMinutes(), hoursQuery())).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("fails closed when two duration measures disagree", () => {
    expect(receipt(dualMeasureEvidence())).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it.each([
    ["45 minutes ago", "ago"],
    ["since 45 minutes", "since"],
    ["until 45 minutes", "until"]
  ] as const)("rejects %s as a temporal point rather than an extent", (surface) => {
    expect(receipt(framedExtentEvidence(surface))).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });

  it("does not accept duration identity without a parsed extent", () => {
    expect(receipt(identityOnlyDuration())).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
  });
});

function receipt(
  evidence: ReturnType<typeof listenMinutes>,
  query = copularQuery("How long")
) {
  return materializeOpenSemanticFactorCompatibility({
    evidence_capture: evidence,
    query_capture: query
  });
}

function copularQuery(resultSurface: string) {
  const text = resultSurface === "How long" ? QUERY_TEXT : HOURS_QUERY;
  return formation("query", text, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("predicate", "is", "be"),
      factor("subject", "my daily commute to work", "my daily commute to work")
    ],
    variables: [{ variable_id: "answer", surface: resultSurface }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "commute-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "variable", "answer")
      ]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function hoursQuery() {
  return copularQuery("How many hours");
}

function listenMinutes() {
  return commuteDuration("45-minute", "45 minutes");
}

function ageCompoundEvidence() {
  return commuteDuration("3-year-old", "3-year-old");
}

function secondLookEvidence() {
  return commuteDuration("a second look", "a second look");
}

function dualMeasureEvidence() {
  return formation("evidence", "My daily commute to work takes 45 minutes or 2 hours.", {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("predicate", "takes", "duration"),
      factor("subject", "daily commute to work", "daily commute to work"),
      factor("short", "45 minutes", "45 minutes"),
      factor("long", "2 hours", "2 hours")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "duration-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "factor", "short"),
        argument(2, "duration", "factor", "long")
      ]
    }]
  });
}

function framedExtentEvidence(surface: string) {
  return commuteDuration(surface, surface);
}

function identityOnlyDuration() {
  return commuteDuration("duration", "duration");
}

function commuteDuration(surface: string, identity: string) {
  return formation("evidence", `My daily commute to work takes ${surface}.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("predicate", "takes", "duration"),
      factor("subject", "daily commute to work", "daily commute to work"),
      factor("value", surface, identity)
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "duration-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "factor", "value")
      ]
    }]
  });
}

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  graph: unknown,
  producerOperatorId = "open-factor-test-producer-v1"
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: producerOperatorId,
      source_text: sourceText,
      graph
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
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
