import { describe, expect, it } from "vitest";
import {
  mergeFtsLanes,
  splitFtsLanes,
  tokenizeFtsQuery,
  ftsSurfaceTokens,
  TRIGRAM_MIN_CODEPOINTS,
  type FtsLaneHit
} from "../../recall/fts-search-policy.js";

it("keeps ordered FTS surface spans without folding, segmentation, deduplication or length filtering", () => {
  const text = "😀A a A_1,甲乙 café café 𝒜";
  const tokens = ftsSurfaceTokens(text);
  expect(tokens.map(token => token.text)).toEqual(["A", "a", "A_1", "甲乙", "café", "cafe", "𝒜"]);
  expect(tokens.map(token => text.slice(token.start, token.end))).toEqual(tokens.map(token => token.text));
  expect(tokens[0]).toEqual({ text: "A", start: 2, end: 3 });
  expect(tokens.at(-1)!.end - tokens.at(-1)!.start).toBe(2);
  expect(ftsSurfaceTokens("x ".repeat(20))).toHaveLength(20);
});

describe("splitFtsLanes", () => {
  it("routes plain word tokens to the porter lane", () => {
    const split = splitFtsLanes(["deployment", "pipeline"]);
    expect(split.porterTokens).toEqual(["deployment", "pipeline"]);
    expect(split.trigramTokens).toEqual([]);
  });

  it("routes CJK-bearing tokens to the trigram lane", () => {
    const split = splitFtsLanes(["部署流水线"]);
    expect(split.porterTokens).toEqual([]);
    expect(split.trigramTokens).toEqual(["部署流水线"]);
  });

  it("fans a mixed-script query out to both lanes", () => {
    const split = splitFtsLanes(["pipeline", "部署流水线"]);
    expect(split.porterTokens).toEqual(["pipeline"]);
    expect(split.trigramTokens).toEqual(["部署流水线"]);
  });

  it("routes a CJK token shorter than the trigram minimum to the porter fallback", () => {
    const shortCjk = "部署";
    expect(Array.from(shortCjk).length).toBeLessThan(TRIGRAM_MIN_CODEPOINTS);
    const split = splitFtsLanes([shortCjk]);
    expect(split.porterTokens).toEqual([shortCjk]);
    expect(split.trigramTokens).toEqual([]);
  });
});

describe("tokenizeFtsQuery", () => {
  it("splits on non-word chars and drops sub-2-char terms", () => {
    expect(tokenizeFtsQuery("deployment, pipeline! a")).toEqual([
      "deployment",
      "pipeline"
    ]);
  });

  it("caps the token set at 16 tokens", () => {
    const many = Array.from({ length: 40 }, (_, i) => `tok${i}`).join(" ");
    expect(tokenizeFtsQuery(many)).toHaveLength(16);
  });

  it("keeps CJK surface tokens and optional word pieces for downstream lane routing", () => {
    expect(tokenizeFtsQuery("部署流水线 deployment", {
      shouldSegmentToken: (token) => token === "部署流水线",
      segmentToken: () => ["部署", "流水线"]
    })).toEqual([
      "部署流水线",
      "部署",
      "流水线",
      "deployment"
    ]);
  });

  it("does not NFKC-normalize the query", () => {
    expect(tokenizeFtsQuery("ＡＢＣ deployment")).toEqual([
      "ＡＢＣ",
      "deployment"
    ]);
  });
});

describe("mergeFtsLanes", () => {
  const hit = (objectId: string, rank: number): FtsLaneHit =>
    Object.freeze({ object_id: objectId, normalized_rank: rank });

  it("orders the merged result by descending normalized rank", () => {
    const merged = mergeFtsLanes([hit("p1", 1), hit("p2", 0.4)], [hit("t1", 0.7)], 10);
    expect(merged.map((entry) => entry.object_id)).toEqual(["p1", "t1", "p2"]);
  });

  it("breaks an exact cross-lane tie toward the porter lane, not object_id", () => {
    const merged = mergeFtsLanes([hit("z-porter", 1)], [hit("a-trigram", 1)], 10);
    expect(merged[0]?.object_id).toBe("z-porter");
  });

  it("keeps the better rank when an object_id appears in both lanes", () => {
    const merged = mergeFtsLanes([hit("shared", 0.3)], [hit("shared", 0.9)], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.normalized_rank).toBe(0.9);
  });

  it("respects the result limit", () => {
    const merged = mergeFtsLanes(
      [hit("p1", 1), hit("p2", 0.8)],
      [hit("t1", 0.6)],
      2
    );
    expect(merged).toHaveLength(2);
  });

  it("returns an empty result when both lanes are empty", () => {
    expect(mergeFtsLanes([], [], 10)).toEqual([]);
  });
});
