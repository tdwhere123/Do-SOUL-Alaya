import { describe, expect, it } from "vitest";
import {
  answerCoRelevantPairKeysFromHq,
  normalizeHqTokens
} from "../../path-graph/hq-answer-overlap.js";

describe("normalizeHqTokens", () => {
  it("lowercases, folds whitespace, and drops question-template + stop words", () => {
    const tokens = normalizeHqTokens(["What   database  does the USER prefer?"]);
    // "what", "does", "the" are template/stop words; content survives lowercased.
    expect([...tokens].sort()).toEqual(["database", "prefer", "user"]);
  });

  it("pools tokens across a memory's HQ list", () => {
    const tokens = normalizeHqTokens(["Which database engine?", "How is Postgres tuned?"]);
    expect(tokens.has("database")).toBe(true);
    expect(tokens.has("postgres")).toBe(true);
    expect(tokens.has("which")).toBe(false);
  });

  it("drops single-character tokens", () => {
    expect([...normalizeHqTokens(["A b cd"])]).toEqual(["cd"]);
  });
});

describe("answerCoRelevantPairKeysFromHq", () => {
  const HQ = new Map<string, readonly string[]>([
    ["a", ["What database does the user prefer for analytics?"]],
    ["b", ["Which analytics database did the user choose?"]],
    ["c", ["What is the user's favorite hiking trail?"]]
  ]);

  it("pairs memories that share >= bar content tokens", () => {
    // a∩b = {database, user, analytics} = 3 shared content tokens.
    expect(answerCoRelevantPairKeysFromHq(HQ, ["a", "b", "c"], 3)).toEqual(new Set(["a|b"]));
  });

  it("does not pair memories below the bar (template-word overlap is stripped)", () => {
    // a∩c shares only "user" (1) after stop/template removal -> no pair at bar 3.
    expect(answerCoRelevantPairKeysFromHq(HQ, ["a", "c"], 3)).toEqual(new Set());
  });

  it("emits canonical low|high keys regardless of input order", () => {
    expect(answerCoRelevantPairKeysFromHq(HQ, ["b", "a"], 3)).toEqual(new Set(["a|b"]));
  });

  it("ignores objects without HQ rows", () => {
    expect(answerCoRelevantPairKeysFromHq(HQ, ["a", "b", "missing"], 3)).toEqual(new Set(["a|b"]));
  });

  it("a higher bar suppresses weak overlaps", () => {
    expect(answerCoRelevantPairKeysFromHq(HQ, ["a", "b", "c"], 4)).toEqual(new Set());
  });
});
