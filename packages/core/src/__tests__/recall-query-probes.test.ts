import { describe, expect, it } from "vitest";
import { MemoryDimension, ScopeClass } from "@do-soul/alaya-protocol";
import { compileRecallQueryProbes } from "../recall-query-probes.js";

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
  });
});
