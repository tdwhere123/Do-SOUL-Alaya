import { describe, expect, it } from "vitest";
import {
  answerCoRelevantPairKeysFromHq,
  normalizeHqTokens
} from "../../path-graph/producers/hq-answer-overlap.js";

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

describe("normalizeHqTokens CJK + multilingual", () => {
  it("segments a continuous CJK run into character bigrams", () => {
    const tokens = normalizeHqTokens(["数据库分析"]);
    expect([...tokens].sort()).toEqual(["数据", "据库", "库分", "分析"].sort());
  });

  it("strips CJK question-template bigrams (什么/时候/如何) leaving content", () => {
    const tokens = normalizeHqTokens(["什么时候开会"]);
    expect(tokens.has("什么")).toBe(false);
    expect(tokens.has("时候")).toBe(false);
    expect(tokens.has("开会")).toBe(true);
  });

  it("mixes Latin word tokens and CJK bigrams in one set", () => {
    const tokens = normalizeHqTokens(["用户偏好 PostgreSQL 吗?"]);
    expect(tokens.has("postgresql")).toBe(true);
    expect(tokens.has("用户")).toBe(true);
    expect(tokens.has("偏好")).toBe(true);
  });

  it("keeps an isolated single CJK char as a unigram", () => {
    expect([...normalizeHqTokens(["A 库 b"])]).toEqual(["库"]);
  });
});

describe("answerCoRelevantPairKeysFromHq CJK + multilingual", () => {
  it("pairs CJK memories sharing >= bar content bigrams", () => {
    const hq = new Map<string, readonly string[]>([
      ["a", ["用户喜欢哪个数据库做分析?"]],
      ["b", ["用户为什么选择那个分析数据库?"]]
    ]);
    // shared content bigrams: 用户, 分析, 数据, 据库 = 4.
    expect(answerCoRelevantPairKeysFromHq(hq, ["a", "b"], 3)).toEqual(new Set(["a|b"]));
  });

  it("does not pair CJK memories that share only template bigrams", () => {
    const hq = new Map<string, readonly string[]>([
      ["a", ["什么时候开会?"]],
      ["b", ["如何做什么决定?"]]
    ]);
    expect(answerCoRelevantPairKeysFromHq(hq, ["a", "b"], 3)).toEqual(new Set());
  });

  it("pairs across mixed Chinese-English HQs", () => {
    const hq = new Map<string, readonly string[]>([
      ["a", ["用户偏好 PostgreSQL 数据库吗?"]],
      ["b", ["Which PostgreSQL 数据库 is preferred?"]]
    ]);
    // shared: postgresql, 数据, 据库 = 3.
    expect(answerCoRelevantPairKeysFromHq(hq, ["a", "b"], 3)).toEqual(new Set(["a|b"]));
  });
});
