import { beforeAll, describe, expect, it } from "vitest";
import {
  isCjkSegmentationCandidate as isCjkSegmentationCandidateCore,
  segmentCjkRun as segmentCjkRunCore,
  warmCjkSegmentation as warmCjkSegmentationCore
} from "@do-soul/alaya-core";
import {
  segmentCjkRun as segmentCjkRunStorage,
  warmCjkSegmentation as warmCjkSegmentationStorage
} from "@do-soul/alaya-storage";

// invariant: storage and core each own an independent jieba module-state
// (Package Dependency Direction §1-§4 forbids storage importing from
// core). Both copies MUST produce identical segmentation on identical
// input — otherwise the FTS query path (storage tokenizer) and the
// recall-query-probes lane (core tokenizer) would compute different
// lexical_terms for the same CJK run, and a memory keyed by one would
// silently miss when recalled by the other. This drift contract test
// catches that divergence before it reaches production.
//
// The two source files live at:
//   packages/core/src/shared/cjk-segmentation.ts
//   packages/storage/src/repos/shared/cjk-segmentation.ts
// Either may legitimately diverge ONE thing — its surface API — but
// the actual segmentation output for CJK input must agree.

const CJK_FIXTURES: readonly string[] = [
  "我喜欢咖啡",
  "部署流水线",
  "昨天我们确认了 v0.3.7 召回方案",
  "今天明天昨天",
  "记忆系统优化",
  "オープンソース", // Japanese katakana
  "東京駅で会いましょう", // Japanese kanji + hiragana + kanji
  "ひらがな"
];

describe("cjk-segmentation drift contract (core ↔ storage)", () => {
  beforeAll(async () => {
    const [coreReady, storageReady] = await Promise.all([
      warmCjkSegmentationCore(),
      warmCjkSegmentationStorage()
    ]);
    if (!coreReady || !storageReady) {
      throw new Error(
        `jieba unavailable in test env (core=${String(coreReady)} storage=${String(storageReady)}); native binding missing`
      );
    }
  });

  it("isCjkSegmentationCandidate predicate agrees across copies (smoke)", () => {
    // Both copies use the same Han/Hiragana/Katakana regex; verify via
    // the core export and assert it accepts the fixtures.
    for (const sample of CJK_FIXTURES) {
      expect(isCjkSegmentationCandidateCore(sample)).toBe(true);
    }
  });

  it.each(CJK_FIXTURES)(
    "segmentCjkRun produces identical pieces for %s",
    (sample) => {
      const corePieces = segmentCjkRunCore(sample);
      const storagePieces = segmentCjkRunStorage(sample);
      // Compare as arrays — jieba's output is order-sensitive and the
      // two copies are wrapping the SAME native binding with the SAME
      // dict, so output ordering is also expected to agree.
      expect(Array.from(storagePieces)).toEqual(Array.from(corePieces));
    }
  );

  it("empty input yields empty output on both sides", () => {
    expect(Array.from(segmentCjkRunCore(""))).toEqual([]);
    expect(Array.from(segmentCjkRunStorage(""))).toEqual([]);
  });
});
