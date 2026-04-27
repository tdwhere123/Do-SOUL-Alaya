import {
  getInspectorAsset,
  listInspectorAssets
} from "../inspector/assets.js";
import { describe, expect, it } from "vitest";
import {
  createScriptedBenchmarkApi,
  renderBenchmarkMarkdown,
  runSoulMemoryBenchmark,
  serializeBenchmarkReport,
  type BenchmarkContextPack
} from "../bench/index.js";

describe("inspector assets", () => {
  it("serves a graph-first static asset set with public API endpoint calls", () => {
    const html = getInspectorAsset("/");
    const css = getInspectorAsset("/inspector.css");
    const js = getInspectorAsset("/inspector.js?cache=off");

    expect(html?.contentType).toBe("text/html; charset=utf-8");
    expect(css?.contentType).toBe("text/css; charset=utf-8");
    expect(js?.contentType).toBe("text/javascript; charset=utf-8");
    expect(html?.body).toContain("data-graph-canvas");
    expect(html?.body).toContain("data-recall");
    expect(html?.body).toContain("data-audit-timeline");
    expect(html?.body).toContain("data-governance-action=\"reject\"");
    expect(js?.body).toContain("getMemoryGraph");
    expect(js?.body).toContain("getSessionGraph");
    expect(js?.body).toContain("getContextPack");
    expect(js?.body).toContain("listAuditEvents");
    expect(js?.body).toContain("acceptMemory");
    expect(js?.body).toContain("rejectMemory");
    expect(listInspectorAssets().map((asset) => asset.path).sort()).toEqual([
      "/index.html",
      "/inspector.css",
      "/inspector.js"
    ]);
  });
});

describe("SOUL Memory benchmark", () => {
  it("generates deterministic reports and corrects false recall through governance API", async () => {
    const scriptedPacks: readonly BenchmarkContextPack[] = [
      {
        id: "context-pack:coding-continuation",
        entries: [
          entry("decision.graph-first", "project-local", "blocking"),
          entry("constraint.public-api-root", "project-local", "blocking"),
          entry("hazard.no-main-repo-imports", "project-local", "advisory"),
          {
            memoryId: "stale.chat-timeline-inspector",
            summary: "Old inspector direction",
            plane: "project-local",
            recallReason: "Superseded prototype note matched inspector query",
            recommendedUsage: "historical",
            lifecycleState: "stale"
          }
        ],
        exclusions: []
      },
      {
        id: "context-pack:review-fix-loop",
        entries: [
          entry("decision.audit-required", "project-local", "blocking"),
          entry("preference.local-first", "global-personal", "advisory"),
          entry("constraint.recall-explanations", "project-local", "blocking"),
          {
            memoryId: "rejected.cloud-sync-default",
            summary: "Cloud sync default",
            plane: "global-personal",
            recallReason: "Rejected global note still matched sync query",
            recommendedUsage: "historical",
            lifecycleState: "rejected"
          }
        ],
        exclusions: []
      }
    ];
    const first = await runSoulMemoryBenchmark({
      api: createScriptedBenchmarkApi(scriptedPacks)
    });
    const second = await runSoulMemoryBenchmark({
      api: createScriptedBenchmarkApi(scriptedPacks)
    });

    expect(serializeBenchmarkReport(first)).toBe(serializeBenchmarkReport(second));
    expect(first.summary.taskCount).toBe(2);
    expect(first.summary.memoryUsageRate).toBe(1);
    expect(first.summary.falseRecallCount).toBe(2);
    expect(first.summary.falseRecallCorrectionRate).toBe(1);
    expect(first.auditEvents.filter((event) => event.type === "memory.rejected")).toHaveLength(2);
    expect(renderBenchmarkMarkdown(first)).toContain("SOUL Memory Benchmark Report");
  });
});

function entry(
  memoryId: string,
  plane: "global-personal" | "project-local" | "shared-cloud-team",
  recommendedUsage: "blocking" | "advisory" | "historical"
) {
  return {
    memoryId,
    summary: "Memory " + memoryId,
    plane,
    recallReason: "Matched required memory " + memoryId,
    recommendedUsage,
    lifecycleState: "active" as const
  };
}
