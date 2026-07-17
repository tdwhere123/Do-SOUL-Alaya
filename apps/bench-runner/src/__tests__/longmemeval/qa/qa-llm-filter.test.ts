import { describe, expect, it } from "vitest";
import {
  buildFilterUserPrompt,
  parseFilterSelection,
  selectRelevantMemories
} from "../../../longmemeval/qa/qa-llm-filter.js";
import type { QaChatFn } from "../../../longmemeval/qa/qa-chat.js";
import type { QaDeliveredCandidate } from "../../../longmemeval/qa/qa-harness.js";

const CANDS: readonly QaDeliveredCandidate[] = [
  { objectId: "a", content: "user enjoys Adobe Premiere", eventDate: "2023/05/04" },
  { objectId: "b", content: "user dislikes spicy food" },
  { objectId: "c", content: "user is learning deep learning for medical imaging" }
];

describe("parseFilterSelection", () => {
  it("parses comma/bracket/prose number forms into 0-based indices in order", () => {
    expect(parseFilterSelection("3, 1", 3, 8)).toEqual([2, 0]);
    expect(parseFilterSelection("[2] and [3]", 3, 8)).toEqual([1, 2]);
  });
  it("dedupes, drops out-of-range, and caps at maxSelect", () => {
    expect(parseFilterSelection("1,1,2,9,3", 3, 2)).toEqual([0, 1]);
    expect(parseFilterSelection("7,8", 3, 8)).toEqual([]);
  });
  it("returns [] when nothing parses", () => {
    expect(parseFilterSelection("none relevant", 3, 8)).toEqual([]);
  });
});

describe("buildFilterUserPrompt", () => {
  it("numbers candidates 1-based and prefixes the event date", () => {
    const prompt = buildFilterUserPrompt("what software?", CANDS, 8);
    expect(prompt).toContain("[1] (2023/05/04) user enjoys Adobe Premiere");
    expect(prompt).toContain("[2] user dislikes spicy food");
    expect(prompt).toContain("up to 8");
  });
});

describe("selectRelevantMemories", () => {
  const fixedChat = (reply: string): QaChatFn => async () => reply;
  it("returns selected candidates in the filter's order, content preserved", async () => {
    const out = await selectRelevantMemories("q", CANDS, 8, fixedChat("3,1"));
    expect(out.map((c) => c.objectId)).toEqual(["c", "a"]);
  });
  it("returns [] on empty input or unparseable verdict (caller falls back)", async () => {
    expect(await selectRelevantMemories("q", [], 8, fixedChat("1"))).toEqual([]);
    expect(await selectRelevantMemories("q", CANDS, 8, fixedChat("nope"))).toEqual([]);
  });
});
