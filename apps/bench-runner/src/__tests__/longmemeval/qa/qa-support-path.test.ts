import { afterEach, describe, expect, it, vi } from "vitest";
import { answerSystemFor, type QaDeliveredCandidate } from "../../../longmemeval/qa/qa-harness.js";
import { buildQaSupportPack } from "../../../longmemeval/qa/qa-support-pack.js";
import { parseFilterSelection, selectRelevantMemories } from "../../../longmemeval/qa/qa-llm-filter.js";

function cand(objectId: string, sessionId?: string): QaDeliveredCandidate {
  return { objectId, content: `content-${objectId}`, ...(sessionId === undefined ? {} : { sessionId }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("answerSystemFor v2 prompt routing", () => {
  it("routes knowledge-update to the latest-value prompt only when v2 prompts are on", () => {
    expect(answerSystemFor("knowledge-update", false)).not.toMatch(/most recent applicable/iu);
    vi.stubEnv("ALAYA_BENCH_QA_V2_PROMPTS", "1");
    expect(answerSystemFor("knowledge-update", false)).toMatch(/most recent applicable/iu);
  });

  it("routes multi-session and locomo-aggregation to the aggregation prompt", () => {
    expect(answerSystemFor("multi-session", false)).toMatch(/aggregate across/iu);
    expect(answerSystemFor("locomo-aggregation", false)).toMatch(/aggregate across/iu);
  });

  it("routes locomo-open-domain to the open-domain prompt under v2", () => {
    vi.stubEnv("ALAYA_BENCH_QA_V2_PROMPTS", "1");
    expect(answerSystemFor("locomo-open-domain", false)).toMatch(/general world knowledge/iu);
  });

  it("keeps abstention on the strict default prompt even with v2 prompts on", () => {
    vi.stubEnv("ALAYA_BENCH_QA_V2_PROMPTS", "1");
    expect(answerSystemFor("knowledge-update", true)).toMatch(/say you don't know/iu);
  });
});

describe("selectRelevantMemories fallback", () => {
  it("returns [] on an unparseable verdict so the caller keeps its natural delivery", async () => {
    const chat = vi.fn(async () => "no numbers here");
    const result = await selectRelevantMemories("q", [cand("a"), cand("b")], 3, chat);
    expect(result).toEqual([]);
    expect(parseFilterSelection("garbage", 3, 3)).toEqual([]);
  });
});

describe("buildQaSupportPack", () => {
  it("prioritises same-session neighbours of the anchor, then fills cross-session, with no duplicates", () => {
    const selected = [cand("a1", "s1")];
    const widePool = [cand("a1", "s1"), cand("a2", "s1"), cand("b1", "s2"), cand("a3", "s1")];
    const pack = buildQaSupportPack({
      questionType: "locomo-factual",
      selected,
      widePool,
      maxDeliver: 16
    });
    expect(pack.map((c) => c.objectId)).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("caps a multi-session pack at the larger per-type budget", () => {
    const selected = [cand("a1", "s1")];
    const widePool = Array.from({ length: 20 }, (_unused, index) => cand(`m${index}`, `s${index}`));
    const pack = buildQaSupportPack({
      questionType: "multi-session",
      selected,
      widePool,
      maxDeliver: 16
    });
    expect(pack).toHaveLength(14);
  });
});
