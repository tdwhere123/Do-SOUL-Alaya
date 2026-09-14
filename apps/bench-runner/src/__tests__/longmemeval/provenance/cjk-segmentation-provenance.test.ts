import { afterEach, describe, expect, it } from "vitest";
import {
  CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  warmCjkSegmentation
} from "@do-soul/alaya-protocol";
import { collectCjkSegmentationProvenance } from
  "../../../runs/provenance/cjk-segmentation.js";

afterEach(() => {
  __resetCjkSegmentationStateForTests();
});

describe("collectCjkSegmentationProvenance", () => {
  it("records the jieba fallback warning when segmentation is unavailable", async () => {
    __setCjkSegmentationLoaderForTests(async () => {
      throw new Error("mock jieba load failure");
    });
    await expect(warmCjkSegmentation()).resolves.toBe(false);

    const provenance = collectCjkSegmentationProvenance();
    expect(provenance.core_status).toBe("unavailable");
    expect(provenance.storage_status).toBe("unavailable");
    expect(provenance.warnings).toEqual([CJK_SEGMENTATION_FALLBACK_WARNING_CODE]);
  });
});
