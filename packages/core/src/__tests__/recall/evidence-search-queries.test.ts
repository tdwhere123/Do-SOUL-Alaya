import { describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import {
  buildEvidenceSearchQueries,
  buildInformativeEvidenceSearchQueries,
  selectEvidenceSearchQueries
} from "../../recall/coarse-filter/evidence/search-query-planner.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "./recall-8factor-test-fixtures.js";

describe("evidence search query planning", () => {
  it("keeps the shared legacy query list unchanged", () => {
    const probes = {
      ...compileRecallQueryProbes(null),
      phrases: ["quoted phrase"],
      lexical_terms: ["alpha", "beta"],
      expanded_terms: ["alphas", "betas"],
      date_terms: ["2026-07-14"]
    };

    expect(buildEvidenceSearchQueries("the broad raw query", probes)).toEqual([
      "the broad raw query",
      "quoted phrase",
      "alpha beta",
      "alphas betas",
      "2026-07-14"
    ]);
  });

  it("builds informative probes without copying a broad natural query", () => {
    const rawQuery = "What was the deployment configuration for the database that we used and why?";
    const queries = buildInformativeEvidenceSearchQueries(
      compileRecallQueryProbes(rawQuery)
    );

    expect(queries).not.toContain(rawQuery);
    expect(queries.some((query) =>
      query.includes("deployment") && query.includes("database")
    )).toBe(true);
  });

  it("shares the legacy short-phrase filter with synthesis queries", () => {
    const probes = {
      ...compileRecallQueryProbes(null),
      phrases: ["ab", "abc"]
    };

    expect(buildInformativeEvidenceSearchQueries(probes)).toEqual(["abc"]);
    expect(buildEvidenceSearchQueries("raw fallback", probes)).toEqual([
      "raw fallback",
      "abc"
    ]);
  });

  it("retains direct keyword and CJK surface coverage", () => {
    expect(selectEvidenceSearchQueries(
      "zylphqorbex",
      compileRecallQueryProbes("zylphqorbex")
    )).toContain("zylphqorbex");

    const cjkQueries = selectEvidenceSearchQueries(
      "我喜欢咖啡",
      compileRecallQueryProbes("我喜欢咖啡")
    );
    expect(cjkQueries.some((query) => query.split(/\s+/u).includes("我喜欢咖啡"))).toBe(true);
  });

  it("falls back to the raw query only when no informative probe exists", () => {
    expect(selectEvidenceSearchQueries(
      "why and where",
      compileRecallQueryProbes("why and where")
    )).toEqual(["why and where"]);
  });

  it("uses informative evidence queries and preserves max-rank merging", async () => {
    const first = createMemoryEntry({
      object_id: "memory-first",
      evidence_refs: ["evidence-first"]
    });
    const second = createMemoryEntry({
      object_id: "memory-second",
      evidence_refs: ["evidence-second"]
    });
    const third = createMemoryEntry({ object_id: "memory-third" });
    const { dependencies } = createDependencies([first, second, third]);
    const evidenceSearch = vi.fn(async (_workspaceId: string, query: string) =>
      query === "deployment configuration"
        ? [
            { object_id: "evidence-first", normalized_rank: 0.9 },
            { object_id: "evidence-second", normalized_rank: 0.4 }
          ]
        : [
            { object_id: "evidence-first", normalized_rank: 0.1 },
            { object_id: "evidence-second", normalized_rank: 0.8 }
          ]
    );
    const rawQuery = "What was the deployment configuration for the database that we used and why?";
    const service = new RecallService({
      ...dependencies,
      memoryRepo: {
        ...dependencies.memoryRepo,
        searchByKeyword: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => [first, second])
      },
      evidenceSearchPort: {
        searchByKeyword: evidenceSearch
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface(rawQuery),
      workspaceId: "workspace-1",
      strategy: "build"
    });

    expect(evidenceSearch).toHaveBeenCalled();
    expect(evidenceSearch.mock.calls.map((call) => call[1])).not.toContain(rawQuery);
    const diagnostics = result.diagnostics?.candidates ?? [];
    expect(diagnostics.find((candidate) => candidate.object_id === "memory-first")
      ?.per_stream_rank.evidence_fts).toBe(1);
    expect(diagnostics.find((candidate) => candidate.object_id === "memory-second")
      ?.per_stream_rank.evidence_fts).toBe(2);
  });
});
