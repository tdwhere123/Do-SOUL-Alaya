import { describe, expect, it } from "vitest";
import {
  formatPagerExit,
  formatRecallEvalPagerMapsHint,
  readRecallEvalPagerMapsHint
} from "../../../runs/lifecycle/recall-eval/recall-eval-process/maps-hint.js";

describe("recall-eval pager maps hint", () => {
  it("returns null instead of 0 mappings when /proc/pid/maps is unreadable", () => {
    expect(readRecallEvalPagerMapsHint(Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it("formats omitted and null hints as maps=unsampled, never alaya.db=0", () => {
    expect(formatRecallEvalPagerMapsHint(null)).toBe("maps=unsampled");
    expect(formatRecallEvalPagerMapsHint(undefined)).toBe("maps=unsampled");
    expect(formatPagerExit({
      code: 1,
      exitSignal: null,
      childPid: 9,
      mapsHint: null
    })).toContain("maps=unsampled");
    expect(formatPagerExit({
      code: 1,
      exitSignal: null,
      childPid: 9
    })).toContain("maps=unsampled");
    expect(formatPagerExit({
      code: 1,
      exitSignal: null,
      mapsHint: null
    })).not.toContain("alaya.db=0");
  });

  it("keeps a sampled zero distinct from unsampled", () => {
    const sampled = {
      pid: 12,
      comm: "alaya-recall-eval-pager",
      alaya_db_mappings: 0,
      onnxruntime_mappings: 0
    };
    expect(formatRecallEvalPagerMapsHint(sampled)).toBe(
      "pid=12 comm=alaya-recall-eval-pager alaya.db=0 onnxruntime=0"
    );
    expect(formatPagerExit({
      code: 0,
      exitSignal: null,
      mapsHint: sampled
    })).toContain("alaya.db=0");
    expect(formatPagerExit({
      code: 0,
      exitSignal: null,
      mapsHint: sampled
    })).not.toContain("maps=unsampled");
  });
});
