import { describe, expect, it } from "vitest";
import { resolveSourceAssertion } from "../../../garden/grounding/source-assertion.js";

describe("source assertion CJK grounding", () => {
  it.each([
    ["他住在北京。", "他住在北京。", "他住在北京。"],
    ["她在上海工作。", "她在上海工作。", "她在上海工作。"],
    ["它位于市中心。", "它位于市中心。", "它位于市中心。"],
    ["他们下周出发。", "他们下周出发。", "他们下周出发。"],
    ["我住在杭州。", "我住在杭州。", "我住在杭州。"],
    ["小明住在北京。", "小明住在北京。", "小明住在北京。"],
    ["小明在OpenAI工作。", "小明在OpenAI工作。", "小明在OpenAI工作。"]
  ])("grounds complete CJK facts: %s", (source, matchedText, assertion) => {
    expect(resolveSourceAssertion(source, matchedText)).toEqual({ status: "grounded", assertion });
  });

  it.each([
    ["用户: 我住在上海。", "用户: 我住在上海。", "我住在上海。"],
    ["助手: 我住在上海。", "助手: 我住在上海。", "我住在上海。"],
    ["团队: 项目已上线。", "团队: 项目已上线。", "项目已上线。"],
    ["User: I live in Shanghai.", "User: I live in Shanghai.", "I live in Shanghai."],
    ["Assistant: I live in Shanghai.", "Assistant: I live in Shanghai.", "I live in Shanghai."],
    ["助手: 他住在北京。", "助手: 他住在北京。", "他住在北京。"]
  ])("strips role labels before grounding: %s", (source, matchedText, assertion) => {
    expect(resolveSourceAssertion(source, matchedText)).toEqual({ status: "grounded", assertion });
  });

  it.each([
    ["该公司成立于2020年。", "该公司成立于2020年。"],
    ["其人尚未到场。", "其人尚未到场。"],
    ["此人负责审核。", "此人负责审核。"],
    ["如此安排不妥。", "如此安排不妥。"],
    ["此种做法不可取。", "此种做法不可取。"],
    ["这个方案已通过。", "这个方案已通过。"],
    ["这项规则已经生效。", "这项规则已经生效。"],
    ["这是事实。", "这是事实。"],
    ["那很重要。", "那很重要。"],
    ["那已经完成。", "那已经完成。"],
    ["该计划已经生效。", "该计划已经生效。"],
    ["前者更为稳妥。", "前者更为稳妥。"],
    ["该项规则已生效。", "该项规则已生效。"]
  ])("rejects discourse-dependent CJK anaphora: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toMatchObject({
      status: "rejected",
      reason: "source_assertion_not_self_contained"
    });
  });

  it.each([
    ["他。", "他。"],
    ["她", "她"],
    ["他们。", "他们。"],
    ["它", "它"]
  ])("rejects bare third-person stubs as incomplete: %s", (source, matchedText) => {
    expect(resolveSourceAssertion(source, matchedText)).toMatchObject({
      status: "rejected",
      reason: "source_assertion_incomplete"
    });
  });

  it("rejects a third-person sentence that refers to the preceding source sentence", () => {
    expect(resolveSourceAssertion(
      "我写了一个方案。它已经通过审核。",
      "它已经通过审核。"
    )).toMatchObject({
      status: "rejected",
      reason: "source_assertion_not_self_contained"
    });
  });

  it("rejects a newline-separated reference to an earlier source sentence", () => {
    expect(resolveSourceAssertion(
      "我写了一个方案。\n它已经通过审核。",
      "它已经通过审核。"
    )).toMatchObject({
      status: "rejected",
      reason: "source_assertion_not_self_contained"
    });
  });
});
