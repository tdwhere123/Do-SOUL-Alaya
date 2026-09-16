import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  segmentCjkRun,
  warmCjkSegmentation
} from "../index.js";
import { tokenizeFactFrameSource, bindCjkRunSegmenter } from "@do-soul/alaya-protocol/node/source-frame";

afterEach(() => {
  __resetCjkSegmentationStateForTests();
  vi.restoreAllMocks();
});

describe("CJK segmentation fallback", () => {
  it("splits interrogative atoms when jieba is unavailable", async () => {
    __setCjkSegmentationLoaderForTests(async () => null);
    expect(segmentCjkRun("多久部署")).toEqual(["多久", "部署"]);
    expect(segmentCjkRun("我爱北京")).toEqual(["我爱北京"]);
  });

  it("emits the surface CJK token when jieba is not yet warm", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    __setCjkSegmentationLoaderForTests(() => new Promise(() => undefined));
    expect(segmentCjkRun("我喜欢咖啡")).toEqual(["我喜欢咖啡"]);
    expect(emitWarning).toHaveBeenCalledWith(
      "[CjkSegmentation] @node-rs/jieba not ready; using surface-token fallback for this call",
      expect.objectContaining({
        code: "ALAYA_CJK_SEGMENTATION_COLD_FALLBACK"
      })
    );
    segmentCjkRun("我喜欢咖啡");
    expect(emitWarning).toHaveBeenCalledTimes(1);
  });

  it("emits a structured warning once when jieba native loading fails", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    __setCjkSegmentationLoaderForTests(async () => {
      throw new Error("mock jieba load failure");
    });
    await expect(warmCjkSegmentation()).resolves.toBe(false);
    expect(segmentCjkRun("我喜欢咖啡")).toEqual(["我喜欢咖啡"]);
    await expect(warmCjkSegmentation()).resolves.toBe(false);
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      "[CjkSegmentation] @node-rs/jieba unavailable; using surface-token fallback",
      expect.objectContaining({
        code: "ALAYA_CJK_SEGMENTATION_FALLBACK",
        detail: JSON.stringify({
          layer: "cjk-segmentation",
          error: "mock jieba load failure"
        })
      })
    );
  });
});

describe("CJK segmentation native owner", () => {
  it("loads jieba when the native binding is present", async () => {
    const ready = await warmCjkSegmentation();
    if (!ready) {
      throw new Error("jieba unavailable in test env; native binding missing");
    }
    const sample = "我喜欢咖啡";
    const pieces = Array.from(segmentCjkRun(sample));
    expect(pieces).toEqual(expect.arrayContaining(["喜欢", "咖啡"]));
    expect(tokenizeFactFrameSource(sample).map((token) => token.text)).toEqual(pieces);
    bindCjkRunSegmenter(() => ["hijacked"]);
    expect(segmentCjkRun(sample)).toEqual(pieces);
    expect(tokenizeFactFrameSource(sample).map((token) => token.text)).toEqual(pieces);
    expect(segmentCjkRun("")).toEqual([]);
  });
});
