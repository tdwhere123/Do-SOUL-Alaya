import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  compileRecallAnswerShapePlan
} from "../../recall/query/recall-answer-shape-plan.js";

describe("recall answer-shape plan", () => {
  it.each([
    ["Where did I buy my new bookshelf from?", "place"],
    ["How long did I wait for the decision on my asylum application?", "duration"],
    ["How many months did I wait for the decision?", "count"],
    ["How many hours is my commute?", "count"],
    ["每天上班通勤要多久？", "duration"],
    ["每天上班通勤要多长时间？", "duration"],
    ["How many different doctors did I visit?", "distinct_entities"],
    ["How much total money have I spent on bike expenses?", "sum"],
    ["How many places did I visit?", "count"]
  ] as const)("classifies %s as a high-confidence %s slot", (query, shape) => {
    const plan = compileRecallAnswerShapePlan(compileRecallQueryProbes(query));

    expect(plan).toMatchObject({
      schema_version: 1,
      status: "high_confidence",
      shape
    });
    expect(plan.target_terms.length).toBeGreaterThan(0);
  });

  it("fails open when a query asks for independent answer slots", () => {
    const plan = compileRecallAnswerShapePlan(
      compileRecallQueryProbes("Where did I buy the bookshelf and how long did delivery take?")
    );

    expect(plan).toEqual({
      schema_version: 1,
      status: "ambiguous",
      shape: null,
      target_terms: [],
      relation_terms: []
    });
  });

  it("does not promote an unsupported monetary question into a sum", () => {
    const plan = compileRecallAnswerShapePlan(
      compileRecallQueryProbes("How much is one bike?")
    );

    expect(plan).toEqual({
      schema_version: 1,
      status: "unknown",
      shape: null,
      target_terms: [],
      relation_terms: []
    });
  });

  it("does not leak auxiliaries into answer targets", () => {
    const plan = compileRecallAnswerShapePlan(
      compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    );

    expect(plan.target_terms).toContain("bookshelf");
    expect(plan.target_terms).not.toContain("did");
  });
});
