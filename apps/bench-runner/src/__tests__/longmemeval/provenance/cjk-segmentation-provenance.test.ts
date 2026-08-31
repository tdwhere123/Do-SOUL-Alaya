import { afterEach, describe, expect, it } from "vitest";
import {
  CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests
} from "@do-soul/alaya-core";
import {
  STORAGE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE,
  __resetStorageCjkSegmentationStateForTests
} from "@do-soul/alaya-storage";
import { collectCjkSegmentationProvenance } from
  "../../../runs/provenance/cjk-segmentation.js";
import { warmCjkSegmentation } from "@do-soul/alaya-core";

afterEach(() => {
  __resetCjkSegmentationStateForTests();
  __resetStorageCjkSegmentationStateForTests();
});

describe("collectCjkSegmentationProvenance", () => {
  it("records the jieba fallback warning when core segmentation is unavailable", async () => {
    __setCjkSegmentationLoaderForTests(async () => {
      throw new Error("mock jieba load failure");
    });
    await expect(warmCjkSegmentation()).resolves.toBe(false);

    const provenance = collectCjkSegmentationProvenance();
    expect(provenance.core_status).toBe("unavailable");
    expect(provenance.warnings).toContain(CJK_SEGMENTATION_FALLBACK_WARNING_CODE);
    expect(STORAGE_CJK_SEGMENTATION_FALLBACK_WARNING_CODE).toMatch(/^ALAYA_STORAGE_/u);
  });
});
