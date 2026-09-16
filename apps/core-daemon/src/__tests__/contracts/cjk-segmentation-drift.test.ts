import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as protocolRoot from "@do-soul/alaya-protocol";
import { tokenizeFactFrameSource } from "@do-soul/alaya-protocol/node/source-frame";
import {
  isCjkSegmentationCandidate,
  segmentCjkRun,
  warmCjkSegmentation
} from "@do-soul/alaya-cjk-segmentation";

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");

function readPackageDependencies(
  relativePath: string,
  sections: readonly string[] = ["dependencies"]
): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  const merged: Record<string, string> = {};
  for (const section of sections) {
    Object.assign(merged, pkg[section] ?? {});
  }
  return merged;
}

describe("cjk-segmentation owner", () => {
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

  it("source-frame CJK after warm matches the native owner", () => {
    const sample = "我喜欢咖啡";
    const pieces = Array.from(segmentCjkRun(sample));
    expect(pieces).toEqual(expect.arrayContaining(["喜欢", "咖啡"]));
    expect(tokenizeFactFrameSource(sample).map((token) => token.text)).toEqual(pieces);
  });

  it("keeps protocol zod-only and jieba on the Node helper", () => {
    expect(Object.keys(readPackageDependencies("packages/protocol/package.json"))).toEqual(["zod"]);
    expect(readPackageDependencies("packages/cjk-segmentation/package.json")["@node-rs/jieba"]).toBe(
      "2.0.3"
    );
    expect(readPackageDependencies("packages/core/package.json")["@node-rs/jieba"]).toBeUndefined();
    expect(readPackageDependencies("packages/storage/package.json")["@node-rs/jieba"]).toBeUndefined();
    const inspectorDepSections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    expect(
      readPackageDependencies("apps/inspector/web/package.json", inspectorDepSections)[
        "@do-soul/alaya-cjk-segmentation"
      ]
    ).toBeUndefined();
    expect(
      readPackageDependencies("apps/inspector/package.json", inspectorDepSections)[
        "@do-soul/alaya-cjk-segmentation"
      ]
    ).toBeUndefined();
    expect(protocolRoot).not.toHaveProperty("bindCjkRunSegmenter");
  });
});
