import { beforeAll, describe, expect, it } from "vitest";
import {
  isCjkSegmentationCandidate,
  segmentCjkRun,
  warmCjkSegmentation
} from "@do-soul/alaya-protocol/cjk-segmentation";

const CJK_FIXTURES: readonly string[] = [
  "我喜欢咖啡",
  "部署流水线",
  "昨天我们确认了 v0.3.7 召回方案",
  "今天明天昨天",
  "记忆系统优化",
  "オープンソース",
  "東京駅で会いましょう",
  "ひらがな"
];

describe("cjk-segmentation protocol owner", () => {
  beforeAll(async () => {
    const ready = await warmCjkSegmentation();
    if (!ready) {
      throw new Error("jieba unavailable in test env; native binding missing");
    }
  });

  it.each(CJK_FIXTURES)("segmentCjkRun tokenizes %s when jieba is ready", (sample) => {
    expect(isCjkSegmentationCandidate(sample)).toBe(true);
    expect(Array.from(segmentCjkRun(sample)).length).toBeGreaterThan(0);
  });

  it("empty input yields empty output", () => {
    expect(Array.from(segmentCjkRun(""))).toEqual([]);
  });
});
