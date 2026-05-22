import { describe, expect, it } from "vitest";
import { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { compileRecallQueryProbes, expandLexicalTerms } from "../recall-query-probes.js";

describe("compileRecallQueryProbes", () => {
  it("extracts multilingual structural probes without a provider", () => {
    const probes = compileRecallQueryProbes(
      "昨天我们确认 v0.3.7 无 embedding 召回方案，相关 docs/v0.3/v0.3.7/no-embedding-dynamic-recall.md 和 @do-soul/alaya-core 怎么改？"
    );

    expect(probes.date_terms).toContain("昨天");
    expect(probes.task_refs).toContain("v0.3.7");
    expect(probes.file_paths).toContain("docs/v0.3/v0.3.7/no-embedding-dynamic-recall.md");
    expect(probes.package_names).toContain("@do-soul/alaya-core");
    expect(probes.domain_tags).toEqual(expect.arrayContaining(["embedding", "recall", "docs"]));
    expect(probes.lexical_terms).toEqual(expect.arrayContaining(["embedding", "召回方案"]));
    expect(probes.char_ngrams.length).toBeGreaterThan(0);
  });

  it("classifies intent, scope, ids, and evidence anchors deterministically", () => {
    const probes = compileRecallQueryProbes(
      "What procedure did we decide for memory_abc123 using evidence_ref-9 in run-42 and surface-alpha for this project?"
    );

    expect(probes.object_ids).toContain("abc123");
    expect(probes.evidence_refs).toContain("ref-9");
    expect(probes.run_ids).toContain("run-42");
    expect(probes.surface_ids).toContain("surface-alpha");
    expect(probes.subject_hints).toContain("self_reference");
    expect(probes.dimensions).toEqual(expect.arrayContaining([
      MemoryDimension.PROCEDURE,
      MemoryDimension.DECISION
    ]));
    expect(probes.scope_classes).toContain(ScopeClass.PROJECT);
  });

  it("extracts the same time_concern windows produced by local heuristics", () => {
    const probes = compileRecallQueryProbes(
      "What did we decide last week, and what changed in 2026-05? 上周的结论是什么？"
    );

    expect(probes.date_terms).toEqual(expect.arrayContaining([
      "last week",
      "2026-05",
      "上周"
    ]));
    expect(compileRecallQueryProbes("Where did I buy my new bookshelf?").subject_hints)
      .toEqual(["self_reference"]);
    expect(compileRecallQueryProbes("Where did Alex buy the bookshelf?").subject_hints)
      .toEqual([]);
  });
});

describe("expandLexicalTerms", () => {
  it("is deterministic: identical input yields identical output", () => {
    const terms = ["recalls", "embeddings", "directories", "running", "config"];
    const first = expandLexicalTerms(terms);
    const second = expandLexicalTerms(terms);
    expect(second).toEqual(first);
  });

  it("folds regular English morphology into additive variants", () => {
    const expanded = expandLexicalTerms(["recalls"]);
    // plural -> singular stem
    expect(expanded).toContain("recall");
    // verb-suffix folding
    expect(expandLexicalTerms(["running"])).toContain("run");
    expect(expandLexicalTerms(["reviewed"])).toContain("review");
    // forward plural so a singular query term reaches a pluralized memory
    expect(expandLexicalTerms(["candidate"])).toContain("candidates");
    expect(expandLexicalTerms(["match"])).toContain("matches");
  });

  it("applies the static domain synonym table bidirectionally", () => {
    expect(expandLexicalTerms(["embedding"])).toEqual(expect.arrayContaining(["vector"]));
    expect(expandLexicalTerms(["vector"])).toEqual(expect.arrayContaining(["embedding"]));
    expect(expandLexicalTerms(["repo"])).toContain("repository");
    expect(expandLexicalTerms(["db"])).toContain("database");
  });

  it("never echoes the original surface terms back as expansions", () => {
    const surface = ["recall", "config", "embedding"];
    const expanded = expandLexicalTerms(surface);
    for (const term of surface) {
      expect(expanded).not.toContain(term);
    }
  });

  it("leaves CJK and non-alphabetic terms unfolded by morphology", () => {
    const expanded = expandLexicalTerms(["召回方案"]);
    // no Latin morphology applies; only synonym-table lookups could add terms
    expect(expanded.every((term) => /[a-z]/u.test(term) || !/[一-鿿]/u.test(term))).toBe(true);
  });

  it("surfaces expanded_terms on the compiled probes without polluting lexical_terms", () => {
    const probes = compileRecallQueryProbes("which embeddings did the recalls use");
    expect(probes.lexical_terms).toEqual(expect.arrayContaining(["embeddings", "recalls"]));
    expect(probes.expanded_terms).toEqual(expect.arrayContaining(["vector", "recall"]));
    // expansions stay out of the surface lexical_terms set
    for (const expanded of probes.expanded_terms) {
      expect(probes.lexical_terms).not.toContain(expanded);
    }
  });
});
