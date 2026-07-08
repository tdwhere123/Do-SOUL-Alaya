import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { soulToolJsonSchemas } from "@do-soul/alaya-protocol";
import { ALAYA_MEMORY_TOOL_NAMES, listAlayaMemoryTools } from "../../mcp-memory/tool-catalog.js";

// Most cases lock historical closeout evidence across docs; the last
// case is a behavior assertion that exercises real code paths so the
// file is not pure docs prose.

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../../../..");

const expectedMemoryTools = [
  "soul.recall",
  "soul.open_pointer",
  "soul.emit_candidate_signal",
  "soul.propose_memory_update",
  "soul.review_memory_proposal",
  "soul.list_pending_proposals",
  "soul.propose_edge",
  "soul.list_pending_edge_proposals",
  "soul.batch_review_edge_proposals",
  "soul.apply_override",
  "soul.explore_graph",
  "soul.report_context_usage",
  "soul.resolve",
  "garden.list_pending_tasks",
  "garden.claim_task",
  "garden.complete_task"
] as const;

describe("P5 final-review status", () => {
  it("keeps the public MCP memory tool catalog exact", () => {
    expect(ALAYA_MEMORY_TOOL_NAMES).toEqual(expectedMemoryTools);
    expect(ALAYA_MEMORY_TOOL_NAMES.some((name) => name.startsWith("memory."))).toBe(false);
  });

  it("records four clear final-review perspectives", () => {
    for (const suffix of ["a", "b", "c", "d"]) {
      const reportPath = `docs/archive/v0.1-port-record/phase-5-briefs/reports/p5-final-review-perspective-${suffix}.md`;
      expect(existsSync(resolveRepoPath(reportPath))).toBe(true);
      const report = readRepoFile(reportPath);
      expect(report).toContain("Status: CLEAR");
      expect(report).toContain("Blocking: 0");
      expect(report).toContain("Important: 0");
    }
  });

  it("keeps final-review and Gate-5 closeout claims aligned", () => {
    const finalReview = readRepoFile("docs/archive/v0.1-port-record/phase-5-briefs/reports/task-p5-final-review.md");
    const gate5 = readRepoFile("docs/archive/v0.1-port-record/phase-5-briefs/reports/gate-5-closeout.md");

    expect(finalReview).toContain("Blocking: 0");
    expect(finalReview).toContain("Important: 0");
    expect(finalReview).toContain("No legacy `memory.*` tools");
    // P5 final-review docs were frozen at the eight v0.1.0-release tools
    // (the seven write/read surfaces plus soul.report_context_usage).
    // A1 (HITL daemon backbone) added soul.list_pending_proposals after
    // the report was sealed; the doc cite-loop here only checks the
    // pre-A1 set, so the existing evidence stays a stable lock.
    // The catalog-equality test above already pins the full A1 set.
    // invariant: this doc was sealed with the pre-A1 catalog; skip
    // tool names the catalog-equality assertion above already pins.
    const postSealAdditions = new Set([
      "soul.list_pending_proposals",
      "soul.propose_edge",
      "soul.list_pending_edge_proposals",
      "soul.batch_review_edge_proposals",
      "soul.resolve"
    ]);
    const preA1MemoryTools = expectedMemoryTools.filter(
      (toolName) => !postSealAdditions.has(toolName) && !toolName.startsWith("garden.")
    );
    for (const toolName of preA1MemoryTools) {
      expect(finalReview).toContain(`\`${toolName}\``);
    }
    expect(finalReview).toContain("#BL-024");

    expect(gate5).toContain("Status: Gate-5 passed");
    expect(gate5).toContain("Phase 6 / Gate-6 / v0.1.1");
    expect(gate5).not.toMatch(/Phase 5 benchmark/i);
  });

  it("marks Phase 5 closed without pulling benchmark work into Gate-5", () => {
    const index = readRepoFile("docs/archive/v0.1-port-record/INDEX.md");
    const runtimeStatus = readRepoFile(
      "docs/archive/handbook-historical/runtime-status.md",
    );
    const backlog = readRepoFile("docs/handbook/backlog.md");
    const resolvedBacklog = readRepoFile("docs/archive/backlog-resolved-historical.md");

    expect(index).toContain("| Phase 5 | Wave 5: E2E + Graph Contract + Final Review");
    expect(index).toContain("Gate-5 passed");
    expect(index).toContain("| P5-final-review | mcp-consumable | [report]");
    expect(index).not.toContain("final review pending");

    expect(runtimeStatus).toContain("Gate-5 passed 2026-05-02");
    expect(runtimeStatus).toContain("Phase 6 / Gate-6 / v0.1.1");
    expect(runtimeStatus).toContain("#BL-024");
    expect(runtimeStatus).not.toContain("Remaining v0.1.0 release work is Phase 5");

    // #BL-024 / #BL-017 stay resolved in the resolved-issue archive; the
    // handbook backlog keeps only currently open and permanently rejected items.
    expect(backlog).toContain("Resolved issues");
    expect(backlog).toContain("`docs/archive/backlog-resolved-historical.md`");
    expect(resolvedBacklog).toContain("**#BL-024** — HTTP `POST /proposals/:id/review` route removed");
    expect(resolvedBacklog).toContain("**#BL-017** — Post-port hygiene wave executed");
  });

  // Behavior assertion, not docs-to-docs evidence. The MCP catalog must
  // publish exactly the tool names the rest of the report claims, with
  // input schemas derived from zod so oversized attacker-controlled
  // payloads are rejected at parse time.
  it("publishes the named tools through the zod-derived catalog", () => {
    const definitions = listAlayaMemoryTools();
    expect(definitions.map((definition) => definition.name)).toEqual([...expectedMemoryTools]);
    for (const definition of definitions) {
      expect(soulToolJsonSchemas[definition.name]).toBe(definition.inputSchema);
      expect((definition.inputSchema as { type?: string }).type).toBe("object");
    }
  });
});

function readRepoFile(relativePath: string): string {
  return readFileSync(resolveRepoPath(relativePath), "utf8");
}

function resolveRepoPath(relativePath: string): string {
  return path.join(repositoryRoot, relativePath);
}
