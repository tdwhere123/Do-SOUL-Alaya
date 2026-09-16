import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetBoundCjkRunSegmenterForTests,
  applyBoundCjkRunSegmenter,
  bindCjkRunSegmenter,
  fallbackCjkRunPieces
} from "../../shared/cjk-run-policy.js";
import { tokenizeFactFrameSource } from "../../node/source-frame.js";
import * as protocolRoot from "../../index.js";

afterEach(() => {
  __resetBoundCjkRunSegmenterForTests();
  vi.restoreAllMocks();
});

describe("CJK run policy fallback", () => {
  it("splits interrogative atoms without a native segmenter", () => {
    expect(fallbackCjkRunPieces("多久部署")).toEqual(["多久", "部署"]);
    expect(fallbackCjkRunPieces("我爱北京")).toEqual(["我爱北京"]);
  });

  it("keeps bind off the protocol browser root", () => {
    expect(protocolRoot).not.toHaveProperty("bindCjkRunSegmenter");
  });

  it("ignores a second bind so source-frame cannot be hijacked", () => {
    bindCjkRunSegmenter(() => ["once"]);
    bindCjkRunSegmenter(() => ["twice"]);
    expect(applyBoundCjkRunSegmenter("我喜欢咖啡")).toEqual(["once"]);
  });

  it("warns once when source-frame CJK runs with no native owner bound", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    expect(tokenizeFactFrameSource("多久部署").map((token) => token.text)).toEqual(["多久", "部署"]);
    expect(emitWarning).toHaveBeenCalledWith(
      "[CjkRunPolicy] no native CJK segmenter bound; using interrogative-atom fallback",
      expect.objectContaining({
        code: "ALAYA_CJK_RUN_UNBOUND_FALLBACK"
      })
    );
    tokenizeFactFrameSource("多久部署");
    expect(emitWarning).toHaveBeenCalledTimes(1);
  });
});
