import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mergeKeywordSearchRows,
  tokenizeFtsQuery,
  type ExactKeywordSearchRow,
  type FtsKeywordSearchRow
} from "../../../repos/memory-entry/keyword-search.js";
import {
  __resetCjkSegmentationStateForTests,
  __setCjkSegmentationLoaderForTests,
  segmentCjkRun,
  warmCjkSegmentation
} from "../../../repos/shared/cjk-segmentation.js";

describe("mergeKeywordSearchRows trigram_rank passthrough", () => {
  it("surfaces a trigram_rank for objects that matched the trigram lane", () => {
    const exactRows: readonly ExactKeywordSearchRow[] = [];
    const trigramRows: readonly FtsKeywordSearchRow[] = [
      { object_id: "obj-trigram", raw_rank: -5 }
    ];
    const merged = mergeKeywordSearchRows(exactRows, trigramRows, 10);

    expect(merged).toEqual([
      { object_id: "obj-trigram", normalized_rank: 1, trigram_rank: 1 }
    ]);
  });

  it("omits trigram_rank for objects that only matched exact or porter lanes", () => {
    const exactRows: readonly ExactKeywordSearchRow[] = [
      { object_id: "obj-exact", matched_token_count: 2 }
    ];
    const porterRows: readonly FtsKeywordSearchRow[] = [
      { object_id: "obj-porter", raw_rank: -3 }
    ];
    const merged = mergeKeywordSearchRows(exactRows, [], 10, porterRows);

    expect(merged).toEqual([
      { object_id: "obj-exact", normalized_rank: 1 },
      { object_id: "obj-porter", normalized_rank: 1 }
    ]);
    expect(merged.every((row) => row.trigram_rank === undefined)).toBe(true);
  });

  it("carries the trigram-lane ordinal score even when a higher-priority lane wins the merged rank", () => {
    const exactRows: readonly ExactKeywordSearchRow[] = [
      { object_id: "obj-both", matched_token_count: 1 }
    ];
    const trigramRows: readonly FtsKeywordSearchRow[] = [
      { object_id: "obj-both", raw_rank: -9 },
      { object_id: "obj-trigram-only", raw_rank: -1 }
    ];
    const merged = mergeKeywordSearchRows(exactRows, trigramRows, 10);
    const byId = new Map(merged.map((row) => [row.object_id, row]));

    // The exact lane wins the merged normalized_rank for obj-both, yet its
    // distinct trigram-lane ordinal score is still surfaced for the
    // trigram_fts fusion stream to read.
    expect(byId.get("obj-both")?.trigram_rank).toBeGreaterThan(0);
    expect(byId.get("obj-trigram-only")?.trigram_rank).toBeGreaterThan(0);
  });
});

describe("tokenizeFtsQuery multilingual segmentation", () => {
  beforeAll(async () => {
    const ready = await warmCjkSegmentation();
    if (!ready) {
      throw new Error("jieba unavailable in test env; native binding missing");
    }
  });

  it("expands a Chinese-only query into jieba word pieces alongside the surface chunk", () => {
    const tokens = tokenizeFtsQuery("我喜欢咖啡");
    expect(tokens).toContain("我喜欢咖啡");
    expect(tokens).toEqual(expect.arrayContaining(["喜欢", "咖啡"]));
  });

  it("preserves Latin/ASCII tokens unchanged in a mixed CJK + Latin query", () => {
    const tokens = tokenizeFtsQuery("我用 ALAYA 记忆");
    expect(tokens).toContain("ALAYA");
    expect(tokens).toContain("记忆");
  });

  it("Korean (Hangul) tokens pass through whole — jieba degenerates so the surface form is the only output", () => {
    const tokens = tokenizeFtsQuery("안녕 ALAYA");
    expect(tokens).toContain("안녕");
    expect(tokens).toContain("ALAYA");
  });

  it("Arabic tokens flow through the regex split intact", () => {
    const tokens = tokenizeFtsQuery("مرحبا ALAYA");
    expect(tokens).toContain("مرحبا");
    expect(tokens).toContain("ALAYA");
  });

  it("English-only queries are byte-identical to the pre-segmentation behaviour", () => {
    expect(tokenizeFtsQuery("hello world")).toEqual(["hello", "world"]);
  });

  it("strips FTS5 reserved punctuation from jieba pieces just like surface tokens", () => {
    const tokens = tokenizeFtsQuery('"我喜欢咖啡"');
    for (const token of tokens) {
      expect(token).not.toMatch(/["*:]/);
    }
  });
});

describe("tokenizeFtsQuery CJK segmentation fail-soft", () => {
  afterEach(() => {
    __resetCjkSegmentationStateForTests();
    vi.restoreAllMocks();
  });

  it("emits the surface CJK token when jieba is not yet warm so FTS5 still gets a match expression", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    __setCjkSegmentationLoaderForTests(() => new Promise(() => undefined));
    const tokens = tokenizeFtsQuery("我喜欢咖啡");
    expect(tokens).toContain("我喜欢咖啡");
    expect(tokens).not.toContain("喜欢");
    expect(emitWarning).toHaveBeenCalledWith(
      "[CjkSegmentation] @node-rs/jieba not ready; using surface-token fallback for this call",
      expect.objectContaining({
        code: "ALAYA_STORAGE_CJK_SEGMENTATION_COLD_FALLBACK"
      })
    );

    tokenizeFtsQuery("我喜欢咖啡");
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
        code: "ALAYA_STORAGE_CJK_SEGMENTATION_FALLBACK",
        detail: JSON.stringify({
          layer: "storage",
          error: "mock jieba load failure"
        })
      })
    );
  });
});
