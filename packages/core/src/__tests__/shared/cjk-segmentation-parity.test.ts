import { describe, expect, it } from "vitest";
import {
  readCjkSegmentationStatus as readCoreStatus,
  segmentCjkRun as segmentCore,
  warmCjkSegmentation as warmCore
} from "../../shared/cjk-segmentation.js";
import {
  readCjkSegmentationStatus as readStorageStatus,
  segmentCjkRun as segmentStorage,
  warmCjkSegmentation as warmStorage
} from "../../../../storage/src/repos/shared/cjk-segmentation.js";

describe("CJK segmentation copies", () => {
  it("segments the same Han input when jieba is ready on both layers", async () => {
    await Promise.all([warmCore(), warmStorage()]);
    const input = "我爱北京天安门";
    if (readCoreStatus() === "ready" && readStorageStatus() === "ready") {
      expect(segmentCore(input)).toEqual(segmentStorage(input));
      return;
    }
    // Cold/unavailable fallback is intentionally different: core splits
    // interrogative atoms, storage keeps the whole run for FTS.
    expect(segmentCore(input).join("")).toBe(input);
    expect(segmentStorage(input)).toEqual([input]);
  });
});
