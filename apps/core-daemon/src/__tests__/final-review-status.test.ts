import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALAYA_MEMORY_TOOL_NAMES } from "../mcp-memory-tool-catalog.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../..");

const expectedMemoryTools = [
  "soul.recall",
  "soul.open_pointer",
  "soul.emit_candidate_signal",
  "soul.propose_memory_update",
  "soul.review_memory_proposal",
  "soul.apply_override",
  "soul.explore_graph",
  "soul.report_context_usage"
] as const;

describe("P5 final-review status", () => {
  it("keeps the public MCP memory tool catalog exact", () => {
    expect(ALAYA_MEMORY_TOOL_NAMES).toEqual(expectedMemoryTools);
    expect(ALAYA_MEMORY_TOOL_NAMES.some((name) => name.startsWith("memory."))).toBe(false);
  });

  it("records four clear final-review perspectives", () => {
    for (const suffix of ["a", "b", "c", "d"]) {
      const reportPath = `docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-${suffix}.md`;
      expect(existsSync(resolveRepoPath(reportPath))).toBe(true);
      const report = readRepoFile(reportPath);
      expect(report).toContain("Status: CLEAR");
      expect(report).toContain("Blocking: 0");
      expect(report).toContain("Important: 0");
    }
  });

  it("keeps final-review and Gate-5 closeout claims aligned", () => {
    const finalReview = readRepoFile("docs/v0.1/phase-5-briefs/reports/task-p5-final-review.md");
    const gate5 = readRepoFile("docs/v0.1/phase-5-briefs/reports/gate-5-closeout.md");

    expect(finalReview).toContain("Blocking: 0");
    expect(finalReview).toContain("Important: 0");
    expect(finalReview).toContain("No legacy `memory.*` tools");
    for (const toolName of expectedMemoryTools) {
      expect(finalReview).toContain(`\`${toolName}\``);
    }
    expect(finalReview).toContain("#BL-024");

    expect(gate5).toContain("Status: Gate-5 passed");
    expect(gate5).toContain("Phase 6 / Gate-6 / v0.1.1");
    expect(gate5).not.toMatch(/Phase 5 benchmark/i);
  });

  it("marks Phase 5 closed without pulling benchmark work into Gate-5", () => {
    const index = readRepoFile("docs/v0.1/INDEX.md");
    const runtimeStatus = readRepoFile("docs/handbook/runtime-status.md");
    const backlog = readRepoFile("docs/handbook/backlog.md");

    expect(index).toContain("| Phase 5 | Wave 5: E2E + Graph Contract + Final Review");
    expect(index).toContain("Gate-5 passed");
    expect(index).toContain("| P5-final-review | mcp-consumable | [report]");
    expect(index).not.toContain("final review pending");

    expect(runtimeStatus).toContain("Gate-5 passed 2026-05-02");
    expect(runtimeStatus).toContain("Phase 6 / Gate-6 / v0.1.1");
    expect(runtimeStatus).toContain("#BL-024");
    expect(runtimeStatus).not.toContain("Remaining v0.1.0 release work is Phase 5");

    expect(backlog).toContain("### #BL-024");
    expect(backlog).toContain("startable after Gate-5");
  });
});

function readRepoFile(relativePath: string): string {
  return readFileSync(resolveRepoPath(relativePath), "utf8");
}

function resolveRepoPath(relativePath: string): string {
  return path.join(repositoryRoot, relativePath);
}
