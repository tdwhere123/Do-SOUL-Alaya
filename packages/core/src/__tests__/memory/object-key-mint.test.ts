import { describe, expect, it } from "vitest";
import { mintMemoryObjectKeys } from "../../memory/object-keys/mint/mint.js";
import { complementaryNumericAliasSurfaces } from "../../memory/object-keys/mint/numeric-aliases.js";
import { complementaryTemporalAliasSurfaces } from "../../memory/object-keys/mint/temporal-aliases.js";

const OWNER = "memory-1";
const WORKSPACE = "workspace-1";
const EVIDENCE = "capsule-1";

describe("mintMemoryObjectKeys", () => {
  it.each(["2/8/6", "2/8/26", "2/8/123", "2/8/12345", "2/8/123456"])("does not erase the unsupported explicit year in %s", (text) => {
    const keys = mintMemoryObjectKeys({ workspace_id: WORKSPACE, owner_id: OWNER, memory_content: text,
      evidence: [{ object_id: EVIDENCE, gist: text }] });
    expect(surfacesOf(keys, "temporal_alias")).toEqual([]);
    expect(complementaryTemporalAliasSurfaces(text)).toEqual([]);
  });

  it.each(["一百", "一百二十", "两千", "十万", "一〇〇"])("does not mint a partial small-number alias from %s", (text) => {
    const keys = mintMemoryObjectKeys({ workspace_id: WORKSPACE, owner_id: OWNER, memory_content: text,
      evidence: [{ object_id: EVIDENCE, gist: text }] });
    expect(surfacesOf(keys, "numeric_alias")).toEqual([]);
    expect(complementaryNumericAliasSurfaces(text)).toEqual([]);
  });
  it("retains supported temporal and numeric aliases", () => {
    expect(complementaryTemporalAliasSurfaces("2/8/2026")).toContain("2026-02-08");
    expect(complementaryTemporalAliasSurfaces("2/8")).toContain("February 8");
    expect(complementaryNumericAliasSurfaces("二十本书")).toContain("20");
    expect(complementaryNumericAliasSurfaces("我买了3本书")).toContain("三");
  });
  it.each(["-5", "+5", "−5", "3.14", "3.0", ".5"])("keeps %s whole when minting cardinal aliases", text => {
    const keys = mintMemoryObjectKeys({ workspace_id: WORKSPACE, owner_id: OWNER, memory_content: "The recorded value.",
      evidence: [{ object_id: EVIDENCE, gist: `It was ${text}.` }] });
    expect(surfacesOf(keys, "numeric_alias")).toEqual([]);
    expect(complementaryNumericAliasSurfaces(`It was ${text}.`)).toEqual([]);
  });
  it("mints gist-remainder keys that are not already in distilled content", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "I took my niece to the museum.",
      evidence: [{
        object_id: EVIDENCE,
        gist: "By the way, I took my niece to the Natural History Museum. She loves her Golden Retriever.",
      }]
    });

    expect(surfacesOf(keys, "gist_remainder")).toEqual(
      expect.arrayContaining(["Golden Retriever"])
    );
    expect(keys.every((key) => key.source_ref.startsWith("evidence:capsule-1:"))).toBe(true);
    expect(keys.some((key) => key.surface.toLowerCase().includes("niece"))).toBe(false);
  });

  it("normalizes stored date surfaces into complementary aliases without inventing a year", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "I took my niece to the museum on 2/8.",
      evidence: [{
        object_id: EVIDENCE,
        gist: "I took my niece to the Natural History Museum on 2/8.",
      }]
    });

    const aliases = surfacesOf(keys, "temporal_alias");
    expect(aliases).toEqual(expect.arrayContaining(["February 8", "2月8日", "February"]));
    expect(aliases.some((surface) => /\d{4}/u.test(surface))).toBe(false);
  });

  it("aliases CJK calendar and relative forms that already appear in stored text", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "我们3天前去过博物馆。",
      evidence: [{
        object_id: EVIDENCE,
        gist: "我们2月8日去过博物馆，那是3天前。",
      }]
    });

    const aliases = surfacesOf(keys, "temporal_alias");
    expect(aliases).toEqual(expect.arrayContaining(["February 8", "2/8", "3 days ago"]));
  });

  it("skips a remainder whose normalized form already exists on the object", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "Golden Retriever",
      evidence: [{
        object_id: EVIDENCE,
        gist: "She loves her Golden Retriever.",
      }]
    });

    expect(surfacesOf(keys, "gist_remainder")).not.toEqual(
      expect.arrayContaining(["Golden Retriever"])
    );
  });

  it("exposes query-side temporal alias surfaces without inventing a year", () => {
    expect(complementaryTemporalAliasSurfaces("when is 2/8")).toEqual(
      expect.arrayContaining(["February 8", "2月8日", "February"])
    );
    expect(complementaryTemporalAliasSurfaces("when is 2/8").some((surface) => /\d{4}/u.test(surface)))
      .toBe(false);
  });

  it("aliases stored number surfaces without inventing a new magnitude", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "I bought used books.",
      evidence: [{
        object_id: EVIDENCE,
        gist: "I bought 3 used books.",
      }]
    });

    const aliases = surfacesOf(keys, "numeric_alias");
    expect(aliases).toEqual(expect.arrayContaining(["three", "三"]));
    expect(aliases).not.toEqual(expect.arrayContaining(["3"]));
    expect(aliases.some((surface) => /\b(?:4|four|四)\b/u.test(surface))).toBe(false);
  });

  it("exposes query-side numeric alias surfaces without inventing a magnitude", () => {
    expect(complementaryNumericAliasSurfaces("bought 3 books")).toEqual(
      expect.arrayContaining(["three", "三"])
    );
    expect(complementaryNumericAliasSurfaces("bought 3 books")).not.toEqual(
      expect.arrayContaining(["4", "four"])
    );
  });

  it("skips remainder surfaces that exceed the addressable Key bound", () => {
    const oversized = `Uniqueblob${"x".repeat(600)}`;
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "I bought used books.",
      evidence: [{
        object_id: EVIDENCE,
        gist: `She mentioned ${oversized} today.`,
      }]
    });
    expect(keys.every((key) => key.surface.length <= 512)).toBe(true);
    expect(keys.some((key) => key.surface.includes("Uniqueblob"))).toBe(false);
  });

  it("drops timestamp-like gist remainder spans that carry no lexical letters", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "She watched the episode last night.",
      evidence: [{
        object_id: EVIDENCE,
        gist: "She watched the episode 04 01 733 last night.",
      }]
    });

    expect(surfacesOf(keys, "gist_remainder")).not.toEqual(
      expect.arrayContaining(["04 01 733"])
    );
    expect(surfacesOf(keys, "gist_remainder").some((surface) => /^\d+(?:\s+\d+)+$/u.test(surface)))
      .toBe(false);
  });

  it("still mints a two-character CJK gist remainder", () => {
    const keys = mintMemoryObjectKeys({
      workspace_id: WORKSPACE,
      owner_id: OWNER,
      memory_content: "We visited the museum.",
      evidence: [{
        object_id: EVIDENCE,
        gist: "We visited the museum in 2月.",
      }]
    });

    expect(surfacesOf(keys, "gist_remainder")).toEqual(
      expect.arrayContaining(["2月"])
    );
  });
});

function surfacesOf(
  keys: readonly Readonly<{ readonly key_type: string; readonly surface: string }>[],
  keyType: string
): readonly string[] {
  return keys.filter((key) => key.key_type === keyType).map((key) => key.surface);
}
