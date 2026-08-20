import { describe, expect, it } from "vitest";
import { factFrameWordPiecesCoverRun } from
  "../../../shared/fact-frame-grammar/source-text.js";

describe("fact-frame word-piece run coverage", () => {
  it("covers a longer contiguous CJK evidence run", () => {
    expect(factFrameWordPiecesCoverRun(
      ["每日", "通勤", "上班"],
      ["每日", "通勤", "上班", "路程"]
    )).toBe(true);
    expect(factFrameWordPiecesCoverRun(
      ["每日通勤上班"],
      ["每日通勤上班路程"]
    )).toBe(true);
  });

  it("covers a longer contiguous English token sequence", () => {
    expect(factFrameWordPiecesCoverRun(
      ["daily", "commute", "to", "work"],
      ["daily", "commute", "to", "work", "route"]
    )).toBe(true);
  });

  it("rejects a dropped English token", () => {
    expect(factFrameWordPiecesCoverRun(
      ["daily", "commute", "to", "work"],
      ["daily", "commute"]
    )).toBe(false);
  });

  it.each([
    [["每日通勤上班"], ["每天不上班通勤"]],
    [["通勤"], ["非通勤"]],
    [["上班"], ["没上班"]],
    [["通勤"], ["无通勤"]],
    [["每日", "通勤", "上班"], ["每天", "不", "上班", "通勤"]],
    [["每日", "通勤", "上班"], ["非", "通勤"]]
  ] as const)("fails closed on negated CJK %j", (query, evidence) => {
    expect(factFrameWordPiecesCoverRun(query, evidence)).toBe(false);
  });
});
