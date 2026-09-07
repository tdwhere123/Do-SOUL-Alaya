import { MemoryDimension } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecallService } from "../../recall/recall-service.js";
import { buildEvidenceSearchQueries, buildInformativeEvidenceSearchQueries, selectEvidenceSearchQueries }
  from "../../recall/coarse-filter/evidence/search-query-planner.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { createSourceBoundRecallFixture, createTaskSurface } from "./recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("evidence search query construction", () => {
  it("keeps the supported explicit query planner ordering", () => {
    const probes = { ...compileRecallQueryProbes(null), phrases: ["quoted phrase"],
      lexical_terms: ["alpha", "beta"], expanded_terms: ["alphas", "betas"], date_terms: ["2026-07-14"] };
    expect(buildEvidenceSearchQueries("the broad raw query", probes)).toEqual([
      "the broad raw query", "quoted phrase", "alpha beta", "alphas betas", "2026-07-14"
    ]);
  });

  it("builds informative probes without copying a broad natural query", () => {
    const query = "What was the deployment configuration for the database that we used and why?";
    const probes = compileRecallQueryProbes(query);
    const informative = buildInformativeEvidenceSearchQueries(probes);
    expect(informative).not.toContain(query);
    expect(informative.some((item) => item.includes("deployment") && item.includes("database"))).toBe(true);
    expect(selectEvidenceSearchQueries(query, probes)).not.toContain(query);
  });

  it("preserves short phrase filtering and raw fallback when informative probes are absent", () => {
    const probes = { ...compileRecallQueryProbes(null), phrases: ["ab", "abc"] };
    expect(buildInformativeEvidenceSearchQueries(probes)).toEqual(["abc"]);
    expect(buildEvidenceSearchQueries("raw fallback", probes)).toEqual(["raw fallback", "abc"]);
    expect(selectEvidenceSearchQueries("why and where", compileRecallQueryProbes("why and where")))
      .toEqual(["why and where"]);
  });

  it.each(["zylphqorbex", "我喜欢咖啡"])("retains keyword coverage for %s", (query) => {
    expect(selectEvidenceSearchQueries(query, compileRecallQueryProbes(query))
      .some((item) => item.split(/\s+/u).includes(query))).toBe(true);
  });
});

describe("conditional Recall query ownership", () => {
  it("reads the native lexical observer without invoking retired scalar or batch evidence rankers", async () => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000293";
    await fixture.writeMemory(id, "deployment database configuration", MemoryDimension.FACT);
    const scalar = vi.fn(async () => { throw new Error("retired evidence scalar route"); });
    const batch = vi.fn(async () => { throw new Error("retired evidence batch route"); });
    const service = new RecallService({
      ...fixture.dependencies,
      evidenceSearchPort: { searchByKeyword: scalar, searchManyByKeywordField: batch }
    });
    const result = await service.recall({
      workspaceId: "workspace-1", taskSurface: { ...createTaskSurface(), display_name: "deployment" },
      queryText: "deployment", strategy: "chat", pageBudget: 800
    });
    expect(result.index.entries.some((entry) => entry.object_id === id)).toBe(true);
    expect(scalar).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });
});
