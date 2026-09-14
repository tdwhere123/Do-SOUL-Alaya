import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  segmentCjkRun
} from "../../shared/cjk-segmentation.js";

afterEach(() => {
  __resetCjkSegmentationStateForTests();
});

describe("CJK segmentation fallback", () => {
  it("splits interrogative atoms when jieba is unavailable", async () => {
    __setCjkSegmentationLoaderForTests(async () => null);
    expect(segmentCjkRun("多久部署")).toEqual(["多久", "部署"]);
    expect(segmentCjkRun("我爱北京")).toEqual(["我爱北京"]);
  });
});
