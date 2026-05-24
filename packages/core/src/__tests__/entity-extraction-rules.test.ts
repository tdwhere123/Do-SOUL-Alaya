import { describe, expect, it } from "vitest";
import { RuleBasedEntityExtractor } from "../entity-extraction-rules.js";

const extractor = new RuleBasedEntityExtractor();

async function kindsFor(query: string): Promise<readonly string[]> {
  const candidates = await extractor.extract(query);
  return candidates.map((c) => `${c.kind}:${c.surface}`);
}

describe("RuleBasedEntityExtractor", () => {
  it("returns empty list for null / whitespace query", async () => {
    expect(await extractor.extract("")).toEqual([]);
    expect(await extractor.extract("   ")).toEqual([]);
  });

  it("captures double-quoted spans verbatim", async () => {
    const candidates = await extractor.extract(
      'remind me of the "release closeout protocol" we agreed on'
    );
    const quoted = candidates.find((c) => c.kind === "quoted");
    expect(quoted?.surface).toBe("release closeout protocol");
    expect(quoted?.normalized).toBe("release closeout protocol");
    expect(quoted?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("captures single-quoted and backtick spans", async () => {
    const single = await extractor.extract("see 'the materialization router' notes");
    expect(single.find((c) => c.kind === "quoted")?.surface).toBe(
      "the materialization router"
    );
    const back = await extractor.extract("`buildClaimInput` writes the form");
    const backHit = back.find((c) => c.surface === "buildClaimInput");
    expect(backHit).toBeDefined();
    // Backtick double-classifies as quoted (broader literal) AND code_ref
    // (narrower); dedupe keeps the higher-confidence quoted/code_ref entry.
    expect(["quoted", "code_ref"]).toContain(backHit?.kind);
  });

  it("captures CamelCase and UPPER_SNAKE proper nouns", async () => {
    const camel = await kindsFor("MaterializationRouter routeByObjectKind");
    expect(camel).toContain("proper_noun:MaterializationRouter");

    const upper = await kindsFor("AUTO_ACCEPT_FLOOR must clamp to 1");
    expect(upper).toContain("proper_noun:AUTO_ACCEPT_FLOOR");
  });

  it("captures consecutive Capitalized runs as proper-noun phrases", async () => {
    const candidates = await extractor.extract("we agreed with Sam Altman last week");
    const phrase = candidates.find((c) => c.surface === "Sam Altman");
    expect(phrase).toBeDefined();
    expect(phrase?.kind).toBe("proper_noun");
  });

  it("captures package refs", async () => {
    const candidates = await extractor.extract(
      "what does @do-soul/alaya-core re-export?"
    );
    const pkg = candidates.find((c) => c.kind === "package");
    expect(pkg?.surface).toBe("@do-soul/alaya-core");
    expect(pkg?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("captures slash-separated file paths", async () => {
    const candidates = await extractor.extract(
      "look at packages/core/src/recall-service.ts for the fix"
    );
    const path = candidates.find((c) => c.kind === "path");
    expect(path?.surface).toBe("packages/core/src/recall-service.ts");
  });

  it("captures hash / BL / version task refs", async () => {
    const hash = await kindsFor("#BL-042 is still open");
    expect(hash.some((entry) => entry.startsWith("task_ref:"))).toBe(true);

    const release = await extractor.extract("does v0.3.11 close out the gap?");
    const rel = release.find((c) => c.kind === "task_ref" && c.surface.startsWith("v0.3"));
    expect(rel?.surface).toContain("v0.3");
  });

  it("captures CJK noun-phrase runs as cjk_phrase", async () => {
    const cn = await extractor.extract("说一下记忆系统的召回路径");
    const cjk = cn.filter((c) => c.kind === "cjk_phrase");
    expect(cjk.length).toBeGreaterThan(0);
    expect(cjk[0]?.surface).toMatch(/[一-龥]{2,}/u);

    const jp = await extractor.extract("カタカナ も対応する");
    expect(jp.some((c) => c.kind === "cjk_phrase")).toBe(true);
  });

  it("falls back to unknown-long lane for plain words past length floor", async () => {
    const candidates = await extractor.extract("does the backup happen automatically");
    const unknownSurfaces = candidates
      .filter((c) => c.kind === "unknown")
      .map((c) => c.surface);
    expect(unknownSurfaces).toContain("backup");
    expect(unknownSurfaces).toContain("happen");
    expect(unknownSurfaces).toContain("automatically");
  });

  it("drops stop-words and short tokens from unknown lane", async () => {
    const candidates = await extractor.extract("the and or is my you");
    expect(candidates).toEqual([]);
  });

  it("dedupes by normalized surface and keeps highest-confidence kind", async () => {
    const candidates = await extractor.extract(
      'use "MaterializationRouter" via the materialization router'
    );
    const matches = candidates.filter(
      (c) => c.normalized === "materializationrouter"
    );
    expect(matches.length).toBe(1);
    expect(matches[0]?.kind).toBe("quoted");
  });

  it("respects maxEntities option ordering by confidence", async () => {
    const query = '"alpha" "beta" "gamma" "delta" "epsilon"';
    const candidates = await extractor.extract(query, { maxEntities: 3 });
    expect(candidates.length).toBe(3);
    for (const c of candidates) {
      expect(["quoted", "code_ref"]).toContain(c.kind);
    }
  });

  it("clamps maxEntities to default when option is undefined or non-positive", async () => {
    const query = '"aa" "bb" "cc" "dd" "ee" "ff" "gg" "hh" "ii" "jj" "kk" "ll"';
    const all = await extractor.extract(query);
    expect(all.length).toBe(8);
    const zero = await extractor.extract(query, { maxEntities: 0 });
    expect(zero.length).toBe(8);
  });

  it("source_offset spans index into the original query string", async () => {
    const query = "the field MaterializationRouter is here";
    const candidates = await extractor.extract(query);
    const target = candidates.find((c) => c.surface === "MaterializationRouter");
    expect(target?.source_offset).toBeDefined();
    const [start, end] = target?.source_offset ?? [0, 0];
    expect(query.slice(start, end)).toBe("MaterializationRouter");
  });

  it("is deterministic — same input yields byte-identical output", async () => {
    const query = 'check `recall-service.ts` and #BL-001 and 召回路径 and Sam Altman';
    const a = await extractor.extract(query);
    const b = await extractor.extract(query);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns frozen candidates and frozen list", async () => {
    const candidates = await extractor.extract('"closed" feedback');
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidates[0])).toBe(true);
  });

  it("normalized field is lower-cased NFKC of the surface", async () => {
    const candidates = await extractor.extract('"Café" notes');
    const cafe = candidates.find((c) => c.surface === "Café");
    expect(cafe?.normalized).toBe("café");
  });
});
