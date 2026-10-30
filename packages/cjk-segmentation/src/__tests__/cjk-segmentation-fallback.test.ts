import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  analyzeSourceIndexLexical,
  advanceSourceIndexLexicalV2,
  readCjkSegmentationStatus,
  readSourceIndexLexicalAnalysisStatus,
  segmentCjkRun,
  warmCjkSegmentation
} from "../index.js";
import { tokenizeFactFrameSource, bindCjkRunSegmenter } from "@do-soul/alaya-protocol/node/source-frame";

afterEach(() => {
  __resetCjkSegmentationStateForTests();
  vi.restoreAllMocks();
});

it("keeps bounded surface-token segmentation identical across source read boundaries", async () => {
  __setCjkSegmentationLoaderForTests(async () => ({ cut: token => {
    const chars = Array.from(token), pieces: string[] = [];
    for (let i = 0; i < chars.length; i += 2) pieces.push(chars.slice(i, i + 2).join(""));
    return pieces;
  } }));
  await expect(warmCjkSegmentation()).resolves.toBe(true);
  const text = `prefix ${"甲乙".repeat(9)}天地${"甲乙".repeat(30)} 🙂 suffix`;
  const whole = advanceSourceIndexLexicalV2(text, "", true);
  let pending = "", projection = "";
  const characters = Array.from(text);
  for (let offset = 0; offset < characters.length; offset += 7) {
    const result = advanceSourceIndexLexicalV2(characters.slice(offset, offset + 7).join(""), pending,
      offset + 7 >= characters.length);
    pending = result.pending;
    projection += `${result.projection} `;
  }
  expect(pending).toBe("");
  expect(projection.trim().split(/\s+/u)).toEqual(whole.projection.trim().split(/\s+/u));
  expect(analyzeSourceIndexLexical("天地", "query", "v2")).toEqual(["天地"]);
  expect(whole.projection.trim().split(/\s+/u)).toContain("天地");
});

describe("CJK segmentation fallback", () => {
  it("splits interrogative atoms when jieba is unavailable", async () => {
    __setCjkSegmentationLoaderForTests(async () => null);
    await expect(warmCjkSegmentation()).resolves.toBe(false);
    expect(readCjkSegmentationStatus()).toBe("unavailable");
    expect(segmentCjkRun("多久部署")).toEqual(["多久", "部署"]);
    expect(segmentCjkRun("我爱北京")).toEqual(["我爱北京"]);
  });

  it("emits the surface CJK token when jieba is not yet warm", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    __setCjkSegmentationLoaderForTests(() => new Promise(() => undefined));
    expect(segmentCjkRun("我喜欢咖啡")).toEqual(["我喜欢咖啡"]);
    expect(readCjkSegmentationStatus()).toBe("loading");
    expect(emitWarning).toHaveBeenCalledWith(
      "[CjkSegmentation] @node-rs/jieba not ready; using surface-token fallback for this call",
      expect.objectContaining({
        code: "ALAYA_CJK_SEGMENTATION_COLD_FALLBACK"
      })
    );
    segmentCjkRun("我喜欢咖啡");
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(readCjkSegmentationStatus()).toBe("loading");
  });

  it("does not start loading when initialize is false, but uses a warm segmenter", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    let loads = 0;
    __setCjkSegmentationLoaderForTests(async () => {
      loads += 1;
      return { cut: () => ["喜欢", "咖啡"] };
    });
    expect(segmentCjkRun("我喜欢咖啡", { initialize: false })).toEqual(["我喜欢咖啡"]);
    expect(readCjkSegmentationStatus()).toBe("uninitialized");
    expect(loads).toBe(0);
    expect(emitWarning).not.toHaveBeenCalled();
    await expect(warmCjkSegmentation()).resolves.toBe(true);
    expect(readCjkSegmentationStatus()).toBe("ready");
    expect(segmentCjkRun("我喜欢咖啡", { initialize: false })).toEqual(["喜欢", "咖啡"]);
    expect(readCjkSegmentationStatus()).toBe("ready");
    expect(loads).toBe(1);
  });

  it("keeps an in-flight load in loading when initialize is false", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    __setCjkSegmentationLoaderForTests(() => new Promise(() => undefined));
    expect(segmentCjkRun("我喜欢咖啡")).toEqual(["我喜欢咖啡"]);
    expect(readCjkSegmentationStatus()).toBe("loading");
    expect(segmentCjkRun("我爱北京", { initialize: false })).toEqual(["我爱北京"]);
    expect(readCjkSegmentationStatus()).toBe("loading");
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

describe("strict source lexical analysis", () => {
  it("rejects cold analysis without initializing native state", () => {
    expect(() => analyzeSourceIndexLexical("中文", "source")).toThrow("segmenter_uninitialized");
    expect(readCjkSegmentationStatus()).toBe("uninitialized");
  });

  it.each([{ pieces: [] }, { pieces: [" "] }, { pieces: ["改写"] }])("latches invalid v2 output %j without disabling legacy segmentation", async ({ pieces }) => {
    __setCjkSegmentationLoaderForTests(async () => ({ cut: () => pieces }));
    await warmCjkSegmentation();
    expect(() => analyzeSourceIndexLexical("中文", "query", "v2")).toThrow(/segmenter_(invalid|nonconserving)_output/u);
    expect(readSourceIndexLexicalAnalysisStatus()).toBe("unavailable");
    expect(readCjkSegmentationStatus()).toBe("ready");
    expect(() => analyzeSourceIndexLexical("中文", "source")).toThrow("segmenter_unavailable");
    expect(segmentCjkRun("中文")).toEqual(pieces.length === 0 || pieces[0] === " " ? ["中文"] : pieces);
  });

  it("bounds query segmentation by UTF-8 bytes while preserving multibyte characters", async () => {
    const calls: string[] = [];
    __setCjkSegmentationLoaderForTests(async () => ({ cut: token => { calls.push(token); return [token]; } }));
    await warmCjkSegmentation();
    const text = "甲".repeat(22);
    expect(analyzeSourceIndexLexical(text, "query", "v2")).toEqual([text, "甲".repeat(21)]);
    expect(calls).toEqual(["甲".repeat(21), "甲"]);
    const work: number[] = [];
    const result = advanceSourceIndexLexicalV2("甲乙", "", true, units => work.push(units));
    expect(result).toEqual({ projection: "甲乙", pending: "", expanded_units: 2 });
    expect(work).toEqual([2, 2]);
  });

  it("shares an in-flight warmup and reuses the ready segmenter", async () => {
    let release!: (value: { cut(input: string): readonly string[] }) => void;
    const loader = vi.fn(() => new Promise<{ cut(input: string): readonly string[] }>(resolve => { release = resolve; }));
    __setCjkSegmentationLoaderForTests(loader);
    const first = warmCjkSegmentation(), second = warmCjkSegmentation();
    expect(loader).toHaveBeenCalledTimes(1);
    release({ cut: token => [token] });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(warmCjkSegmentation()).resolves.toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
