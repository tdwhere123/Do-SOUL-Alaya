import { beforeAll, describe, expect, it } from "vitest";
import {
  COPULAR_MEASURE_WORDS,
  isRuleBasedCopularMeasureValue,
  RuleBasedQueryFactFrameExtractor
} from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import { captureRecallQueryFactFrames } from
  "../../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { deriveQueryFactFrameOsfObligation } from
  "../../../../recall/field/open-semantic-factors/query-obligation.js";
import { warmCjkSegmentation } from "../../../../shared/cjk-segmentation.js";

const extractor = new RuleBasedQueryFactFrameExtractor();

describe("query fact-frame OSF obligation", () => {
  beforeAll(async () => {
    const ready = await warmCjkSegmentation();
    if (!ready) throw new Error("jieba unavailable in test env; native binding missing");
  });

  it("certifies the narrow G6 binary layout from the rule-based parse trace", async () => {
    const obligation = await derive("What degree did I graduate with?");
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: "graduate", source_span: [18, 26] },
      subject: { surface: "I", source_span: [16, 17], position: 0 },
      value: { surface: "What degree", source_span: [0, 11], position: 1 },
      constraints: [],
      arity: 2
    });
  });

  it("certifies a copular duration layout without overlapping its nodes", async () => {
    expect(COPULAR_MEASURE_WORDS.has("long")).toBe(true);
    expect(isRuleBasedCopularMeasureValue("How long")).toBe(true);
    const obligation = await derive("How long is my daily commute to work?");
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: "is", source_span: [9, 11] },
      subject: { surface: "my daily commute to work", source_span: [12, 36], position: 0 },
      value: { surface: "How long", source_span: [0, 8], position: 1 },
      constraints: [],
      arity: 2
    });
  });

  it("certifies ordered grounded tail constraints before a location result", async () => {
    const obligation = await derive("Where did I redeem a $5 coupon on coffee creamer?");
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: "redeem", source_span: [12, 18] },
      subject: { surface: "I", source_span: [10, 11], position: 0 },
      constraints: [
        { surface: "a $5 coupon on coffee creamer", source_span: [19, 48], position: 1 }
      ],
      value: { surface: "Where", source_span: [0, 5], position: 2 },
      arity: 3
    });
  });

  it("certifies CJK WH-final duration on the same binary layout", async () => {
    const obligation = await derive("每天上班通勤要多久？");
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: "要", source_span: [6, 7] },
      subject: { surface: "每天上班通勤", source_span: [0, 6], position: 0 },
      value: { surface: "多久", source_span: [7, 9], position: 1 },
      constraints: [],
      arity: 2
    });
  });

  it("certifies CJK 多长时间 as the same copular measure value", async () => {
    const obligation = await derive("每天上班通勤要多长时间？");
    expect(obligation).toMatchObject({
      predicate: { surface: "要" },
      subject: { surface: "每天上班通勤", position: 0 },
      value: { surface: "多长时间", position: 1 },
      constraints: [],
      arity: 2
    });
  });

  it("certifies CJK medial where with one grounded tail constraint", async () => {
    const obligation = await derive("我在哪里兑换了咖啡奶精优惠券？");
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: "兑换", source_span: [4, 6] },
      subject: { surface: "我", source_span: [0, 1], position: 0 },
      constraints: [
        { surface: "咖啡奶精优惠券", source_span: [7, 14], position: 1 }
      ],
      value: { surface: "哪里", source_span: [2, 4], position: 2 },
      arity: 3
    });
  });

  it("certifies CJK 何处 as the same location result slot", async () => {
    const obligation = await derive("我在何处兑换了咖啡奶精优惠券？");
    expect(obligation).toMatchObject({
      predicate: { surface: "兑换" },
      subject: { surface: "我", position: 0 },
      constraints: [{ surface: "咖啡奶精优惠券", position: 1 }],
      value: { surface: "何处", position: 2 },
      arity: 3
    });
  });

  it("certifies CJK 哪儿 on the same verbal where layout", async () => {
    const obligation = await derive("我在哪儿兑换了咖啡奶精优惠券？");
    expect(obligation).toMatchObject({
      predicate: { surface: "兑换", source_span: [4, 6] },
      subject: { surface: "我", source_span: [0, 1], position: 0 },
      constraints: [
        { surface: "咖啡奶精优惠券", source_span: [7, 14], position: 1 }
      ],
      value: { surface: "哪儿", source_span: [2, 4], position: 2 },
      arity: 3
    });
  });

  it.each([
    ["优惠券在哪里？", "哪里", "在"],
    ["优惠券在何处？", "何处", "在"],
    ["优惠券在哪儿？", "哪儿", "在"]
  ])("certifies copular location %s on the Where slot", async (query, value, predicate) => {
    const obligation = await derive(query);
    expect(obligation).toMatchObject({
      operator_id: "query_fact_frame_osf_obligation_v2",
      predicate: { surface: predicate, source_span: [3, 4] },
      subject: { surface: "优惠券", source_span: [0, 3], position: 0 },
      value: { surface: value, source_span: [4, 6], position: 1 },
      constraints: [],
      arity: 2
    });
  });

  it.each([
    "What did Alice buy at the market?",
    "What did Alice give Bob?",
    "What and where did Alice travel?",
    "What degree did What degree graduate with?",
    "How old is my child?",
    "When is the meeting?",
    "每天上班通勤要四十五分钟。",
    "孩子多大了？",
    "会议是几点？",
    "黄金是一种金属。",
    "Golden is a color."
  ])("leaves unsupported or explicit-extra layouts unavailable: %s", async (query) => {
    await expect(derive(query)).resolves.toBeNull();
  });
});

async function derive(query: string) {
  const capture = await captureRecallQueryFactFrames({
    query_text: query,
    port: extractor
  });
  return deriveQueryFactFrameOsfObligation({ query_text: query, fact_frame_capture: capture });
}
