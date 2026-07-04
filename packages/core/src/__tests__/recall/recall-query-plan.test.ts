import { describe, expect, it } from "vitest";
import {
  classifyRecallIntent,
  extractRecallAnchors,
  intentSplitsByAnchor
} from "../../recall/query/recall-query-plan.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";

const anchorsFor = (query: string) => extractRecallAnchors(compileRecallQueryProbes(query));
const intentFor = (query: string) => classifyRecallIntent(compileRecallQueryProbes(query));

describe("classifyRecallIntent", () => {
  it("classifies knowledge-update, temporal, list, preference, and single-fact", () => {
    expect(intentFor("what did I originally use, now changed?")).toBe("knowledge_update");
    expect(intentFor("what happened before the move")).toBe("temporal");
    expect(intentFor("which restaurants did we visit")).toBe("list");
    expect(intentFor("do I prefer espresso and cappuccino and latte and mocha")).toBe("preference");
    expect(intentFor("where is the warehouse located")).toBe("single_fact");
  });

  it("does not treat month-name path-source text as temporal intent", () => {
    expect(intentFor("november path source")).toBe("single_fact");
  });

  it("only splits fact-spread intents by anchor", () => {
    expect(intentSplitsByAnchor("multi_fact")).toBe(true);
    expect(intentSplitsByAnchor("temporal")).toBe(true);
    expect(intentSplitsByAnchor("preference")).toBe(false);
    expect(intentSplitsByAnchor("single_fact")).toBe(false);
  });
});

describe("extractRecallAnchors", () => {
  it("treats a long content word as a required anchor", () => {
    expect(anchorsFor("who attended the conference").required).toContain("conference");
  });

  it("promotes a date term to a required anchor", () => {
    expect(anchorsFor("what happened on 2024-03-15").required.some((t) => t.includes("2024"))).toBe(
      true
    );
  });

  it("keeps the lane firing on short-word queries via the longest-term fallback", () => {
    expect(anchorsFor("where is the cat now").required.length).toBeGreaterThan(0);
  });

  it("yields no anchor when there is no content term", () => {
    expect(anchorsFor("what is it").required).toHaveLength(0);
  });

  it("does not repeat a required anchor in the optional set", () => {
    const anchors = anchorsFor("who attended the conference dinner");
    expect(anchors.optional.filter((t) => anchors.required.includes(t))).toHaveLength(0);
  });
});
